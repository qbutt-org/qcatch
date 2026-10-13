use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::PathBuf,
    thread,
};

use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use windows::Win32::{
    Foundation::{ERROR_BROKEN_PIPE, ERROR_IO_PENDING, HANDLE},
    Storage::FileSystem::{FILE_FLAG_OVERLAPPED, ReadFile, WriteFile},
    System::{
        IO::{GetOverlappedResult, OVERLAPPED},
        Threading::CreateEventW,
    },
    UI::Shell::FOLDERID_LocalAppData,
};

use crate::{EXTENSION_ID, platform};

const LIMIT: usize = 768 * 1024;

#[derive(Deserialize)]
struct Discovery {
    pipe: String,
}

pub fn relay(arguments: &[OsString]) -> Result<()> {
    let expected_origin = format!("chrome-extension://{}/", EXTENSION_ID.trim());
    ensure!(
        arguments.iter().any(|arg| arg == expected_origin.as_str()),
        "Unknown browser extension"
    );

    let home = platform::known_folder(&FOLDERID_LocalAppData)?.join("qcatch");
    fs::create_dir_all(&home)?;
    let control = platform::Control::new(&home)?;
    if control.stopping(0)? {
        return Ok(());
    }
    thread::spawn(move || {
        // A relay owns no downloads. The browser reconnects after installation.
        let code = match control.stopping(u32::MAX) {
            Ok(true) => 0,
            _ => 1,
        };
        std::process::exit(code);
    });

    let discovery = std::env::var_os("QBUTT_BROWSER_BRIDGE_DISCOVERY")
        .map(PathBuf::from)
        .unwrap_or(
            platform::known_folder(&FOLDERID_LocalAppData)?
                .join("qbutt/content/browser-bridge.json"),
        );
    let bytes = fs::read(discovery).context("qbutt browser connection is not running")?;
    ensure!(bytes.len() <= 8192, "Invalid browser discovery");
    let discovery: Discovery = serde_json::from_slice(&bytes)?;
    let suffix = discovery
        .pipe
        .strip_prefix(r"\\.\pipe\qbutt-content-browser-")
        .context("Invalid browser connection endpoint")?;
    ensure!(
        uuid::Uuid::parse_str(suffix).is_ok(),
        "Invalid browser connection endpoint"
    );
    let pipe = Pipe(
        OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(FILE_FLAG_OVERLAPPED.0)
            .open(discovery.pipe)?,
    );
    let mut writer = Pipe(pipe.0.try_clone()?);
    thread::spawn(move || {
        let result = forward(io::stdin().lock(), &mut writer);
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    });
    forward(pipe, io::stdout().lock())
}

// Each direction has its own OVERLAPPED event; a pending read cannot block writes.
struct Pipe(fs::File);

impl Pipe {
    fn transfer(&self, read: Option<&mut [u8]>, write: Option<&[u8]>) -> io::Result<usize> {
        let event = unsafe { CreateEventW(None, true, false, None) }.map_err(io::Error::from)?;
        let _event = unsafe { OwnedHandle::from_raw_handle(event.0) };
        let mut overlapped = OVERLAPPED {
            hEvent: event,
            ..Default::default()
        };
        let file = HANDLE(self.0.as_raw_handle());
        let reading = read.is_some();
        let result = unsafe {
            match read {
                Some(buffer) => ReadFile(file, Some(buffer), None, Some(&mut overlapped)),
                None => WriteFile(file, write, None, Some(&mut overlapped)),
            }
        };
        if let Err(error) = result {
            if reading && error.code() == ERROR_BROKEN_PIPE.to_hresult() {
                return Ok(0);
            }
            if error.code() != ERROR_IO_PENDING.to_hresult() {
                return Err(error.into());
            }
        }
        let mut transferred = 0;
        match unsafe { GetOverlappedResult(file, &overlapped, &mut transferred, true) } {
            Ok(()) => Ok(transferred as usize),
            Err(error) if reading && error.code() == ERROR_BROKEN_PIPE.to_hresult() => Ok(0),
            Err(error) => Err(error.into()),
        }
    }
}

impl Read for Pipe {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.transfer(Some(buffer), None)
    }
}

impl Write for Pipe {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.transfer(None, Some(buffer))
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn forward(mut input: impl Read, mut output: impl Write) -> Result<()> {
    loop {
        let mut header = [0; 4];
        match input.read(&mut header[..1])? {
            0 => return Ok(()),
            1 => input.read_exact(&mut header[1..])?,
            _ => unreachable!(),
        }
        let size = u32::from_le_bytes(header) as usize;
        ensure!(
            size > 0 && size <= LIMIT,
            "Browser message exceeds the limit"
        );
        let mut body = vec![0; size];
        input.read_exact(&mut body)?;
        let _: serde_json::Value = serde_json::from_slice(&body)?;
        output.write_all(&header)?;
        output.write_all(&body)?;
        output.flush()?;
    }
}
