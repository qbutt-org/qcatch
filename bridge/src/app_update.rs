use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::windows::{fs::MetadataExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use windows::Win32::{
    Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT, System::Threading::CREATE_NO_WINDOW,
    UI::Shell::FOLDERID_LocalAppData,
};

use crate::{browser, platform};

pub enum State {
    Disabled,
    Idle,
    Checking(Arc<AtomicBool>),
    Current,
    Ready(Prepared),
    Failed(String),
    Installing,
}

impl State {
    pub fn snapshot(&self) -> Value {
        match self {
            Self::Disabled => json!({"state":"disabled"}),
            Self::Idle => json!({"state":"idle"}),
            Self::Checking(_) => json!({"state":"checking"}),
            Self::Current => json!({"state":"current"}),
            Self::Ready(update) => json!({"state":"ready","version":update.version}),
            Self::Failed(error) => json!({"state":"error","error":error}),
            Self::Installing => json!({"state":"installing"}),
        }
    }

    pub fn cancel_check(&self) {
        if let Self::Checking(cancel) = self {
            cancel.store(true, Ordering::Release);
        }
    }
}

pub struct Prepared {
    version: String,
    path: PathBuf,
    size: u64,
    digest: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

pub fn installation(home: &Path) -> Option<PathBuf> {
    let expected_home = platform::known_folder(&FOLDERID_LocalAppData)
        .ok()?
        .join("qcatch");
    if fs::canonicalize(home).ok()? != fs::canonicalize(expected_home).ok()? {
        return None;
    }
    let registered = browser::application("qcatch")?;
    if !platform::same_path(&registered, &std::env::current_exe().ok()?) {
        return None;
    }
    registered.parent().map(Path::to_path_buf)
}

fn version(value: &str) -> Option<(u32, u32, u32)> {
    let mut parts = value.split('.');
    let number = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(number)
}

fn verified(path: &Path, size: u64, digest: &str) -> Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file()
        || metadata.len() != size
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
    {
        return Ok(false);
    }
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()) == digest)
}

fn cleanup_updates(directory: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err(anyhow::anyhow!("Invalid update cache directory."));
    }
    let current = version(env!("CARGO_PKG_VERSION")).expect("compiled qcatch version");
    for entry in fs::read_dir(directory)?.take(1000) {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some((number, identity)) = name
            .strip_prefix("qcatch-v")
            .and_then(|name| name.strip_suffix("-setup.exe"))
            .and_then(|name| name.split_once('-'))
        else {
            continue;
        };
        if identity.len() < 32
            || !identity
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
            || version(number).is_none_or(|number| number > current)
        {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            continue;
        }
        match fs::remove_file(entry.path()) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => (),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

pub fn prepare(home: &Path, cancel: &AtomicBool) -> Result<Option<Prepared>> {
    cleanup_updates(&home.join("updates"))?;
    let partial = home
        .join("updates")
        .join(format!("qcatch-{}.partial", uuid::Uuid::new_v4()));
    let mut owns_partial = false;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(async {
        tokio::select! {
            biased;
            _ = wait_for_cancel(cancel) => Ok(None),
            result = prepare_update(home, &partial, &mut owns_partial) => result,
        }
    });
    runtime.shutdown_timeout(Duration::from_secs(1));
    if owns_partial && partial.exists() {
        fs::remove_file(partial).context("Could not remove temporary update files.")?;
    }
    result
}

async fn wait_for_cancel(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn prepare_update(
    home: &Path,
    partial: &Path,
    owns_partial: &mut bool,
) -> Result<Option<Prepared>> {
    let client = Client::builder()
        .user_agent(concat!("qcatch/", env!("CARGO_PKG_VERSION")))
        .https_only(true)
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(600))
        .build()?;
    let mut response = client
        .get("https://api.github.com/repos/qbutt-org/qcatch/releases/latest")
        .timeout(Duration::from_secs(15))
        .send()
        .await?
        .error_for_status()?;
    let mut metadata = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            metadata.len() + chunk.len() <= 1024 * 1024,
            "qcatch release metadata is too large."
        );
        metadata.extend_from_slice(&chunk);
    }
    let release: Release = serde_json::from_slice(&metadata)?;
    let candidate = release
        .tag_name
        .strip_prefix('v')
        .and_then(version)
        .context("Invalid qcatch release version.")?;
    if candidate <= version(env!("CARGO_PKG_VERSION")).expect("compiled qcatch version") {
        return Ok(None);
    }
    let mut matches = release
        .assets
        .iter()
        .filter(|asset| asset.name == "qcatch-setup.exe");
    let asset = matches.next().context("qcatch release has no installer.")?;
    ensure!(
        matches.next().is_none()
            && asset.size > 0
            && asset.size <= 64 * 1024 * 1024
            && asset.browser_download_url
                == format!(
                    "https://github.com/qbutt-org/qcatch/releases/download/{}/qcatch-setup.exe",
                    release.tag_name
                ),
        "Invalid qcatch installer metadata."
    );
    let digest = asset
        .digest
        .as_deref()
        .and_then(|value| value.strip_prefix("sha256:"))
        .filter(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
        .context("qcatch installer has no valid SHA-256 digest.")?;
    let directory = home.join("updates");
    fs::create_dir_all(&directory)?;
    ensure!(
        fs::symlink_metadata(&directory)?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0,
        "Invalid qcatch update directory."
    );
    let cached = directory.join(format!("qcatch-{}-{digest}-setup.exe", release.tag_name));
    if verified(&cached, asset.size, digest)? {
        return Ok(Some(Prepared {
            version: release.tag_name[1..].into(),
            path: cached,
            size: asset.size,
            digest: digest.into(),
        }));
    }

    let target = if cached.exists() {
        directory.join(format!(
            "qcatch-{}-{}-setup.exe",
            release.tag_name,
            uuid::Uuid::new_v4()
        ))
    } else {
        cached
    };
    let mut response = client
        .get(&asset.browser_download_url)
        .send()
        .await?
        .error_for_status()?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(partial)?;
    *owns_partial = true;
    let mut hash = Sha256::new();
    let mut received = 0_u64;
    while let Some(chunk) = response.chunk().await? {
        received += chunk.len() as u64;
        ensure!(
            received <= asset.size,
            "qcatch update exceeds its declared size."
        );
        file.write_all(&chunk)?;
        hash.update(&chunk);
    }
    file.sync_all()?;
    drop(file);
    ensure!(
        received == asset.size && format!("{:x}", hash.finalize()) == digest,
        "qcatch update failed integrity verification."
    );
    platform::move_new_file(partial, &target)?;
    Ok(Some(Prepared {
        version: release.tag_name[1..].into(),
        path: target,
        size: asset.size,
        digest: digest.into(),
    }))
}

impl Prepared {
    pub fn start(&self, install: &Path) -> Result<()> {
        ensure!(
            verified(&self.path, self.size, &self.digest)?,
            "The qcatch update failed integrity verification."
        );
        Command::new(&self.path)
            .args([
                "/VERYSILENT",
                "/SUPPRESSMSGBOXES",
                "/NORESTART",
                "/SP-",
                "/NOCLOSEAPPLICATIONS",
            ])
            .arg(format!("/DIR={}", install.display()))
            .arg(format!("/QCATCHUPDATE={}", std::process::id()))
            .current_dir(install)
            .creation_flags(CREATE_NO_WINDOW.0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("Could not start the qcatch update.")?;
        Ok(())
    }
}
