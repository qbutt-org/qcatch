use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: String,
    files: BTreeMap<String, String>,
}

pub struct Tools {
    pub directory: PathBuf,
    checked: Option<Instant>,
    pub version: String,
}

impl Tools {
    pub fn new(_home: &Path) -> Result<Self> {
        let directory = std::env::current_exe()?
            .parent()
            .context("Application directory missing")?
            .join("tools");
        Ok(Self {
            directory,
            checked: None,
            version: String::new(),
        })
    }

    pub fn executable(&self, name: &str) -> PathBuf {
        self.directory.join(name)
    }

    pub fn is_current(&self) -> bool {
        self.checked
            .is_some_and(|t| t.elapsed() < Duration::from_secs(6 * 3600))
    }

    pub fn ensure_latest(&mut self) -> Result<()> {
        if self.is_current() {
            return Ok(());
        }
        let manifest: Manifest = serde_json::from_slice(
            &fs::read(self.directory.join("manifest.json"))
                .context("The Linux tools bundle is missing. Reinstall qcatch.")?,
        )?;
        for required in ["ffmpeg", "ffprobe", "yt-dlp", "deno"] {
            ensure!(
                manifest.files.contains_key(required),
                "Missing bundled tool: {required}"
            );
        }
        for (name, digest) in &manifest.files {
            let path = Path::new(name);
            ensure!(
                path.components()
                    .all(|part| matches!(part, std::path::Component::Normal(_))),
                "Invalid tool path"
            );
            let path = self.directory.join(path);
            let metadata = fs::symlink_metadata(&path)?;
            ensure!(
                metadata.is_file() && !metadata.is_symlink() && metadata.len() <= 512 * 1024 * 1024,
                "Invalid bundled tool"
            );
            let mut file = fs::File::open(path)?;
            let mut hash = Sha256::new();
            let mut buffer = [0; 128 * 1024];
            loop {
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                hash.update(&buffer[..count]);
            }
            ensure!(
                format!("{:x}", hash.finalize()) == *digest,
                "Bundled tool integrity check failed: {name}"
            );
        }
        self.version = manifest.version;
        self.checked = Some(Instant::now());
        Ok(())
    }
}
