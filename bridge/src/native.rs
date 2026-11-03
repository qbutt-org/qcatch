use std::{
    ffi::OsString,
    io::{self, Read, Write},
    thread,
};

use anyhow::{Result, ensure};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(target_os = "linux")]
use linux::connect;
#[cfg(windows)]
use windows::connect;

const LIMIT: usize = 768 * 1024;

pub fn relay(arguments: &[OsString]) -> Result<()> {
    let expected = format!("chrome-extension://{}/", crate::EXTENSION_ID.trim());
    ensure!(
        arguments.iter().any(|arg| arg == expected.as_str()),
        "Unknown browser extension"
    );
    let home = crate::platform::data_home()?;
    #[cfg(windows)]
    std::fs::create_dir_all(&home)?;
    let control = crate::platform::Control::new(&home)?;
    if control.stopping(0)? {
        return Ok(());
    }
    thread::spawn(move || {
        // Relays own no downloads. The browser reconnects after installation.
        std::process::exit(if control.stopping(u32::MAX).unwrap_or(false) {
            0
        } else {
            1
        });
    });
    let connection = connect()?;
    let mut writer = connection.try_clone()?;
    thread::spawn(move || {
        let result = forward(io::stdin().lock(), &mut writer);
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    });
    forward(connection, io::stdout().lock())
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
