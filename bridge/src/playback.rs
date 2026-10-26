use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    os::windows::fs::MetadataExt,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use windows::Win32::{
    Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT, System::Threading::CREATE_NO_WINDOW,
};

use crate::{
    browser,
    cookies::{BrowserCookie, CookieJar},
};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub home: PathBuf,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub audio: Vec<String>,
    pub subtitles: Vec<String>,
    pub cookies: Vec<BrowserCookie>,
    pub extractor: Option<Extractor>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Extractor {
    start: Option<f64>,
}

pub fn launch(
    home: &Path,
    url: String,
    start: Option<f64>,
    cookies: Vec<BrowserCookie>,
) -> Result<()> {
    open(Request {
        home: home.into(),
        url,
        cookies,
        headers: vec![],
        audio: vec![],
        subtitles: vec![],
        extractor: Some(Extractor { start }),
    })
}

pub fn open(request: Request) -> Result<()> {
    browser::application("qplay")
        .context("qplay is not installed. Install qplay and try again.")?;
    let input = serde_json::to_vec(&request)?;
    ensure!(input.len() <= 512 * 1024, "Playback request is too large.");
    // An installed image may be replaced or closed by the installer during playback.
    let executable = fs::read(std::env::current_exe()?)?;
    let directory = request.home.join("workers");
    fs::create_dir_all(&directory)?;
    ensure!(
        fs::symlink_metadata(&directory)?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0,
        "Invalid playback worker directory."
    );
    let worker_path = directory.join(format!(
        "qcatch-playback-{:x}.exe",
        Sha256::digest(&executable)
    ));
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&worker_path)
    {
        Ok(mut file) => file.write_all(&executable)?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            ensure!(
                fs::read(&worker_path)? == executable,
                "Invalid playback worker image."
            );
        }
        Err(error) => return Err(error.into()),
    }
    let mut worker = Command::new(worker_path)
        .arg("--playback")
        .creation_flags(CREATE_NO_WINDOW.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("Could not start the qcatch playback worker.")?;
    worker
        .stdin
        .take()
        .context("Playback worker input is unavailable.")?
        .write_all(&input)?;
    let output = worker
        .stdout
        .take()
        .context("Playback worker output is unavailable.")?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(output)
            .take(4096)
            .read_line(&mut line)
            .map(|_| line);
        let _ = sender.send(result);
    });
    let ready = receiver.recv_timeout(Duration::from_secs(10));
    let result = (|| {
        let ready: serde_json::Value =
            serde_json::from_str(&ready.context("Playback worker did not respond.")??)?;
        ensure!(
            ready["opened"] == true,
            "{}",
            ready["error"].as_str().unwrap_or("Could not open qplay.")
        );
        Ok(())
    })();
    if result.is_err() {
        let _ = worker.kill();
        let _ = worker.wait();
    }
    result
}

pub fn cleanup_workers(home: &Path) -> Result<()> {
    let directory = home.join("workers");
    let Ok(metadata) = fs::symlink_metadata(&directory) else {
        return Ok(());
    };
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Ok(());
    }
    for entry in fs::read_dir(directory)?.take(1000) {
        let entry = entry?;
        let name = entry.file_name();
        let Some(digest) = name
            .to_str()
            .and_then(|name| name.strip_prefix("qcatch-playback-"))
            .and_then(|name| name.strip_suffix(".exe"))
        else {
            continue;
        };
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            continue;
        }
        // Windows refuses to remove an executable image while its worker is alive.
        match fs::remove_file(entry.path()) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => (),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

// This process outlives the HTTP helper and owns cookies until the player exits.
pub fn worker() -> Result<()> {
    let result = (|| {
        let mut input = Vec::new();
        std::io::stdin()
            .take(512 * 1024 + 1)
            .read_to_end(&mut input)?;
        ensure!(input.len() <= 512 * 1024, "Playback request is too large.");
        let request: Request = serde_json::from_slice(&input)?;
        ensure!(
            request.home.is_absolute(),
            "Playback directory must be absolute."
        );
        let executable = browser::application("qplay").context("qplay is not installed.")?;
        let jar = CookieJar::playback(&request.home, &request.cookies)?;
        let mut command = Command::new(executable);
        command
            .creation_flags(CREATE_NO_WINDOW.0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.arg("--player-operation-mode=pseudo-gui");
        if let Some(extractor) = request.extractor {
            command.args([
                "--resume-playback=no",
                "--ytdl=yes",
                "--ytdl-raw-options-append=ignore-config=",
                "--ytdl-raw-options-append=no-plugin-dirs=",
            ]);
            if let Some(start) = extractor.start {
                ensure!(
                    start.is_finite() && start >= 0.0,
                    "Invalid playback position."
                );
                command.arg(format!("--start=+{start:.3}"));
            }
            if let Some(jar) = &jar {
                command.arg(format!(
                    "--ytdl-raw-options-append=cookies={}",
                    jar.path().display()
                ));
            }
        } else {
            command.arg("--ytdl=no");
            if let Some(jar) = &jar {
                command
                    .arg("--cookies=yes")
                    .arg(format!("--cookies-file={}", jar.path().display()));
            }
        }
        for (name, value) in request.headers {
            ensure!(
                !name.eq_ignore_ascii_case("cookie"),
                "Cookies must use the scoped cookie jar."
            );
            let header = format!("{name}: {value}");
            command.arg(format!(
                "--http-header-fields-append=%{}%{}",
                header.len(),
                header
            ));
        }
        for url in request.audio {
            command.arg(format!("--audio-file={url}"));
        }
        for url in request.subtitles {
            command.arg(format!("--sub-file={url}"));
        }
        let mut child = command
            .args(["--", &request.url])
            .spawn()
            .context("Could not open qplay.")?;
        println!("{{\"opened\":true}}");
        std::io::stdout().flush()?;
        let _ = child.wait();
        drop(jar);
        Ok(())
    })();
    if let Err(error) = &result {
        println!("{}", serde_json::json!({"error":format!("{error:#}")}));
    }
    result
}
