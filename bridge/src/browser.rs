use std::{env, fs, os::windows::process::CommandExt, path::PathBuf, process::Command};

use anyhow::{Context, Result, ensure};
use serde_json::json;
use windows::Win32::{System::Threading::CREATE_NO_WINDOW, UI::Shell::FOLDERID_LocalAppData};
use winreg::{
    RegKey,
    enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
};

use crate::{EXTENSION_ID, platform};

pub const NATIVE_HOST: &str = "org.qbutt.qcatch";

pub fn application(name: &str) -> Option<PathBuf> {
    let key = format!(r"Software\Microsoft\Windows\CurrentVersion\App Paths\{name}.exe");
    [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
        .into_iter()
        .find_map(|hive| {
            let value: String = RegKey::predef(hive)
                .open_subkey(&key)
                .ok()?
                .get_value("")
                .ok()?;
            let path = PathBuf::from(value);
            (path.is_absolute() && path.is_file()).then_some(path)
        })
}

pub fn connect(browser: &str) -> Result<()> {
    let (page, executable) = match browser {
        "edge" => ("edge://extensions", "msedge"),
        "chrome" => ("chrome://extensions", "chrome"),
        _ => anyhow::bail!("Choose Microsoft Edge or Google Chrome"),
    };
    let executable = application(executable).context("Выбранный браузер не установлен.")?;
    let native_executable = env::current_exe()?;
    let extension = native_executable
        .parent()
        .context("Application directory missing")?
        .join("extension");
    ensure!(
        extension.join("manifest.json").is_file(),
        "Файлы расширения отсутствуют. Переустановите qcatch."
    );
    register()?;
    Command::new(executable)
        .arg(page)
        .creation_flags(CREATE_NO_WINDOW.0)
        .spawn()?;
    Command::new("explorer.exe").arg(&extension).spawn()?;
    println!(
        "{}",
        json!({ "browser": browser, "extensionDirectory": extension,
        "extensionId": EXTENSION_ID.trim(), "nativeHost": NATIVE_HOST })
    );
    Ok(())
}

pub fn register() -> Result<()> {
    let native_executable = env::current_exe()?;
    let home = platform::known_folder(&FOLDERID_LocalAppData)?.join("qcatch");
    fs::create_dir_all(&home)?;
    let manifest = home.join("native-messaging.json");
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&json!({
            "name": NATIVE_HOST, "description": "qcatch browser connection",
            "path": native_executable, "type": "stdio",
            "allowed_origins": [format!("chrome-extension://{}/", EXTENSION_ID.trim())],
        }))?,
    )?;
    for registry in [
        r"Software\Microsoft\Edge\NativeMessagingHosts",
        r"Software\Google\Chrome\NativeMessagingHosts",
    ] {
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(format!(r"{registry}\{NATIVE_HOST}"))?;
        key.set_value("", &manifest.to_string_lossy().as_ref())?;
    }
    Ok(())
}
