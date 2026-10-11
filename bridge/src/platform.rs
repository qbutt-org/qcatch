use std::{
    ffi::{OsStr, OsString},
    fs,
    io::Write,
    marker::PhantomData,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    process::Child,
    rc::Rc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};
use windows::{
    Win32::{
        Foundation::{HANDLE, HWND, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
        Storage::FileSystem::{MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW},
        System::{
            Com::{
                CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
                CoTaskMemFree, CoUninitialize,
            },
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
                Thread32Next,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject, TerminateJobObject,
            },
            Threading::{
                CreateEventW, CreateMutexW, OpenThread, ReleaseMutex, ResetEvent, ResumeThread,
                SetEvent, THREAD_SUSPEND_RESUME, WaitForSingleObject,
            },
            Variant::VARIANT,
        },
        UI::{
            Shell::{
                ILFree, IShellWindows, IWebBrowser2, SHGetKnownFolderPath,
                SHOpenFolderAndSelectItems, SHParseDisplayName, ShellWindows,
            },
            WindowsAndMessaging::{
                MB_ICONERROR, MB_OK, MessageBoxW, SW_RESTORE, SetForegroundWindow, ShowWindow,
                SwitchToThisWindow,
            },
        },
    },
    core::{GUID, Interface, PCWSTR, w},
};

pub fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

pub fn known_folder(id: &GUID) -> Result<PathBuf> {
    let value = unsafe { SHGetKnownFolderPath(id, Default::default(), None) }?;
    let path = unsafe { OsString::from_wide(value.as_wide()) };
    unsafe { CoTaskMemFree(Some(value.0.cast())) };
    Ok(path.into())
}

pub fn same_path(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => {
            left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
        }
        _ => false,
    }
}

pub fn replace_file(source: &Path, destination: &Path) -> Result<()> {
    unsafe {
        MoveFileExW(
            PCWSTR(wide(source).as_ptr()),
            PCWSTR(wide(destination).as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )?;
    }
    Ok(())
}

pub fn move_new_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    unsafe {
        MoveFileExW(
            PCWSTR(wide(source).as_ptr()),
            PCWSTR(wide(destination).as_ptr()),
            MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| std::io::Error::from_raw_os_error(error.code().0 & 0xffff))
}

pub fn log_error(home: &Path, error: &str) {
    let _ = (|| -> Result<()> {
        fs::create_dir_all(home)?;
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
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?
            .write_all(entry.as_bytes())?;
        Ok(())
    })();
}

pub fn reveal_file(path: &Path) -> Result<()> {
    anyhow::ensure!(path.is_file(), "downloaded file no longer exists");
    let _com = ComApartment::new()?;
    let mut item = std::ptr::null_mut();
    unsafe { SHParseDisplayName(PCWSTR(wide(path).as_ptr()), None, &mut item, 0, None) }?;
    let result = unsafe { SHOpenFolderAndSelectItems(item, None, 0) };
    unsafe { ILFree(Some(item)) };
    result.context("show downloaded file in Explorer")?;

    let folder = path.parent().context("output folder missing")?;
    let shell: IShellWindows = unsafe { CoCreateInstance(&ShellWindows, None, CLSCTX_ALL) }?;
    for _ in 0..10 {
        for index in 0..unsafe { shell.Count()? } {
            let Ok(window) = (unsafe { shell.Item(&VARIANT::from(index)) }) else {
                continue;
            };
            let Ok(browser) = window.cast::<IWebBrowser2>() else {
                continue;
            };
            let Ok(location) = (unsafe { browser.LocationURL() }) else {
                continue;
            };
            let Ok(url) = url::Url::parse(&location.to_string()) else {
                continue;
            };
            let Ok(open_folder) = url.to_file_path() else {
                continue;
            };
            if same_path(folder, &open_folder) {
                let hwnd = HWND(unsafe { browser.HWND()? }.0 as *mut _);
                unsafe {
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                    if !SetForegroundWindow(hwnd).as_bool() {
                        // Background bridge processes cannot normally activate an existing window.
                        SwitchToThisWindow(hwnd, false);
                    }
                }
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    anyhow::bail!("Explorer opened, but its window could not be found")
}

pub fn show_error(message: &str) {
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(wide(message).as_ptr()),
            w!("qcatch"),
            MB_OK | MB_ICONERROR,
        );
    }
}

pub struct ComApartment;

impl ComApartment {
    pub fn new() -> Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }?;
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub struct Control {
    mutex: OwnedHandle,
    stop: OwnedHandle,
}

impl Control {
    pub fn new(data_dir: &Path) -> Result<Self> {
        let identity = fs::canonicalize(data_dir)
            .context("resolve bridge data directory")?
            .to_string_lossy()
            .to_lowercase();
        let name = format!("Local\\qcatch.{:x}", Sha256::digest(identity.as_bytes()));
        unsafe {
            Ok(Self {
                mutex: OwnedHandle::from_raw_handle(
                    CreateMutexW(None, false, PCWSTR(wide(&name).as_ptr()))?.0,
                ),
                stop: OwnedHandle::from_raw_handle(
                    CreateEventW(
                        None,
                        true,
                        false,
                        PCWSTR(wide(format!("{name}.stop")).as_ptr()),
                    )?
                    .0,
                ),
            })
        }
    }

    pub fn lock(&self, timeout: u32) -> Result<Option<MutexGuard<'_>>> {
        MutexGuard::acquire(&self.mutex, timeout)
    }

    pub fn stop(&self) -> Result<MutexGuard<'_>> {
        unsafe { SetEvent(HANDLE(self.stop.as_raw_handle())) }?;
        self.lock(15_000)?
            .ok_or_else(|| anyhow::anyhow!("bridge did not stop within 15 seconds"))
    }

    pub fn reset(&self) -> Result<()> {
        unsafe {
            ResetEvent(HANDLE(self.stop.as_raw_handle()))?;
        }
        Ok(())
    }

    pub fn stopping(&self, timeout: u32) -> Result<bool> {
        wait(&self.stop, timeout)
    }
}

fn wait(handle: &OwnedHandle, timeout: u32) -> Result<bool> {
    match unsafe { WaitForSingleObject(HANDLE(handle.as_raw_handle()), timeout) } {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        _ => Err(std::io::Error::last_os_error().into()),
    }
}

pub struct MutexGuard<'a> {
    handle: &'a OwnedHandle,
    // Windows mutexes must be released on the thread that acquired them.
    _thread: PhantomData<Rc<()>>,
}

impl<'a> MutexGuard<'a> {
    fn acquire(handle: &'a OwnedHandle, timeout: u32) -> Result<Option<Self>> {
        match unsafe { WaitForSingleObject(HANDLE(handle.as_raw_handle()), timeout) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Some(Self {
                handle,
                _thread: PhantomData,
            })),
            WAIT_TIMEOUT => Ok(None),
            _ => bail!("wait for mutex: {}", std::io::Error::last_os_error()),
        }
    }
}

impl Drop for MutexGuard<'_> {
    fn drop(&mut self) {
        let _ = unsafe { ReleaseMutex(HANDLE(self.handle.as_raw_handle())) };
    }
}

pub struct Job(OwnedHandle);

pub fn resume_child(child: &Child) -> Result<()> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }?;
    let _snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot.0) };
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    unsafe { Thread32First(snapshot, &mut entry) }?;
    loop {
        if entry.th32OwnerProcessID == child.id() {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) }?;
            let _thread = unsafe { OwnedHandle::from_raw_handle(thread.0) };
            anyhow::ensure!(
                unsafe { ResumeThread(thread) } != u32::MAX,
                "resume child process: {}",
                std::io::Error::last_os_error()
            );
            return Ok(());
        }
        unsafe { Thread32Next(snapshot, &mut entry) }
            .context("suspended child thread was not found")?;
    }
}

impl Job {
    pub fn new(child: &Child) -> Result<Self> {
        let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }?;
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle.0) });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )?;
            AssignProcessToJobObject(handle, HANDLE(child.as_raw_handle()))?;
        }
        Ok(job)
    }

    pub fn terminate(&self) -> Result<()> {
        unsafe { TerminateJobObject(HANDLE(self.0.as_raw_handle()), 1) }?;
        Ok(())
    }
}
