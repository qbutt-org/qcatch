use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use url::Url;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::*;
#[cfg(windows)]
pub use windows::*;

fn setup_page(executable: &Path, browser: &str) -> Result<(PathBuf, Url)> {
    let directory = executable
        .parent()
        .context("Application directory missing")?;
    let extension = directory.join("extension");
    let setup = directory.join("setup.html");
    ensure!(
        extension.join("manifest.json").is_file(),
        "Extension files are missing. Reinstall qcatch."
    );
    ensure!(
        setup.is_file(),
        "The setup page is missing. Reinstall qcatch."
    );
    // Chromium ignores privileged extensions-page URLs passed on the command line.
    let mut page =
        Url::from_file_path(setup).map_err(|_| anyhow::anyhow!("Invalid setup page path"))?;
    page.query_pairs_mut().append_pair("browser", browser);
    Ok((extension, page))
}
