use std::{
    env, fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    process::{Command, Stdio},
};

use anyhow::{Context, Result, ensure};
use serde_json::json;

use crate::{EXTENSION_ID, platform};

pub const NATIVE_HOST: &str = "org.qbutt.qcatch";

pub fn application(name: &str) -> Option<PathBuf> {
    let installed = platform::xdg_directory("XDG_DATA_HOME", ".local/share")
        .ok()?
        .join(name)
        .join("app")
        .join(name);
    std::iter::once(installed)
        .chain(env::split_paths(&env::var_os("PATH").unwrap_or_default()).map(|dir| dir.join(name)))
        .find(|path| {
            path.is_absolute()
                && fs::metadata(path)
                    .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
}

pub fn connect(browser: &str) -> Result<()> {
    let names: &[&str] = match browser {
        "edge" => &["microsoft-edge", "microsoft-edge-stable"],
        "chrome" => &[
            "google-chrome",
            "google-chrome-stable",
            "google-chrome-for-testing",
            "chromium",
            "chromium-browser",
            "chrome",
        ],
        _ => anyhow::bail!("Choose Microsoft Edge, Google Chrome or Chromium"),
    };
    let default = platform::default_browser_executable().and_then(|path| {
        let name = path.file_name()?.to_str()?;
        if !names.contains(&name) {
            return None;
        }
        if path.is_absolute() && path.is_file() {
            Some(path)
        } else {
            application(name)
        }
    });
    let executable = default
        .or_else(|| names.iter().find_map(|name| application(name)))
        .context("The selected browser is not installed.")?;
    let (extension, page) = super::setup_page(&env::current_exe()?, browser)?;
    register()?;
    Command::new(executable)
        .arg(page.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    println!(
        "{}",
        json!({"browser":browser,"extensionDirectory":extension,"extensionId":EXTENSION_ID.trim(),"nativeHost":NATIVE_HOST})
    );
    Ok(())
}

fn manifests() -> Result<Vec<PathBuf>> {
    let config = platform::xdg_directory("XDG_CONFIG_HOME", ".config")?;
    Ok([
        "google-chrome",
        "google-chrome-for-testing",
        "chromium",
        "microsoft-edge",
    ]
    .iter()
    .map(|browser| {
        config
            .join(browser)
            .join("NativeMessagingHosts")
            .join(format!("{NATIVE_HOST}.json"))
    })
    .collect())
}

pub fn register() -> Result<()> {
    register_executable(&env::current_exe()?)
}

pub fn register_executable(executable: &std::path::Path) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(&json!({
        "name":NATIVE_HOST,"description":"qcatch browser connection","path":executable,
        "type":"stdio","allowed_origins":[format!("chrome-extension://{}/", EXTENSION_ID.trim())]
    }))?;
    let paths = manifests()?;
    for path in &paths {
        let directory = path.parent().context("Missing native manifest directory")?;
        fs::create_dir_all(directory)?;
        let metadata = fs::symlink_metadata(directory)?;
        ensure!(
            metadata.is_dir()
                && !metadata.is_symlink()
                && metadata.uid() == unsafe { libc::geteuid() }
                && metadata.mode() & 0o022 == 0,
            "Unsafe native messaging directory"
        );
    }
    for path in paths {
        let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        use std::io::Write;
        let mut file = platform::private_file(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        platform::replace_file(&temporary, &path)?;
    }
    Ok(())
}

pub fn unregister(executable: &std::path::Path) -> Result<()> {
    for path in manifests()? {
        if !path.try_exists()? {
            continue;
        }
        let metadata = platform::check_private(&path, false)?;
        ensure!(metadata.is_file(), "Invalid native manifest");
        let value: serde_json::Value = serde_json::from_slice(&fs::read(&path)?)?;
        if value["path"]
            .as_str()
            .is_some_and(|value| std::path::Path::new(value) == executable)
        {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}
