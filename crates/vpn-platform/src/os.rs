use vpn_types::{OsFamily, OsInfo};

pub fn info() -> OsInfo {
    OsInfo { family: family(), version: version(), arch: std::env::consts::ARCH.to_string() }
}

fn family() -> OsFamily {
    match std::env::consts::OS {
        "windows" => OsFamily::Windows,
        "macos" => OsFamily::Macos,
        "linux" => OsFamily::Linux,
        _ => OsFamily::Other,
    }
}

#[cfg(windows)]
fn version() -> String {
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    // GetVersionEx lies to unmanifested binaries; RtlGetVersion doesn't.
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlGetVersion(info: *mut OSVERSIONINFOW) -> i32;
    }
    let mut v: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    v.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    if unsafe { RtlGetVersion(&mut v) } == 0 {
        format!("{}.{}.{}", v.dwMajorVersion, v.dwMinorVersion, v.dwBuildNumber)
    } else {
        "unknown".into()
    }
}

#[cfg(not(windows))]
fn version() -> String {
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.strip_prefix("PRETTY_NAME=").map(|v| v.trim_matches('"').to_string()))
        })
        .unwrap_or_else(|| "unknown".into())
}

/// Windows build number, for feature gates (e.g. `SetInterfaceDnsSettings`
/// needs build 19041).
pub fn windows_build() -> Option<u32> {
    let v = version();
    let mut parts = v.split('.');
    let (_, _, build) = (parts.next()?, parts.next()?, parts.next()?);
    build.parse().ok()
}
