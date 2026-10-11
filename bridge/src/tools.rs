use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail, ensure};
use reqwest::blocking::Client;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::platform;

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
}

pub struct Tools {
    pub directory: PathBuf,
    client: Client,
    checked: Option<Instant>,
    pub version: String,
}

impl Tools {
    pub fn new(home: &Path) -> Result<Self> {
        let directory = home.join("tools");
        fs::create_dir_all(&directory)?;
        Ok(Self {
            directory,
            client: Client::builder()
                .user_agent(concat!("qcatch/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(20))
                .timeout(Duration::from_secs(900))
                .build()?,
            checked: None,
            version: String::new(),
        })
    }

    pub fn is_current(&self) -> bool {
        self.checked
            .is_some_and(|checked| checked.elapsed() < Duration::from_secs(6 * 3600))
    }

    pub fn ensure_latest(&mut self) -> Result<()> {
        if self.is_current() {
            return Ok(());
        }
        let release = self.release("yt-dlp/yt-dlp")?;
        let installed = self.directory.join("yt-dlp.version");
        if !self.directory.join("yt-dlp.exe").is_file()
            || fs::read_to_string(&installed).unwrap_or_default() != release.tag_name
        {
            let asset = release
                .assets
                .iter()
                .find(|asset| asset.name == "yt-dlp.exe")
                .context("yt-dlp release has no Windows executable")?;
            let download = self.download(asset)?;
            platform::replace_file(&download, &self.directory.join("yt-dlp.exe"))?;
            fs::write(installed, &release.tag_name)?;
        }
        self.version = release.tag_name;
        if !self.directory.join("ffmpeg.exe").is_file()
            || !self.directory.join("ffprobe.exe").is_file()
        {
            self.install_zip(
                "yt-dlp/FFmpeg-Builds",
                "ffmpeg-master-latest-win64-gpl.zip",
                &["ffmpeg.exe", "ffprobe.exe"],
            )?;
        }
        if !self.directory.join("deno.exe").is_file() {
            self.install_zip(
                "denoland/deno",
                "deno-x86_64-pc-windows-msvc.zip",
                &["deno.exe"],
            )?;
        }
        self.checked = Some(Instant::now());
        Ok(())
    }

    fn release(&self, repo: &str) -> Result<Release> {
        self.client
            .get(format!(
                "https://api.github.com/repos/{repo}/releases/latest"
            ))
            .timeout(Duration::from_secs(30))
            .send()
            .context("Cannot check tool updates; check internet access to GitHub")?
            .error_for_status()?
            .json()
            .context("Invalid GitHub release metadata")
    }

    fn download(&self, asset: &Asset) -> Result<PathBuf> {
        let expected = asset
            .digest
            .as_deref()
            .and_then(|digest| digest.strip_prefix("sha256:"))
            .context("Release asset has no SHA256 digest; refusing unverified executable")?;
        ensure!(
            asset
                .browser_download_url
                .starts_with("https://github.com/"),
            "Invalid release download host"
        );
        let staging = self.directory.join(format!("{}.download", asset.name));
        let result = (|| -> Result<()> {
            let mut response = self
                .client
                .get(&asset.browser_download_url)
                .send()?
                .error_for_status()?;
            let mut file = File::create(&staging)?;
            let mut digest = Sha256::new();
            let mut buffer = [0; 128 * 1024];
            let mut total = 0usize;
            loop {
                let count = response.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                total += count;
                ensure!(
                    total <= 512 * 1024 * 1024,
                    "Tool download exceeds size limit"
                );
                file.write_all(&buffer[..count])?;
                digest.update(&buffer[..count]);
            }
            file.sync_all()?;
            ensure!(
                format!("{:x}", digest.finalize()).eq_ignore_ascii_case(expected),
                "Tool SHA256 verification failed"
            );
            Ok(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&staging);
            return Err(error);
        }
        Ok(staging)
    }

    fn install_zip(&self, repo: &str, name: &str, files: &[&str]) -> Result<()> {
        let release = self.release(repo)?;
        let asset = release
            .assets
            .iter()
            .find(|asset| asset.name == name)
            .context("Release archive is unavailable")?;
        let path = self.download(asset)?;
        let result = (|| -> Result<()> {
            let mut archive = zip::ZipArchive::new(File::open(&path)?)?;
            for name in files {
                let mut found = false;
                for index in 0..archive.len() {
                    let mut entry = archive.by_index(index)?;
                    if entry
                        .enclosed_name()
                        .is_some_and(|path| path.file_name().is_some_and(|file| file == *name))
                    {
                        ensure!(
                            entry.size() < 512 * 1024 * 1024,
                            "Tool executable exceeds size limit"
                        );
                        let staging = self.directory.join(format!("{name}.new"));
                        let mut output = File::create(&staging)?;
                        std::io::copy(&mut entry, &mut output)?;
                        output.sync_all()?;
                        drop(output);
                        platform::replace_file(&staging, &self.directory.join(name))?;
                        found = true;
                        break;
                    }
                }
                if !found {
                    bail!("{name} is missing from tool archive");
                }
            }
            Ok(())
        })();
        let _ = fs::remove_file(path);
        result
    }
}
