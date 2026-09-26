//! Installed desktop applications from the Uninstall registry keys (machine
//! and user, 64- and 32-bit views). An entry is kept only if it points at
//! an existing .exe.

use std::collections::BTreeSet;

use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
    KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY, RRF_RT_REG_SZ,
};

use super::util::{from_wide_buf, wide};
use crate::apps::InstalledApp;

const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";

pub fn installed() -> Vec<InstalledApp> {
    let mut seen = BTreeSet::new();
    for (root, view) in [
        (HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY),
        (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY),
        (HKEY_CURRENT_USER, 0),
    ] {
        for app in scan(root, view) {
            seen.insert(app);
        }
    }
    let mut apps: Vec<InstalledApp> = seen.into_iter().collect();
    apps.sort_by_key(|a| a.name.to_lowercase());
    apps.dedup_by(|a, b| a.path.eq_ignore_ascii_case(&b.path));
    apps
}

fn scan(root: HKEY, view: u32) -> Vec<InstalledApp> {
    let mut out = Vec::new();
    let path = wide(UNINSTALL);
    let mut key: HKEY = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(root, path.as_ptr(), 0, KEY_READ | view, &mut key) } != ERROR_SUCCESS {
        return out;
    }
    let mut index = 0;
    loop {
        let mut name = [0u16; 256];
        let mut len = name.len() as u32;
        let rc = unsafe {
            RegEnumKeyExW(key, index, name.as_mut_ptr(), &mut len, std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut())
        };
        if rc != ERROR_SUCCESS {
            break;
        }
        index += 1;
        let sub = &name[..len as usize + 1];
        let display = read_string(key, sub, "DisplayName");
        let icon = read_string(key, sub, "DisplayIcon");
        if let (Some(display), Some(icon)) = (display, icon) {
            if let Some(exe) = exe_from_icon(&icon) {
                out.push(InstalledApp { name: display, path: exe });
            }
        }
    }
    unsafe { RegCloseKey(key) };
    out
}

fn read_string(key: HKEY, subkey: &[u16], value: &str) -> Option<String> {
    let value = wide(value);
    let mut buf = [0u16; 1024];
    let mut size = (buf.len() * 2) as u32;
    let rc = unsafe {
        RegGetValueW(key, subkey.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size)
    };
    (rc == ERROR_SUCCESS).then(|| from_wide_buf(&buf)).filter(|s| !s.trim().is_empty())
}

/// `"C:\Program Files\App\app.exe",0` → `C:\Program Files\App\app.exe`
fn exe_from_icon(icon: &str) -> Option<String> {
    let trimmed = icon.trim();
    let path = match trimmed.rsplit_once(',') {
        Some((p, idx)) if idx.trim().parse::<i32>().is_ok() => p,
        _ => trimmed,
    };
    let path = path.trim().trim_matches('"');
    (path.to_lowercase().ends_with(".exe") && std::path::Path::new(path).is_file()).then(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_display_icon() {
        let exe = std::env::current_exe().unwrap().to_string_lossy().into_owned();
        assert_eq!(exe_from_icon(&format!("\"{exe}\",0")), Some(exe.clone()));
        assert_eq!(exe_from_icon(&exe), Some(exe));
        assert_eq!(exe_from_icon(r"C:\nope\missing.exe"), None);
        assert_eq!(exe_from_icon(r"C:\Windows\icon.ico"), None);
    }
}
