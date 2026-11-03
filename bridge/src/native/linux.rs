use std::{
    fs,
    os::{
        fd::AsRawFd,
        unix::{fs::FileTypeExt, net::UnixStream},
    },
    path::PathBuf,
};

use anyhow::{Context, Result, ensure};
use serde::Deserialize;

use crate::platform;

#[derive(Deserialize)]
struct Discovery {
    pipe: PathBuf,
    pid: u32,
}

pub(super) fn connect() -> Result<UnixStream> {
    let discovery = std::env::var_os("QBUTT_BROWSER_BRIDGE_DISCOVERY")
        .map(PathBuf::from)
        .unwrap_or(
            platform::xdg_directory("XDG_DATA_HOME", ".local/share")?
                .join("qbutt/content/browser-bridge.json"),
        );
    ensure!(discovery.is_absolute(), "Invalid browser discovery path");
    platform::check_private(
        discovery
            .parent()
            .context("Missing browser discovery directory")?,
        true,
    )?;
    let metadata = platform::check_private(&discovery, false)
        .context("qbutt browser connection is not running")?;
    ensure!(
        metadata.is_file() && metadata.len() <= 8192,
        "Invalid browser discovery"
    );
    let discovery: Discovery = serde_json::from_slice(&fs::read(discovery)?)?;
    ensure!(
        discovery.pipe.is_absolute(),
        "Invalid browser connection endpoint"
    );
    platform::check_private(
        discovery
            .pipe
            .parent()
            .context("Missing socket directory")?,
        true,
    )?;
    let metadata = platform::check_private(&discovery.pipe, false)?;
    ensure!(
        metadata.file_type().is_socket(),
        "Invalid browser connection socket"
    );
    let stream = UnixStream::connect(&discovery.pipe)?;
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    ensure!(
        unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut size,
            )
        } == 0,
        "Cannot authenticate browser connection"
    );
    ensure!(
        credentials.uid == unsafe { libc::geteuid() } && credentials.pid as u32 == discovery.pid,
        "Browser connection belongs to another process or user"
    );
    Ok(stream)
}
