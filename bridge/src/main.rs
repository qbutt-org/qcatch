#![windows_subsystem = "windows"]

mod api;
mod app_update;
mod browser;
mod cookies;
mod download;
mod native;
mod platform;
mod playback;
mod services;
mod tools;

use std::{env, fs, path::PathBuf};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use windows::Win32::{
    System::Console::{ATTACH_PARENT_PROCESS, AttachConsole},
    UI::Shell::{FOLDERID_Desktop, FOLDERID_LocalAppData},
};

const EXTENSION_ID: &str = include_str!("../../release/extension-id.txt");
const PORT: u16 = 47832;

#[derive(Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct Config {
    additional_extension_ids: Vec<String>,
}

fn main() {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let native = args.iter().any(|arg| {
        arg == "--native-messaging"
            || arg == "--playback"
            || arg.to_string_lossy().starts_with("chrome-extension://")
    });
    if !native && args.first().is_some_and(|arg| arg != "--run") {
        let _ = unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };
    }
    if let Err(error) = run(&args) {
        eprintln!("{error:#}");
        if native {
            std::process::exit(1);
        }
        let home = args
            .windows(2)
            .find(|pair| pair[0] == "--data-dir")
            .map(|pair| PathBuf::from(&pair[1]))
            .or_else(|| {
                platform::known_folder(&FOLDERID_LocalAppData)
                    .ok()
                    .map(|path| path.join("qcatch"))
            });
        if let Some(home) = home {
            platform::log_error(&home, &format!("{error:#}"));
        }
        if args.is_empty() {
            platform::show_error(&format!("qcatch\n\n{error:#}"));
        }
        std::process::exit(1);
    }
}

fn run(arguments: &[std::ffi::OsString]) -> Result<()> {
    if arguments.first().is_some_and(|arg| arg == "--playback") {
        ensure!(arguments.len() == 1, "unexpected argument");
        return playback::worker();
    }
    if arguments
        .iter()
        .any(|arg| arg.to_string_lossy().starts_with("chrome-extension://"))
    {
        return native::relay(arguments);
    }
    if arguments.first().is_some_and(|arg| arg == "--version-json") {
        ensure!(arguments.len() == 1, "unexpected argument");
        println!(
            "{}",
            serde_json::json!({
                "product": "qcatch", "version": env!("CARGO_PKG_VERSION"),
                "protocolVersion": 1, "extensionId": EXTENSION_ID.trim(),
            })
        );
        return Ok(());
    }
    if arguments
        .first()
        .is_some_and(|arg| arg == "--register-native")
    {
        ensure!(arguments.len() == 1, "unexpected argument");
        return browser::register();
    }
    if arguments
        .first()
        .is_some_and(|arg| arg == "--connect-browser")
    {
        ensure!(
            arguments.len() == 2,
            "--connect-browser requires edge or chrome"
        );
        return browser::connect(arguments[1].to_str().context("invalid browser")?);
    }
    let _com = platform::ComApartment::new()?;
    let default_home = platform::known_folder(&FOLDERID_LocalAppData)?.join("qcatch");
    let mut action = None;
    let mut data_dir = None;
    let mut args = arguments.iter();
    while let Some(arg) = args.next() {
        if arg == "--data-dir" {
            ensure!(data_dir.is_none(), "--data-dir may only be supplied once");
            let path = PathBuf::from(
                args.next()
                    .context("--data-dir requires an absolute path")?,
            );
            ensure!(path.is_absolute(), "--data-dir must be absolute");
            data_dir = Some(path);
        } else if action.is_none() {
            action = Some(arg.to_str().context("invalid argument")?);
        } else {
            bail!("unexpected argument: {}", arg.to_string_lossy());
        }
    }
    let action = action.unwrap_or("--run");
    if action == "--help" {
        println!(
            "qcatch {}\n--run       Serve the extension on 127.0.0.1:{PORT}\n--status    Report running/stopped (exit 0/1)\n--stop      Stop qcatch and its downloads\n--version-json Report product protocol and version\n--connect-browser edge|chrome Register and open browser setup\n--data-dir <absolute path> Isolate --run/--status/--stop data for QA",
            env!("CARGO_PKG_VERSION")
        );
        return Ok(());
    }
    ensure!(
        matches!(action, "--run" | "--status" | "--stop"),
        "unknown command; use --help"
    );
    let home = data_dir.unwrap_or(default_home);
    fs::create_dir_all(&home)?;
    let control = platform::Control::new(&home)?;
    if action == "--stop" {
        let _lock = control.stop()?;
        println!("qcatch stopped.");
        return Ok(());
    }
    if action == "--status" {
        if control.lock(0)?.is_some() {
            println!("qcatch is stopped.");
            std::process::exit(1);
        }
        println!("qcatch is running.");
        return Ok(());
    }
    let Some(_lock) = control.lock(0)? else {
        return Ok(());
    };
    control.reset()?;
    let config_path = home.join("config.json");
    let config: Config = if config_path.exists() {
        serde_json::from_slice(&fs::read(&config_path)?).context("invalid config.json")?
    } else {
        let config = Config::default();
        fs::write(&config_path, serde_json::to_vec_pretty(&config)?)?;
        config
    };
    ensure!(
        config
            .additional_extension_ids
            .iter()
            .all(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))),
        "invalid additionalExtensionIds in config.json"
    );
    let desktop = platform::known_folder(&FOLDERID_Desktop)?;
    api::serve(home, desktop, config, &control)
}
