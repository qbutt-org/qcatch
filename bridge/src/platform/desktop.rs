use std::{
    ffi::{CStr, CString, c_char, c_int, c_void},
    ptr,
};

use anyhow::{Result, bail};

#[repr(C)]
struct GError {
    domain: u32,
    code: c_int,
    message: *mut c_char,
}

#[link(name = "gio-2.0")]
unsafe extern "C" {
    fn g_app_info_get_default_for_uri_scheme(scheme: *const c_char) -> *mut c_void;
    fn g_app_info_get_executable(application: *mut c_void) -> *const c_char;
    fn g_bus_get_sync(
        kind: c_int,
        cancellable: *mut c_void,
        error: *mut *mut GError,
    ) -> *mut c_void;
    fn g_dbus_connection_call_sync(
        connection: *mut c_void,
        bus: *const c_char,
        path: *const c_char,
        interface: *const c_char,
        method: *const c_char,
        parameters: *mut c_void,
        reply_type: *const c_void,
        flags: c_int,
        timeout: c_int,
        cancellable: *mut c_void,
        error: *mut *mut GError,
    ) -> *mut c_void;
}

pub fn default_browser_executable() -> Option<std::path::PathBuf> {
    let application = unsafe { g_app_info_get_default_for_uri_scheme(c"https".as_ptr()) };
    if application.is_null() {
        return None;
    }
    let executable = unsafe { g_app_info_get_executable(application) };
    let path = if executable.is_null() {
        None
    } else {
        Some(std::path::PathBuf::from(
            unsafe { CStr::from_ptr(executable) }
                .to_string_lossy()
                .as_ref(),
        ))
    };
    unsafe { g_object_unref(application) };
    path
}

#[link(name = "glib-2.0")]
unsafe extern "C" {
    fn g_variant_new(format: *const c_char, ...) -> *mut c_void;
    fn g_variant_unref(variant: *mut c_void);
    fn g_error_free(error: *mut GError);
}

#[link(name = "gobject-2.0")]
unsafe extern "C" {
    fn g_object_unref(object: *mut c_void);
}

pub fn show(uri: &str) -> Result<()> {
    let uri = CString::new(uri)?;
    let mut error = ptr::null_mut();
    // G_BUS_TYPE_SESSION. GIO owns the shared bus connection; release our reference.
    let bus = unsafe { g_bus_get_sync(2, ptr::null_mut(), &mut error) };
    if bus.is_null() {
        return failure(error);
    }
    let uris = [uri.as_ptr(), ptr::null()];
    let parameters = unsafe { g_variant_new(c"(^ass)".as_ptr(), uris.as_ptr(), c"".as_ptr()) };
    // call_sync consumes the floating parameters variant, including on an error.
    let reply = unsafe {
        g_dbus_connection_call_sync(
            bus,
            c"org.freedesktop.FileManager1".as_ptr(),
            c"/org/freedesktop/FileManager1".as_ptr(),
            c"org.freedesktop.FileManager1".as_ptr(),
            c"ShowItems".as_ptr(),
            parameters,
            ptr::null(),
            0,
            3000,
            ptr::null_mut(),
            &mut error,
        )
    };
    unsafe { g_object_unref(bus) };
    if reply.is_null() {
        return failure(error);
    }
    unsafe { g_variant_unref(reply) };
    Ok(())
}

fn failure(error: *mut GError) -> Result<()> {
    let message = if error.is_null() {
        "The desktop file manager did not respond".into()
    } else {
        let message = unsafe { CStr::from_ptr((*error).message) }
            .to_string_lossy()
            .into_owned();
        unsafe { g_error_free(error) };
        message
    };
    bail!("Could not reveal the downloaded file: {message}")
}
