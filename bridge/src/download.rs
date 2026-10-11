use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;
use windows::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};

use crate::{
    api::{Shared, VideoInfo},
    cookies::{BrowserCookie, CookieJar},
    platform,
    tools::Tools,
};

pub(crate) fn command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .creation_flags((CREATE_NO_WINDOW | CREATE_SUSPENDED).0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

pub(crate) fn yt_dlp(tools: &Tools, cookies: Option<&CookieJar>) -> Command {
    let mut command = command(&tools.directory.join("yt-dlp.exe"));
    command
        .args([
            "--ignore-config",
            "--no-plugin-dirs",
            "--no-playlist",
            "--no-warnings",
            "--no-colors",
            "--socket-timeout",
            "20",
            "--retries",
            "2",
            "--fragment-retries",
            "2",
            "--abort-on-unavailable-fragments",
            "--no-check-formats",
            "--no-js-runtimes",
            "--js-runtimes",
        ])
        .arg(format!(
            "deno:{}",
            tools.directory.join("deno.exe").display()
        ))
        .arg("--ffmpeg-location")
        .arg(&tools.directory);
    if let Some(cookies) = cookies {
        command.arg("--cookies").arg(cookies.path());
    }
    command
}

fn metadata(
    tools: &Tools,
    url: &str,
    cancel: &AtomicBool,
    cookies: Option<&CookieJar>,
) -> Result<Value> {
    let mut command = yt_dlp(tools, cookies);
    command.args(["--dump-single-json", "--skip-download", "--", url]);
    let mut output = String::new();
    process(&mut command, cancel, Duration::from_secs(180), |line| {
        if line.starts_with('{') && line.len() <= 16 * 1024 * 1024 {
            output = line.to_owned();
        }
    })?;
    let value: Value =
        serde_json::from_str(&output).context("yt-dlp не вернул информацию о видео")?;
    ensure!(
        value["is_live"] != true
            && value["live_status"] != "is_live"
            && value["live_status"] != "is_upcoming",
        "Прямые эфиры пока не поддерживаются. Дождитесь готовой записи."
    );
    ensure!(
        value["has_drm"] != true,
        "DRM-защищённое видео не поддерживается."
    );
    let duration = number(&value, "duration");
    ensure!(
        duration > 0.0 && duration.is_finite(),
        "У видео пока нет доступной длительности."
    );
    Ok(value)
}

fn video_info(value: &Value, url: &str) -> Result<VideoInfo> {
    Ok(VideoInfo {
        id: value["id"].as_str().context("Missing video ID")?.into(),
        url: url.into(),
        title: value["title"].as_str().unwrap_or("YouTube").into(),
        duration: number(value, "duration"),
        thumbnail: value["thumbnail"].as_str().map(str::to_owned),
        channel: value["channel"].as_str().map(str::to_owned),
    })
}

pub fn info(tools: &Tools, url: &str, home: &Path, cookies: &[BrowserCookie]) -> Result<VideoInfo> {
    let jar = CookieJar::new(home, cookies)?;
    video_info(
        &metadata(tools, url, &AtomicBool::new(false), jar.as_ref())?,
        url,
    )
}

fn number(value: &Value, field: &str) -> f64 {
    value[field].as_f64().unwrap_or(0.0)
}

fn select_formats(value: &Value, audio_only: bool) -> Result<Vec<&Value>> {
    let formats = value["formats"]
        .as_array()
        .context("Видео не содержит доступных форматов")?;
    let usable = |format: &&Value| {
        format["has_drm"] != true
            && format["url"].as_str().is_some()
            && format["format_id"].as_str().is_some()
    };
    let audio = formats
        .iter()
        .filter(usable)
        .filter(|format| {
            format["acodec"]
                .as_str()
                .is_some_and(|codec| codec != "none")
        })
        .max_by(|left, right| {
            let score = |format: &Value| {
                (
                    format["vcodec"] == "none",
                    number(format, "abr"),
                    number(format, "tbr"),
                )
            };
            score(left)
                .partial_cmp(&score(right))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .context("Нет доступной аудиодорожки")?;
    if audio_only {
        return Ok(vec![audio]);
    }
    let video = formats
        .iter()
        .filter(usable)
        .filter(|format| {
            format["vcodec"]
                .as_str()
                .is_some_and(|codec| codec != "none")
        })
        .max_by(|left, right| {
            let score = |format: &Value| {
                (
                    number(format, "width") * number(format, "height"),
                    number(format, "tbr"),
                )
            };
            score(left)
                .partial_cmp(&score(right))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .context("Нет доступной видеодорожки")?;
    if video["format_id"] == audio["format_id"] {
        Ok(vec![video])
    } else {
        Ok(vec![video, audio])
    }
}

pub fn download(
    tools: &Tools,
    state: &Shared,
    home: &Path,
    desktop: &Path,
    id: &str,
    cancel: &AtomicBool,
    cookies: &[BrowserCookie],
) -> Result<String> {
    let job = state
        .lock()
        .unwrap()
        .jobs
        .iter()
        .find(|job| job.id == id)
        .context("Job missing")?
        .clone();
    update(state, id, "preparing", 0.0);
    let jar = CookieJar::new(home, cookies)?;
    let metadata = metadata(tools, &job.url, cancel, jar.as_ref())?;
    let duration = number(&metadata, "duration");
    let end = job.end.unwrap_or(duration);
    ensure!(
        job.start < end && end <= duration,
        "Длительность видео изменилась. Обновите информацию и выберите фрагмент снова."
    );
    let formats = select_formats(&metadata, job.format == "mp3")?;
    let temporary = home.join("temp").join(id);
    fs::create_dir_all(&temporary)?;
    let result = (|| -> Result<String> {
        let output = temporary.join(format!("finished.{}", job.format));
        let trimmed = job.start > 0.0 || end < duration;
        if trimmed {
            update(state, id, "downloading", 0.0);
            let mut ffmpeg = command(&tools.directory.join("ffmpeg.exe"));
            ffmpeg.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-n"]);
            for format in &formats {
                let input = format["url"].as_str().context("Missing media URL")?;
                let parsed = url::Url::parse(input)?;
                ensure!(
                    parsed.scheme() == "https"
                        && parsed
                            .host_str()
                            .is_some_and(|host| host.ends_with(".googlevideo.com")
                                || host.ends_with(".youtube.com")),
                    "Unexpected YouTube media host"
                );
                ffmpeg.args([
                    "-rw_timeout",
                    "30000000",
                    "-ss",
                    &job.start.to_string(),
                    "-t",
                    &(end - job.start).to_string(),
                ]);
                if let Some(headers) = format["http_headers"].as_object() {
                    if let Some(agent) = headers.get("User-Agent").and_then(Value::as_str) {
                        ffmpeg.arg("-user_agent").arg(agent);
                    }
                    if let Some(referer) = headers.get("Referer").and_then(Value::as_str) {
                        ffmpeg.arg("-referer").arg(referer);
                    }
                }
                ffmpeg.arg("-i").arg(input);
            }
            if job.format == "mp4" {
                ffmpeg.args([
                    "-map",
                    "0:v:0",
                    "-map",
                    if formats.len() > 1 { "1:a:0" } else { "0:a:0" },
                    "-c:v",
                    "libx264",
                    "-preset",
                    "medium",
                    "-crf",
                    "18",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "320k",
                    "-movflags",
                    "+faststart",
                ]);
            } else {
                ffmpeg.args(["-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-q:a", "0"]);
            }
            ffmpeg
                .args([
                    "-t",
                    &(end - job.start).to_string(),
                    "-progress",
                    "pipe:1",
                    "-nostats",
                ])
                .arg(&output);
            process(
                &mut ffmpeg,
                cancel,
                Duration::from_secs(24 * 3600),
                |line| ffmpeg_progress(state, id, line, end - job.start, 0.0, 0.97),
            )?;
        } else {
            update(state, id, "downloading", 0.0);
            let selection = formats
                .iter()
                .map(|format| format["format_id"].as_str().unwrap())
                .collect::<Vec<_>>()
                .join("+");
            let mut command = yt_dlp(tools, jar.as_ref());
            command
                .args([
                    "--format",
                    &selection,
                    "--audio-multistreams",
                    "--merge-output-format",
                    "mkv",
                    "--newline",
                    "--progress",
                    "--progress-delta",
                    "0.25",
                    "--progress-template",
                    "download:SC_PROGRESS:%(progress._percent_str)s",
                    "--print",
                    "after_move:SC_FILE:%(filepath)j",
                    "--no-simulate",
                    "--no-overwrites",
                    "--output",
                ])
                .arg(temporary.join("source.%(ext)s"))
                .args(["--", &job.url]);
            let mut source = None;
            process(
                &mut command,
                cancel,
                Duration::from_secs(24 * 3600),
                |line| {
                    if let Some(percent) = line
                        .strip_prefix("SC_PROGRESS:")
                        .and_then(|value| value.trim().trim_end_matches('%').parse::<f64>().ok())
                    {
                        update(
                            state,
                            id,
                            "downloading",
                            (percent / 100.0).clamp(0.0, 1.0) * 0.85,
                        );
                    }
                    if let Some(value) = line.strip_prefix("SC_FILE:") {
                        source = serde_json::from_str::<String>(value)
                            .ok()
                            .map(PathBuf::from);
                    }
                },
            )?;
            let source = source.context("yt-dlp не сообщил имя загруженного файла")?;
            ensure!(
                fs::canonicalize(&source)?.starts_with(fs::canonicalize(&temporary)?),
                "Unexpected download path"
            );
            update(state, id, "processing", 0.85);
            let mut ffmpeg = command_for_conversion(tools, &source, &output, &job.format, &formats);
            process(
                &mut ffmpeg,
                cancel,
                Duration::from_secs(24 * 3600),
                |line| ffmpeg_progress(state, id, line, duration, 0.85, 0.12),
            )?;
        }
        ensure!(!cancel.load(Ordering::Relaxed), "Canceled");
        update(state, id, "processing", 0.98);
        verify_output(
            tools,
            &output,
            &job.format,
            end - job.start,
            formats[0],
            trimmed,
            cancel,
        )?;
        let title = metadata["title"].as_str().unwrap_or("YouTube");
        let name = safe_filename(title);
        let suffix = if trimmed {
            format!(" [{}-{}]", job.start, end)
        } else {
            String::new()
        };
        let filename = format!("{name}{suffix}.{}", job.format);
        publish_files(vec![(output, filename)], state, desktop, id, cancel)?
            .into_iter()
            .next()
            .context("Output filename missing")
    })();
    let _ = fs::remove_dir_all(&temporary);
    result
}

fn command_for_conversion(
    tools: &Tools,
    source: &Path,
    output: &Path,
    format: &str,
    formats: &[&Value],
) -> Command {
    let mut command = command(&tools.directory.join("ffmpeg.exe"));
    command
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i"])
        .arg(source);
    if format == "mp3" {
        command.args(["-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-q:a", "0"]);
    } else {
        let video = formats[0];
        let audio_index = if formats.len() > 1
            && video["acodec"]
                .as_str()
                .is_some_and(|codec| codec != "none")
        {
            "0:a:1"
        } else {
            "0:a:0"
        };
        command.args(["-map", "0:v:0", "-map", audio_index, "-c:v"]);
        let codec = video["vcodec"].as_str().unwrap_or("");
        if ["avc", "h264", "av01", "av1", "vp9", "vp09", "hev", "hvc"]
            .iter()
            .any(|prefix| codec.starts_with(prefix))
        {
            command.arg("copy");
        } else {
            command.args(["libx264", "-preset", "medium", "-crf", "18"]);
        }
        let audio_codec = formats
            .last()
            .and_then(|format| format["acodec"].as_str())
            .unwrap_or("");
        if audio_codec.starts_with("mp4a") || audio_codec == "aac" {
            command.args(["-c:a", "copy"]);
        } else {
            command.args(["-c:a", "aac", "-b:a", "320k"]);
        }
        command.args(["-movflags", "+faststart"]);
    }
    command
        .args(["-progress", "pipe:1", "-nostats"])
        .arg(output);
    command
}

fn verify_output(
    tools: &Tools,
    output: &Path,
    format: &str,
    expected: f64,
    selected: &Value,
    trimmed: bool,
    cancel: &AtomicBool,
) -> Result<()> {
    let mut command = command(&tools.directory.join("ffprobe.exe"));
    command
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,width,height",
            "-of",
            "json",
        ])
        .arg(output);
    let mut text = String::new();
    process(&mut command, cancel, Duration::from_secs(60), |line| {
        text.push_str(line);
    })?;
    let info: Value = serde_json::from_str(&text)?;
    let duration = info["format"]["duration"]
        .as_str()
        .and_then(|value| value.parse::<f64>().ok())
        .context("Готовый файл не содержит длительности")?;
    ensure!(
        (duration - expected).abs()
            <= if trimmed {
                0.15
            } else {
                1.0_f64.max(expected * 0.005)
            },
        "Готовый файл имеет неверную длительность ({duration:.2} вместо {expected:.2} с)"
    );
    let streams = info["streams"]
        .as_array()
        .context("Готовый файл не содержит дорожек")?;
    ensure!(
        streams.iter().any(|stream| stream["codec_type"] == "audio"),
        "В готовом файле отсутствует аудио"
    );
    ensure!(
        format != "mp4" || streams.iter().any(|stream| stream["codec_type"] == "video"),
        "В готовом файле отсутствует видео"
    );
    if format == "mp4" {
        let expected_area = number(selected, "width") * number(selected, "height");
        let actual_area = streams
            .iter()
            .find(|stream| stream["codec_type"] == "video")
            .map(|stream| number(stream, "width") * number(stream, "height"))
            .unwrap_or(0.0);
        ensure!(
            expected_area == 0.0 || actual_area == expected_area,
            "Разрешение готового видео не совпадает с выбранным максимальным качеством"
        );
    }
    Ok(())
}

fn safe_filename(title: &str) -> String {
    let name: String = title
        .chars()
        .map(|ch| {
            if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .take(100)
        .collect();
    let name = name.trim().trim_end_matches('.');
    if name.is_empty() {
        "YouTube".into()
    } else {
        format!("{name} [YouTube]")
    }
}

pub(crate) fn update(state: &Shared, id: &str, status: &str, progress: f64) {
    if let Some(job) = state
        .lock()
        .unwrap()
        .jobs
        .iter_mut()
        .find(|job| job.id == id)
        && job.status != "canceled"
    {
        job.status = status.into();
        job.progress = progress;
    }
}

fn ffmpeg_progress(state: &Shared, id: &str, line: &str, duration: f64, base: f64, scale: f64) {
    if let Some(micros) = line
        .strip_prefix("out_time_us=")
        .and_then(|value| value.parse::<f64>().ok())
    {
        update(
            state,
            id,
            "processing",
            base + (micros / 1_000_000.0 / duration).clamp(0.0, 1.0) * scale,
        );
    }
}

pub(crate) fn process(
    command: &mut Command,
    cancel: &AtomicBool,
    timeout: Duration,
    mut on_line: impl FnMut(&str),
) -> Result<()> {
    let mut child = command
        .spawn()
        .context("Не удалось запустить инструмент загрузки")?;
    let containment = match platform::Job::new(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    if let Err(error) = platform::resume_child(&child) {
        let _ = containment.terminate();
        let _ = child.wait();
        return Err(error);
    }
    let (sender, receiver) = mpsc::channel();
    let stdout = child.stdout.take().context("Missing stdout")?;
    let stderr = child.stderr.take().context("Missing stderr")?;
    let out_sender = sender.clone();
    let out_thread = thread::spawn(move || {
        for line in BufReader::new(stdout).split(b'\n').map_while(Result::ok) {
            if out_sender
                .send((false, String::from_utf8_lossy(&line).into_owned()))
                .is_err()
            {
                break;
            }
        }
    });
    let err_thread = thread::spawn(move || {
        for line in BufReader::new(stderr).split(b'\n').map_while(Result::ok) {
            if sender
                .send((true, String::from_utf8_lossy(&line).into_owned()))
                .is_err()
            {
                break;
            }
        }
    });
    let started = Instant::now();
    let mut last_error = String::new();
    let status = loop {
        if cancel.load(Ordering::Relaxed) || started.elapsed() > timeout {
            let _ = containment.terminate();
            let _ = child.wait();
            drop(receiver);
            let _ = out_thread.join();
            let _ = err_thread.join();
            bail!(if cancel.load(Ordering::Relaxed) {
                "Загрузка отменена"
            } else {
                "Инструмент не ответил вовремя. Попробуйте снова."
            });
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok((true, line)) => {
                if !line.trim().is_empty() {
                    last_error = line;
                }
            }
            Ok((false, line)) => on_line(&line),
            Err(mpsc::RecvTimeoutError::Disconnected) => break child.wait()?,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    };
    let _ = out_thread.join();
    let _ = err_thread.join();
    ensure!(status.success(), "{}", friendly_error(&last_error));
    Ok(())
}

fn friendly_error(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("not a bot") {
        return "The source requested a bot check. Open the media in Edge and retry; if it persists, try later or check your network/VPN.".into();
    }
    if lower.contains("sign in")
        || lower.contains("login")
        || lower.contains("cookies")
        || lower.contains("age-restricted")
        || lower.contains("confirm your age")
    {
        return "The source requires sign-in or age verification. Complete it in Edge, open the media and retry.".into();
    }
    if lower.contains("403") || lower.contains("forbidden") {
        return "The source rejected the media link (403). Open the media in its player and retry; check your network/VPN.".into();
    }
    if lower.contains("unavailable") || lower.contains("private") || lower.contains("removed") {
        return "Видео недоступно: оно скрыто, удалено или ограничено в вашем регионе.".into();
    }
    if lower.contains("timed out") || lower.contains("resolve") || lower.contains("connection") {
        return "Could not connect to the source. Check your internet connection and VPN, then retry."
            .into();
    }
    let safe = error
        .split_whitespace()
        .map(|word| {
            if word.contains("://") {
                "[медиассылка]"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    if safe.is_empty() {
        "Инструмент загрузки завершился с ошибкой. Повторите попытку.".into()
    } else {
        safe.chars().take(600).collect()
    }
}

pub(crate) fn publish_files(
    outputs: Vec<(PathBuf, String)>,
    state: &Shared,
    desktop: &Path,
    id: &str,
    cancel: &AtomicBool,
) -> Result<Vec<String>> {
    let staging = desktop
        .parent()
        .context("Desktop has no parent.")?
        .join(format!(".qcatch-{id}.partial"));
    fs::create_dir(&staging)?;
    let result = (|| {
        // Stage every completed file beside Desktop before committing any final name.
        for (index, (source, _)) in outputs.iter().enumerate() {
            ensure!(!cancel.load(Ordering::Relaxed), "Download canceled.");
            let staged = staging.join(index.to_string());
            match platform::move_new_file(source, &staged) {
                Ok(()) => continue,
                Err(error) if error.raw_os_error() == Some(17) => (),
                Err(error) => return Err(error).context("Could not stage the completed media."),
            }
            let mut input = fs::File::open(source)?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(staged)?;
            let mut buffer = [0; 128 * 1024];
            loop {
                ensure!(!cancel.load(Ordering::Relaxed), "Download canceled.");
                let count = input.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                output.write_all(&buffer[..count])?;
            }
            output.sync_all()?;
        }
        let mut data = state.lock().unwrap();
        let job = data
            .jobs
            .iter_mut()
            .find(|job| job.id == id)
            .context("Job missing")?;
        ensure!(
            !cancel.load(Ordering::Relaxed) && job.status != "canceled",
            "Download canceled."
        );
        let mut filenames = Vec::new();
        for (index, (_, name)) in outputs.iter().enumerate() {
            let file = Path::new(name);
            let stem = file
                .file_stem()
                .and_then(|value| value.to_str())
                .context("Invalid filename")?;
            let extension = file
                .extension()
                .and_then(|value| value.to_str())
                .context("Invalid extension")?;
            let mut saved = None;
            for suffix in 0..10000 {
                let filename = if suffix == 0 {
                    name.clone()
                } else {
                    format!("{stem} ({suffix}).{extension}")
                };
                let destination = desktop.join(&filename);
                match platform::move_new_file(&staging.join(index.to_string()), &destination) {
                    Ok(()) => {
                        saved = Some(filename);
                        break;
                    }
                    Err(_) if destination.exists() => continue,
                    Err(error) => {
                        return Err(error)
                            .context("Could not save the completed media to Desktop.");
                    }
                }
            }
            filenames.push(saved.context("Could not choose a free filename.")?);
            job.filenames = filenames.clone();
            job.filename = filenames.first().cloned();
        }
        job.status = "completed".into();
        job.progress = 1.0;
        Ok(filenames)
    })();
    let _ = fs::remove_dir_all(staging);
    result
}
