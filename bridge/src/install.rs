use std::{
    collections::{BTreeMap, HashSet},
    env, fs,
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{app_update::version, browser, platform};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bundle {
    product: String,
    version: String,
    #[serde(rename = "protocolVersion")]
    protocol: u32,
    files: BTreeMap<String, String>,
}

pub fn run(arguments: &[std::ffi::OsString]) -> Result<()> {
    match arguments[0].to_str() {
        Some("--install") => {
            ensure!(arguments.len() == 1, "--install takes no arguments");
            let executable = env::current_exe()?;
            install(
                executable
                    .parent()
                    .context("Application directory missing")?,
            )
        }
        Some("--uninstall") => {
            ensure!(arguments.len() == 1, "--uninstall takes no arguments");
            uninstall()
        }
        Some("--apply-update") => {
            ensure!(arguments.len() == 3, "Invalid update command");
            let archive = PathBuf::from(&arguments[1]);
            let pid: i32 = arguments[2]
                .to_str()
                .context("Invalid update process")?
                .parse()?;
            ensure!(
                pid > 1 && pid != std::process::id() as i32,
                "Invalid update process"
            );
            let started = Instant::now();
            while unsafe { libc::kill(pid, 0) } == 0 {
                ensure!(
                    started.elapsed() < Duration::from_secs(120),
                    "qcatch did not exit for its update"
                );
                thread::sleep(Duration::from_millis(100));
            }
            apply_update(&archive)
        }
        _ => anyhow::bail!("Invalid installation command"),
    }
}

fn relative(value: &str) -> Result<&Path> {
    let path = Path::new(value);
    ensure!(
        !value.is_empty()
            && path
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "Invalid bundle path"
    );
    Ok(path)
}

fn manifest(directory: &Path) -> Result<Bundle> {
    let metadata = fs::symlink_metadata(directory.join("bundle.json"))?;
    ensure!(
        metadata.is_file() && metadata.nlink() == 1 && metadata.len() <= 4 * 1024 * 1024,
        "Invalid qcatch bundle manifest"
    );
    let bundle: Bundle = serde_json::from_slice(&fs::read(directory.join("bundle.json"))?)?;
    ensure!(
        bundle.product == "qcatch" && bundle.protocol == 1 && !bundle.files.is_empty(),
        "Invalid qcatch bundle"
    );
    for required in ["qcatch", "extension/manifest.json", "tools/manifest.json"] {
        ensure!(
            bundle.files.contains_key(required),
            "Incomplete qcatch bundle: {required}"
        );
    }
    Ok(bundle)
}

fn bundle(directory: &Path) -> Result<Bundle> {
    let bundle = manifest(directory)?;
    owned_directory(directory, &bundle)?;
    for (name, digest) in &bundle.files {
        let path = directory.join(relative(name)?);
        let metadata = fs::metadata(&path)?;
        ensure!(
            metadata.is_file() && metadata.nlink() == 1 && metadata.len() <= 512 * 1024 * 1024,
            "Invalid qcatch bundle file"
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
            "qcatch bundle integrity check failed: {name}"
        );
    }
    Ok(bundle)
}

fn owned_directory(directory: &Path, bundle: &Bundle) -> Result<()> {
    let mut expected = HashSet::new();
    for name in bundle
        .files
        .keys()
        .map(String::as_str)
        .chain(["bundle.json"])
    {
        let path = relative(name)?;
        for ancestor in path
            .ancestors()
            .take_while(|path| !path.as_os_str().is_empty())
        {
            expected.insert(ancestor.to_path_buf());
        }
    }
    let mut pending = vec![directory.to_path_buf()];
    while let Some(parent) = pending.pop() {
        for entry in fs::read_dir(parent)? {
            let path = entry?.path();
            let relative = path.strip_prefix(directory)?;
            ensure!(expected.remove(relative), "Unowned file in qcatch bundle");
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.is_dir() {
                pending.push(path);
            } else {
                ensure!(
                    metadata.is_file() && metadata.nlink() == 1,
                    "Invalid qcatch bundle file"
                );
            }
        }
    }
    ensure!(expected.is_empty(), "Incomplete qcatch bundle");
    Ok(())
}

fn launcher() -> Result<PathBuf> {
    Ok(platform::user_home()?.join(".local/bin/qcatch"))
}
fn autostart() -> Result<PathBuf> {
    Ok(platform::xdg_directory("XDG_CONFIG_HOME", ".config")?.join("autostart/qcatch.desktop"))
}

fn desktop_entry(executable: &Path) -> String {
    let quoted = executable
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('`', "\\`")
        .replace('$', "\\$")
        .replace('%', "%%");
    format!(
        "[Desktop Entry]\nType=Application\nName=qcatch\nExec=\"{quoted}\" --run\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
    )
}

fn install(source: &Path) -> Result<()> {
    let candidate = bundle(source)?;
    ensure!(
        candidate.version == env!("CARGO_PKG_VERSION"),
        "Bundle version does not match its installer"
    );
    let home = platform::data_home()?;
    platform::private_directory(&home)?;
    let destination = home.join("app");
    let executable = destination.join("qcatch");
    if destination.try_exists()? {
        platform::check_private(&destination, true)?;
        let existing = manifest(&destination)?;
        owned_directory(&destination, &existing)?;
        ensure!(
            version(&existing.version).context("Invalid installed version")?
                <= version(&candidate.version).context("Invalid bundle version")?,
            "A newer qcatch version is already installed"
        );
    }
    let link = launcher()?;
    if let Ok(metadata) = fs::symlink_metadata(&link) {
        ensure!(
            metadata.is_symlink() && fs::read_link(&link)? == executable,
            "The qcatch launcher belongs to another application"
        );
    }
    let startup = autostart()?;
    let entry = desktop_entry(&executable);
    if startup.try_exists()? {
        ensure!(
            !fs::symlink_metadata(&startup)?.is_symlink() && fs::read_to_string(&startup)? == entry,
            "The qcatch startup entry belongs to another application"
        );
    }
    let staging = home.join(format!(".install-{}", uuid::Uuid::new_v4()));
    platform::private_directory(&staging)?;
    let result = (|| -> Result<()> {
        for name in candidate
            .files
            .keys()
            .chain(std::iter::once(&"bundle.json".to_string()))
        {
            let from = source.join(relative(name)?);
            let to = staging.join(name);
            platform::private_directory(to.parent().context("Missing bundle directory")?)?;
            fs::copy(&from, &to)?;
            let mode = if fs::metadata(from)?.permissions().mode() & 0o111 != 0 {
                0o700
            } else {
                0o600
            };
            fs::set_permissions(to, fs::Permissions::from_mode(mode))?;
        }
        bundle(&staging)?;
        let control = platform::Control::new(&home)?;
        let _lock = control.stop()?;
        let previous = home.join(format!(".previous-{}", uuid::Uuid::new_v4()));
        if destination.try_exists()? {
            fs::rename(&destination, &previous)?;
        }
        if let Err(error) = fs::rename(&staging, &destination) {
            if previous.try_exists()? {
                fs::rename(&previous, &destination)?;
            }
            return Err(error.into());
        }
        let register = (|| -> Result<()> {
            browser::register_executable(&executable)?;
            fs::create_dir_all(link.parent().context("Missing launcher directory")?)?;
            if fs::symlink_metadata(&link).is_err() {
                symlink(&executable, &link)?;
            }
            fs::create_dir_all(startup.parent().context("Missing startup directory")?)?;
            if !startup.try_exists()? {
                platform::private_file(&startup)?.write_all(entry.as_bytes())?;
            }
            Ok(())
        })();
        if let Err(error) = register {
            fs::remove_dir_all(&destination)?;
            if previous.try_exists()? {
                fs::rename(&previous, &destination)?;
            }
            return Err(error);
        }
        if previous.try_exists()? {
            fs::remove_dir_all(previous)?;
        }
        control.reset()?;
        drop(_lock);
        Command::new(&executable)
            .arg("--run")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        println!(
            "{}",
            serde_json::json!({"installed":true,"version":candidate.version,"executable":executable})
        );
        Ok(())
    })();
    if staging.try_exists()? {
        fs::remove_dir_all(staging)?;
    }
    result
}

fn uninstall() -> Result<()> {
    let home = platform::data_home()?;
    let directory = home.join("app");
    platform::check_private(&directory, true)?;
    let existing = manifest(&directory)?;
    owned_directory(&directory, &existing)?;
    let executable = directory.join("qcatch");
    let control = platform::Control::new(&home)?;
    let _lock = control.stop()?;
    browser::unregister(&executable)?;
    let link = launcher()?;
    if fs::read_link(&link).is_ok_and(|value| value == executable) {
        fs::remove_file(link)?;
    }
    let startup = autostart()?;
    if fs::read_to_string(&startup).is_ok_and(|value| value == desktop_entry(&executable))
        && !fs::symlink_metadata(&startup)?.is_symlink()
    {
        fs::remove_file(startup)?;
    }
    fs::remove_dir_all(directory)?;
    println!(
        "{}",
        serde_json::json!({"uninstalled":true,"dataDirectory":home})
    );
    Ok(())
}

fn apply_update(archive: &Path) -> Result<()> {
    let updates = platform::data_home()?.join("updates");
    platform::check_private(&updates, true)?;
    ensure!(
        archive.parent() == Some(updates.as_path()),
        "Invalid update archive path"
    );
    let metadata = platform::check_private(archive, false)?;
    ensure!(
        metadata.is_file() && metadata.len() <= 512 * 1024 * 1024,
        "Invalid update archive"
    );
    let staging = updates.join(format!(".extract-{}", uuid::Uuid::new_v4()));
    platform::private_directory(&staging)?;
    let result = (|| -> Result<()> {
        let file = fs::File::open(archive)?;
        let mut footer_file = file.try_clone()?;
        let mut archive = zip::ZipArchive::new(file)?;
        // Our bounded release archives are single-disk ZIP32. ZipArchive hides
        // duplicate central names, so check its count against the original footer.
        let footer_offset =
            footer_file.seek(SeekFrom::End(-22 - archive.comment().len() as i64))?;
        let mut footer = [0; 22];
        footer_file.read_exact(&mut footer)?;
        let entries = u16::from_le_bytes([footer[10], footer[11]]) as usize;
        ensure!(
            footer[..4] == [0x50, 0x4b, 0x05, 0x06]
                && footer[4..8] == [0; 4]
                && footer[8..10] == footer[10..12]
                && footer[12..16] != [0xff; 4]
                && footer[16..20] != [0xff; 4]
                && entries > 0
                && entries <= 20000,
            "Invalid or unsupported update ZIP metadata"
        );
        if footer_offset >= 20 {
            footer_file.seek(SeekFrom::Start(footer_offset - 20))?;
            let mut signature = [0; 4];
            footer_file.read_exact(&mut signature)?;
            ensure!(
                signature != [0x50, 0x4b, 0x06, 0x07],
                "ZIP64 update archives are unsupported"
            );
        }
        ensure!(entries == archive.len(), "Duplicate update path");
        let mut names = HashSet::new();
        let mut total = 0u64;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index)?;
            let name = entry.enclosed_name().context("Unsafe update path")?;
            relative(name.to_str().context("Invalid update filename")?)?;
            ensure!(names.insert(name.clone()), "Duplicate update path");
            ensure!(
                entry.unix_mode().is_none_or(|mode| mode & libc::S_IFMT == 0
                    || mode & libc::S_IFMT == libc::S_IFREG
                    || mode & libc::S_IFMT == libc::S_IFDIR),
                "Symlink or special file in update"
            );
            let destination = staging.join(&name);
            if entry.is_dir() {
                platform::private_directory(&destination)?;
                continue;
            }
            total = total
                .checked_add(entry.size())
                .context("Update size overflow")?;
            ensure!(
                entry.size() <= 512 * 1024 * 1024 && total <= 1536 * 1024 * 1024,
                "Update is too large"
            );
            platform::private_directory(destination.parent().context("Missing update directory")?)?;
            let mut file = platform::private_file(&destination)?;
            std::io::copy(&mut entry, &mut file)?;
            file.sync_all()?;
            if entry.unix_mode().is_some_and(|mode| mode & 0o111 != 0) {
                platform::executable(&destination)?;
            }
        }
        let candidate = bundle(&staging)?;
        ensure!(
            version(&candidate.version).context("Invalid bundle version")?
                > version(env!("CARGO_PKG_VERSION")).expect("compiled qcatch version"),
            "Update does not contain a newer version"
        );
        let status = Command::new(staging.join("qcatch"))
            .arg("--install")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()?;
        ensure!(
            status.status.success(),
            "qcatch update failed: {}",
            String::from_utf8_lossy(&status.stderr)
        );
        Ok(())
    })();
    fs::remove_dir_all(staging)?;
    result
}
