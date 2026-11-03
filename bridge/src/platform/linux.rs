use std::{
    env, fs, io,
    os::{
        fd::AsRawFd,
        unix::{
            fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};

static SHUTDOWN: AtomicBool = AtomicBool::new(false);

extern "C" fn shutdown_signal(_signal: libc::c_int) {
    SHUTDOWN.store(true, Ordering::Release);
}

pub fn user_home() -> Result<PathBuf> {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set")?;
    ensure!(home.is_absolute(), "HOME must be absolute");
    Ok(home)
}

pub fn xdg_directory(variable: &str, fallback: &str) -> Result<PathBuf> {
    match env::var_os(variable) {
        Some(value) => {
            let path = PathBuf::from(value);
            ensure!(path.is_absolute(), "{variable} must be absolute");
            Ok(path)
        }
        None => Ok(user_home()?.join(fallback)),
    }
}

pub fn data_home() -> Result<PathBuf> {
    Ok(xdg_directory("XDG_DATA_HOME", ".local/share")?.join("qcatch"))
}

pub fn desktop() -> Result<PathBuf> {
    let home = user_home()?;
    let config = xdg_directory("XDG_CONFIG_HOME", ".config")?.join("user-dirs.dirs");
    if let Ok(text) = fs::read_to_string(config) {
        for line in text.lines() {
            if let Some(value) = line
                .trim()
                .strip_prefix("XDG_DESKTOP_DIR=\"")
                .and_then(|v| v.strip_suffix('"'))
            {
                let value = value
                    .strip_prefix("$HOME/")
                    .map(|v| home.join(v))
                    .unwrap_or_else(|| PathBuf::from(value));
                ensure!(value.is_absolute(), "Invalid XDG Desktop directory");
                fs::create_dir_all(&value)?;
                return Ok(value);
            }
        }
    }
    let path = home.join("Desktop");
    fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn private_directory(path: &Path) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    check_private(path, true)?;
    Ok(())
}

pub fn check_private(path: &Path, directory: bool) -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0
            && !metadata.is_symlink()
            && if directory {
                metadata.is_dir()
            } else {
                metadata.nlink() == 1
            },
        "Unsafe private path: {}",
        path.display()
    );
    Ok(metadata)
}

pub fn executable(path: &Path) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

pub fn same_path(left: &Path, right: &Path) -> bool {
    fs::canonicalize(left)
        .ok()
        .zip(fs::canonicalize(right).ok())
        .is_some_and(|(a, b)| a == b)
}

pub fn replace_file(source: &Path, destination: &Path) -> Result<()> {
    fs::rename(source, destination)?;
    Ok(())
}

pub fn move_new_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub fn reveal_file(path: &Path) -> Result<()> {
    ensure!(path.is_file(), "downloaded file no longer exists");
    let uri = url::Url::from_file_path(path).map_err(|_| anyhow::anyhow!("Invalid file path"))?;
    super::desktop::show(uri.as_str())
}

pub fn download_command(command: &mut Command) {
    let parent = std::process::id() as libc::pid_t;
    unsafe {
        command.pre_exec(move || {
            if libc::setpgid(0, 0) != 0 || libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::getppid() != parent {
                return Err(io::Error::other("qcatch exited before its tool started"));
            }
            Ok(())
        });
    }
}

pub fn lease(path: &Path, create: bool) -> io::Result<fs::File> {
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(create)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(file)
}

pub struct Control {
    lock: fs::File,
    stop: PathBuf,
}

impl Control {
    pub fn new(home: &Path) -> Result<Self> {
        private_directory(home)?;
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = shutdown_signal as usize;
            libc::sigemptyset(&mut action.sa_mask);
            ensure!(
                libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut()) == 0
                    && libc::sigaction(libc::SIGINT, &action, std::ptr::null_mut()) == 0,
                "Cannot register shutdown signals"
            );
        }
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(home.join("bridge.lock"))?;
        ensure!(
            check_private(&home.join("bridge.lock"), false)?.is_file(),
            "Invalid bridge lock file"
        );
        Ok(Self {
            lock,
            stop: home.join("bridge.stop"),
        })
    }

    pub fn lock(&self, timeout: u32) -> Result<Option<MutexGuard<'_>>> {
        let started = Instant::now();
        loop {
            if unsafe { libc::flock(self.lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                return Ok(Some(MutexGuard(&self.lock)));
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::WouldBlock {
                return Err(error.into());
            }
            if started.elapsed() >= Duration::from_millis(timeout.into()) {
                return Ok(None);
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    pub fn request_stop(&self) -> Result<()> {
        match super::private_file(&self.stop) {
            Ok(file) => file.sync_all()?,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                ensure!(
                    check_private(&self.stop, false)?.is_file(),
                    "Invalid bridge stop file"
                );
            }
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }

    pub fn stop(&self) -> Result<MutexGuard<'_>> {
        self.request_stop()?;
        self.lock(15_000)?
            .context("bridge did not stop within 15 seconds")
    }

    pub fn reset(&self) -> Result<()> {
        match fs::remove_file(&self.stop) {
            Ok(()) => (),
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
        Ok(())
    }

    pub fn stopping(&self, timeout: u32) -> Result<bool> {
        let started = Instant::now();
        loop {
            if SHUTDOWN.load(Ordering::Acquire) {
                return Ok(true);
            }
            if self.stop.try_exists()? {
                ensure!(
                    check_private(&self.stop, false)?.is_file(),
                    "Invalid bridge stop file"
                );
                return Ok(true);
            }
            if timeout != u32::MAX && started.elapsed() >= Duration::from_millis(timeout.into()) {
                return Ok(false);
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}

pub struct MutexGuard<'a>(&'a fs::File);
impl Drop for MutexGuard<'_> {
    fn drop(&mut self) {
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}

pub struct Job(libc::pid_t);
impl Job {
    pub fn new(child: &Child) -> Result<Self> {
        let pid = child.id() as libc::pid_t;
        ensure!(
            unsafe { libc::getpgid(pid) } == pid,
            "Download tool has no private process group"
        );
        Ok(Self(pid))
    }
    pub fn terminate(&self) -> Result<()> {
        if unsafe { libc::kill(-self.0, libc::SIGKILL) } != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error.into());
            }
        }
        Ok(())
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}
