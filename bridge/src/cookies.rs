use std::{
    fs::{self, File},
    path::{Path, PathBuf},
};

use crate::platform;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserCookie {
    domain: String,
    path: String,
    name: String,
    value: String,
    secure: bool,
    expires: Option<f64>,
    #[serde(default)]
    host_only: Option<bool>,
}

pub struct CookieJar {
    directory: PathBuf,
    file: PathBuf,
    lease: Option<File>,
}

impl CookieJar {
    pub fn new(home: &Path, cookies: &[BrowserCookie]) -> Result<Option<Self>> {
        Self::scoped(home, cookies, &["youtube.com"])
    }

    pub fn scoped(
        home: &Path,
        cookies: &[BrowserCookie],
        domains: &[&str],
    ) -> Result<Option<Self>> {
        Self::validate_scope(cookies, domains)?;
        Self::create(home, cookies, false)
    }

    pub fn validate_scope(cookies: &[BrowserCookie], domains: &[&str]) -> Result<()> {
        ensure!(
            cookies.iter().all(|cookie| {
                let domain = cookie.domain.trim_start_matches('.').to_ascii_lowercase();
                domains
                    .iter()
                    .any(|allowed| domain == *allowed || domain.ends_with(&format!(".{allowed}")))
            }),
            "Cookies do not belong to the selected source."
        );
        Ok(())
    }

    pub fn playback(home: &Path, cookies: &[BrowserCookie]) -> Result<Option<Self>> {
        Self::create(home, cookies, true)
    }

    fn create(home: &Path, cookies: &[BrowserCookie], playback: bool) -> Result<Option<Self>> {
        if cookies.is_empty() {
            return Ok(None);
        }
        ensure!(cookies.len() <= 500, "Too many browser cookies.");
        let directory = home
            .join(if playback { "playback" } else { "temp" })
            .join(uuid::Uuid::new_v4().to_string());
        #[cfg(windows)]
        fs::create_dir_all(&directory)?;
        #[cfg(target_os = "linux")]
        platform::private_directory(&directory)?;
        let file = directory.join("cookies.txt");
        let lease = playback
            .then(|| platform::lease(&directory.join("lease.lock"), true))
            .transpose()?;
        let jar = Self {
            directory,
            file,
            lease,
        };
        let mut text = String::from("# Netscape HTTP Cookie File\n");
        for cookie in cookies {
            let domain = cookie.domain.to_ascii_lowercase();
            ensure!(
                domain
                    .trim_start_matches('.')
                    .split('.')
                    .all(|label| !label.is_empty()
                        && label
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
                    && domain.contains('.'),
                "Invalid browser cookie domain."
            );
            ensure!(
                cookie.path.starts_with('/') && !cookie.name.is_empty(),
                "Invalid browser cookie."
            );
            ensure!(
                [&cookie.domain, &cookie.path, &cookie.name, &cookie.value]
                    .iter()
                    .all(|value| !value.contains(['\t', '\r', '\n', '\0'])),
                "Invalid browser cookie."
            );
            let expires = cookie
                .expires
                .filter(|value| value.is_finite() && *value > 0.0)
                .map(|value| value as u64)
                .unwrap_or(0);
            text.push_str(&format!(
                "{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
                cookie.domain,
                if !cookie.host_only.unwrap_or(!cookie.domain.starts_with('.')) {
                    "TRUE"
                } else {
                    "FALSE"
                },
                cookie.path,
                if cookie.secure { "TRUE" } else { "FALSE" },
                expires,
                cookie.name,
                cookie.value
            ));
        }
        ensure!(
            text.len() <= 256 * 1024,
            "Browser cookie data is too large."
        );
        use std::io::Write;
        platform::private_file(&jar.file)?.write_all(text.as_bytes())?;
        Ok(Some(jar))
    }

    pub fn path(&self) -> &Path {
        &self.file
    }
}

impl Drop for CookieJar {
    fn drop(&mut self) {
        drop(self.lease.take());
        let _ = fs::remove_file(&self.file);
        let _ = fs::remove_file(self.directory.join("lease.lock"));
        let _ = fs::remove_dir(&self.directory);
    }
}

pub fn cleanup_playback(home: &Path) -> Result<()> {
    let root = home.join("playback");
    let Ok(metadata) = fs::symlink_metadata(&root) else {
        return Ok(());
    };
    if !metadata.is_dir() || platform::is_link(&metadata) {
        return Ok(());
    }
    for entry in fs::read_dir(&root)?.take(1000) {
        let entry = entry?;
        if !entry
            .file_name()
            .to_str()
            .is_some_and(|name| uuid::Uuid::parse_str(name).is_ok_and(|id| id.to_string() == name))
        {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.is_dir() || platform::is_link(&metadata) {
            continue;
        }
        let lease = platform::lease(&entry.path().join("lease.lock"), false);
        match lease {
            Ok(lease) => drop(lease),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        }
        fs::remove_dir_all(entry.path())?;
    }
    Ok(())
}
