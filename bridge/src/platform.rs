#[cfg(target_os = "linux")]
mod desktop;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
pub use desktop::default_browser_executable;
#[cfg(target_os = "linux")]
pub use linux::*;
#[cfg(windows)]
pub use windows::*;

use std::{
    fs,
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes()
            & ::windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT.0
            != 0
    }
    #[cfg(target_os = "linux")]
    {
        metadata.is_symlink()
    }
}

pub fn private_file(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

pub fn log_error(home: &Path, error: &str) {
    let _ = (|| -> anyhow::Result<()> {
        #[cfg(windows)]
        fs::create_dir_all(home)?;
        #[cfg(target_os = "linux")]
        private_directory(home)?;
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let message: String = error.chars().take(4096).collect();
        let truncated = if message.len() < error.len() {
            "…"
        } else {
            ""
        };
        let entry = format!("[{timestamp}] {message}{truncated}\n");
        let path = home.join("bridge.log");
        if fs::metadata(&path)
            .is_ok_and(|metadata| metadata.len() + entry.len() as u64 > 1024 * 1024)
        {
            replace_file(&path, &home.join("bridge.previous.log"))?;
        }
        let mut options = fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        options.open(path)?.write_all(entry.as_bytes())?;
        Ok(())
    })();
}
