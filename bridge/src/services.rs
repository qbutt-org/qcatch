use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    api::Shared,
    cookies::{BrowserCookie, CookieJar},
    download::{command, process, publish_files, update, yt_dlp},
    tools::Tools,
};

pub struct Reference {
    pub url: String,
    request_url: String,
    pub service: &'static str,
    pub live: bool,
    pub domains: &'static [&'static str],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub url: String,
    pub cookies: Vec<BrowserCookie>,
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}

fn digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

// The helper independently validates the browser's exact post/track reference.
pub fn reference(value: &str) -> Result<Reference> {
    ensure!(value.len() <= 2048, "Source URL is too long.");
    let mut url = url::Url::parse(value)?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none(),
        "Invalid source URL."
    );
    let original_host = url.host_str().context("Missing source domain.")?;
    let host = ["www.", "m.", "old.", "new."]
        .iter()
        .find_map(|prefix| original_host.strip_prefix(prefix))
        .unwrap_or(original_host);
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    let (service, live, domains): (_, _, &'static [&'static str]) = match host {
        "tiktok.com"
            if matches!(parts.as_slice(), [user, "video", id] if user.starts_with('@') && digits(id))
                || matches!(parts.as_slice(), ["share", "video", id] | ["embed", id] if digits(id))
                || matches!(parts.as_slice(), ["v", id] if digits(id.trim_end_matches(".html")))
                || matches!(parts.as_slice(), ["t", id] if identifier(id)) =>
        {
            ("TikTok", false, &["tiktok.com"])
        }
        "vm.tiktok.com" | "vt.tiktok.com" if matches!(parts.as_slice(), [id] if identifier(id)) => {
            ("TikTok", false, &["tiktok.com"])
        }
        "reddit.com" | "redditmedia.com"
            if matches!(parts.as_slice(), ["comments", id, ..] if identifier(id))
                || matches!(parts.as_slice(), ["r" | "user", _, "comments", id, ..] if identifier(id))
                || matches!(parts.as_slice(), ["r", _, "s", id] if identifier(id)) =>
        {
            ("Reddit", false, &["reddit.com", "redditmedia.com"])
        }
        "v.redd.it" if matches!(parts.as_slice(), [id] if identifier(id)) => {
            ("Reddit", false, &["reddit.com", "redditmedia.com"])
        }
        "clips.twitch.tv" if matches!(parts.as_slice(), [id] if identifier(id) && *id != "embed") => {
            ("Twitch", false, &["twitch.tv"])
        }
        "twitch.tv" | "go.twitch.tv" if matches!(parts.as_slice(), [_, "clip", id] | ["clip", id] if identifier(id)) => {
            ("Twitch", false, &["twitch.tv"])
        }
        "twitch.tv" | "go.twitch.tv"
            if matches!(parts.as_slice(), [id] if identifier(id)
            && !["directory", "downloads", "settings", "videos", "subscriptions"].contains(id)) =>
        {
            ("Twitch", true, &["twitch.tv"])
        }
        "soundcloud.com"
            if matches!(parts.as_slice(), [_, track] if !track.is_empty()
                && !["sets", "tracks", "likes", "reposts", "albums", "popular-tracks"].contains(track))
                || matches!(parts.as_slice(), [_, track, secret] if !track.is_empty() && secret.starts_with("s-")) =>
        {
            ("SoundCloud", false, &["soundcloud.com"])
        }
        "music.yandex.ru" | "music.yandex.com" | "music.yandex.kz" | "music.yandex.by"
        | "music.yandex.ua"
            if matches!(parts.as_slice(), ["album", album, "track", track] if digits(album) && digits(track)) =>
        {
            (
                "Yandex Music",
                false,
                &[
                    "yandex.ru",
                    "yandex.com",
                    "yandex.kz",
                    "yandex.by",
                    "yandex.ua",
                ],
            )
        }
        _ => bail!("Open one supported post, clip or track and retry."),
    };
    let request_url = url.to_string();
    let public_path = (service == "SoundCloud" && parts.len() == 3)
        .then(|| format!("/{}/{}", parts[0], parts[1]));
    url.set_fragment(None);
    url.set_query(None);
    if let Some(path) = public_path {
        url.set_path(&path);
    }
    Ok(Reference {
        url: url.into(),
        request_url,
        service,
        live,
        domains,
    })
}

pub fn watch(home: &Path, input: &str, cookies: Vec<BrowserCookie>) -> Result<()> {
    let reference = reference(input)?;
    ensure!(
        reference.service == "Twitch" && reference.live,
        "Open a Twitch live channel to watch it in qplay."
    );
    CookieJar::validate_scope(&cookies, reference.domains)?;
    crate::playback::launch(home, reference.url, None, cookies)
}

fn metadata(
    tools: &Tools,
    reference: &Reference,
    jar: Option<&CookieJar>,
    cancel: &AtomicBool,
) -> Result<Value> {
    let mut command = yt_dlp(tools, jar);
    command.args([
        "--dump-single-json",
        "--skip-download",
        "--",
        &reference.request_url,
    ]);
    let mut text = String::new();
    process(&mut command, cancel, Duration::from_secs(180), |line| {
        if line.starts_with('{') && line.len() <= 16 * 1024 * 1024 {
            text = line.to_owned();
        }
    })?;
    serde_json::from_str(&text)
        .context("The source returned no media. Open and play the post on its site, then retry.")
}

fn number(value: &Value, key: &str) -> f64 {
    value[key].as_f64().unwrap_or(0.0)
}

fn video_score(format: &Value) -> (f64, f64, f64) {
    let height = number(format, "height");
    let width = number(format, "width");
    let area = if width > 0.0 {
        width * height
    } else {
        height * height * number(format, "aspect_ratio")
    };
    (area, height, number(format, "tbr"))
}

fn prepare_formats(value: &mut Value, service: &str) -> Result<()> {
    if service == "Reddit"
        && value["formats"]
            .as_array()
            .is_some_and(|formats| formats.len() == 1 && formats[0]["format_id"] == "fallback")
    {
        bail!(
            "The source returned only a fallback video without its other tracks. Open and play the post, then retry."
        );
    }
    if service != "TikTok" {
        return Ok(());
    }
    let Some(formats) = value["formats"].as_array_mut() else {
        return Ok(());
    };
    // TikTok's standalone `audio` is music.playUrl, not necessarily the post's sound.
    formats.retain(|format| format["format_id"] != "audio");
    let muxed = formats
        .iter()
        .filter(|format| format["vcodec"] != "none" && format["acodec"] == "aac")
        .filter(|format| format["vcodec"] != "bytevc2")
        .max_by(|left, right| {
            video_score(left)
                .partial_cmp(&video_score(right))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .cloned();
    if formats.iter().any(|format| format["acodec"] == "none") {
        let mut audio = muxed.context(
            "The source did not return the post's audio. Open and play the post, then retry.",
        )?;
        // yt-dlp's merger maps this input's audio without adding its second video track.
        audio["format_id"] = "qcatch-post-audio".into();
        audio["vcodec"] = "none".into();
        audio["width"] = Value::Null;
        audio["height"] = Value::Null;
        formats.push(audio);
    }
    Ok(())
}

fn selected_formats(value: &Value) -> Result<Vec<&Value>> {
    ensure!(
        value["has_drm"] != true,
        "DRM-protected media cannot be downloaded."
    );
    ensure!(
        value["is_live"] != true
            && value["live_status"] != "is_live"
            && value["live_status"] != "is_upcoming",
        "Use Watch for a Twitch live stream. Download is available for clips."
    );
    let duration = number(value, "duration");
    ensure!(
        duration.is_finite() && duration > 0.0,
        "The source did not return the full media duration."
    );
    let formats: Vec<_> = value["formats"]
        .as_array()
        .map(|formats| formats.iter().collect())
        .unwrap_or_else(|| vec![value]);
    let usable = |format: &&Value| {
        format["has_drm"] != true
            && format["vcodec"] != "bytevc2"
            && format["url"].as_str().is_some()
            && !["format_id", "format_note"].iter().any(|key| {
                format[*key].as_str().is_some_and(|text| {
                    let text = text.to_ascii_lowercase();
                    text.contains("preview") || text.contains("unplayable")
                })
            })
    };
    let video = formats
        .iter()
        .copied()
        .filter(usable)
        .filter(|format| {
            format["vcodec"]
                .as_str()
                .is_some_and(|codec| codec != "none")
                || (format["vcodec"].is_null()
                    && (number(format, "height") > 0.0 || number(format, "width") > 0.0))
        })
        .max_by(|left, right| {
            video_score(left)
                .partial_cmp(&video_score(right))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    let audio = formats
        .iter()
        .copied()
        .filter(usable)
        .filter(|format| {
            format["acodec"]
                .as_str()
                .is_some_and(|codec| codec != "none")
                || (format["vcodec"] == "none" && format["format_id"] == "download")
        })
        .max_by(|left, right| {
            let score = |format: &Value| {
                (
                    format["vcodec"] == "none",
                    format["format_id"] == "download",
                    number(format, "abr"),
                    number(format, "tbr"),
                )
            };
            score(left)
                .partial_cmp(&score(right))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    match (video, audio) {
        (Some(video), Some(audio))
            if video["format_id"] != audio["format_id"] && video["acodec"] == "none" =>
        {
            Ok(vec![video, audio])
        }
        (Some(video), _) => Ok(vec![video]),
        (None, Some(audio)) => Ok(vec![audio]),
        (None, None) if usable(&value) && value["formats"].is_null() => Ok(vec![value]),
        _ => bail!(
            "No full media format is available. Sign in to the source and retry; previews cannot be saved as full tracks."
        ),
    }
}

fn verify(
    tools: &Tools,
    output: &Path,
    value: &Value,
    selected: &[&Value],
    cancel: &AtomicBool,
) -> Result<()> {
    ensure!(
        fs::metadata(output)?.len() > 0,
        "The downloaded file is empty."
    );
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
        text.push_str(line)
    })?;
    let probe: Value = serde_json::from_str(&text)?;
    let actual = probe["format"]["duration"]
        .as_str()
        .and_then(|value| value.parse::<f64>().ok())
        .context("The downloaded file has no duration.")?;
    let expected = number(value, "duration");
    ensure!(
        (actual - expected).abs() <= 1.0_f64.max(expected * 0.005),
        "The file is incomplete or contains a preview ({actual:.2} of {expected:.2} seconds). Open the full media in the source player and retry."
    );
    let streams = probe["streams"]
        .as_array()
        .context("The file has no media tracks.")?;
    let video = streams
        .iter()
        .find(|stream| stream["codec_type"] == "video");
    let expected_width = number(selected[0], "width");
    let expected_height = number(selected[0], "height");
    let expects_video = selected[0]["vcodec"]
        .as_str()
        .is_some_and(|codec| codec != "none")
        || expected_width > 0.0
        || expected_height > 0.0;
    ensure!(
        !expects_video || video.is_some(),
        "The downloaded video track is missing."
    );
    ensure!(
        video.is_none_or(|video| {
            (expected_width == 0.0 || number(video, "width") == expected_width)
                && (expected_height == 0.0 || number(video, "height") == expected_height)
        }),
        "The downloaded video does not match the selected maximum resolution."
    );
    let expects_audio = selected.iter().any(|format| {
        format["acodec"]
            .as_str()
            .is_some_and(|codec| codec != "none")
    }) || video.is_none();
    ensure!(
        !expects_audio || streams.iter().any(|stream| stream["codec_type"] == "audio"),
        "The downloaded audio track is missing."
    );
    let subtitles = value["subtitles"]
        .as_object()
        .map(|languages| {
            languages
                .values()
                .filter(|formats| {
                    formats
                        .as_array()
                        .is_some_and(|formats| !formats.is_empty())
                })
                .count()
        })
        .unwrap_or(0);
    ensure!(
        streams
            .iter()
            .filter(|stream| stream["codec_type"] == "subtitle")
            .count()
            >= subtitles,
        "The downloaded subtitle tracks are missing."
    );
    Ok(())
}

fn filename(title: &str, service: &str, index: usize, count: usize, extension: &str) -> String {
    let title: String = title
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
    let title = title.trim().trim_end_matches('.');
    let title = if title.is_empty() { service } else { title };
    let position = if count > 1 {
        format!(" ({})", index + 1)
    } else {
        String::new()
    };
    format!("{title}{position} [{service}].{extension}")
}

pub fn download(
    tools: &Tools,
    state: &Shared,
    home: &Path,
    desktop: &Path,
    id: &str,
    cancel: &AtomicBool,
    input: &Request,
) -> Result<Vec<String>> {
    let job = state
        .lock()
        .unwrap()
        .jobs
        .iter()
        .find(|job| job.id == id)
        .context("Job missing")?
        .clone();
    let reference = reference(&input.url)?;
    ensure!(
        reference.url == job.url,
        "The selected source changed. Add the download again."
    );
    ensure!(
        !reference.live,
        "Use Watch for a Twitch live stream. Download is available for clips."
    );
    update(state, id, "preparing", 0.0);
    let jar = CookieJar::scoped(home, &input.cookies, reference.domains)?;
    let mut value = metadata(tools, &reference, jar.as_ref(), cancel)?;
    if let Some(entries) = value["entries"].as_array_mut() {
        for entry in entries {
            prepare_formats(entry, reference.service)?;
        }
    } else {
        prepare_formats(&mut value, reference.service)?;
    }
    let entries: Vec<_> = value["entries"]
        .as_array()
        .map(|entries| entries.iter().collect())
        .unwrap_or_else(|| vec![&value]);
    ensure!(
        !entries.is_empty() && entries.len() <= 32,
        "Open a single post with at most 32 media items."
    );
    let temporary = home.join("temp").join(id);
    fs::create_dir_all(&temporary)?;

    let mut outputs = Vec::new();
    for (index, value) in entries.iter().enumerate() {
        ensure!(!cancel.load(Ordering::Relaxed), "Download canceled.");
        let formats = selected_formats(value)?;
        let info = temporary.join(format!("{index}.info.json"));
        fs::write(&info, serde_json::to_vec(value)?)?;
        let mut command = yt_dlp(tools, jar.as_ref());
        command
            .args([
                "--newline",
                "--progress-template",
                "download:QC_PROGRESS:%(progress._percent_str)s",
                "--print",
                "after_move:QC_FILE:%(filepath)j",
                "--merge-output-format",
                "mkv",
                "--load-info-json",
            ])
            .arg(&info)
            .arg("--output")
            .arg(temporary.join(format!("{index}.%(ext)s")));
        if value["subtitles"]
            .as_object()
            .is_some_and(|subtitles| !subtitles.is_empty())
        {
            command.args([
                "--write-subs",
                "--sub-langs",
                "all",
                "--embed-subs",
                "--remux-video",
                "mkv",
            ]);
        }
        let identifiers: Vec<_> = formats
            .iter()
            .filter_map(|format| format["format_id"].as_str())
            .collect();
        if !identifiers.is_empty() {
            command.args(["--format", &identifiers.join("+")]);
        }
        let mut output = None;
        process(
            &mut command,
            cancel,
            Duration::from_secs(24 * 3600),
            |line| {
                if let Some(percent) = line
                    .strip_prefix("QC_PROGRESS:")
                    .and_then(|value| value.trim().trim_end_matches('%').parse::<f64>().ok())
                {
                    update(
                        state,
                        id,
                        "downloading",
                        (index as f64 + percent.clamp(0.0, 100.0) / 100.0) / entries.len() as f64
                            * 0.95,
                    );
                }
                if let Some(path) = line.strip_prefix("QC_FILE:") {
                    output = serde_json::from_str::<String>(path).ok().map(PathBuf::from);
                }
            },
        )?;
        let output = output.context("The downloader returned no completed file.")?;
        ensure!(
            fs::canonicalize(&output)?.starts_with(fs::canonicalize(&temporary)?),
            "Unexpected download path."
        );
        verify(tools, &output, value, &formats, cancel)?;
        let extension = output
            .extension()
            .and_then(|ext| ext.to_str())
            .context("Output format missing.")?;
        ensure!(
            extension.len() <= 8 && extension.bytes().all(|byte| byte.is_ascii_alphanumeric()),
            "Invalid output format."
        );
        let title = value["title"].as_str().unwrap_or(reference.service);
        let name = filename(title, reference.service, index, entries.len(), extension);
        outputs.push((output, name));
        if index == 0 {
            let mut data = state.lock().unwrap();
            if let Some(job) = data.jobs.iter_mut().find(|job| job.id == id) {
                job.title = title.into();
            }
        }
    }
    publish_files(outputs, state, desktop, id, cancel)
}
