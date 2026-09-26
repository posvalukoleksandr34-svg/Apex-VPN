//! The service's private directory: `%ProgramData%\Meridian` on Windows,
//! `/var/lib/meridian` elsewhere. On Windows its ACL is reset to SYSTEM and
//! Administrators only, so the sealed device key, the settings and the
//! logs can't be read or planted by other users.

use std::path::{Path, PathBuf};

pub fn default_data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        base.join("Meridian")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("/var/lib/meridian")
    }
}

pub fn prepare(dir: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir.join("logs"))?;
    if is_privileged() {
        harden(dir)?;
    } else {
        // A development run without elevation: restricting the directory to
        // SYSTEM/Administrators would lock this very process out of it.
        eprintln!("warning: not elevated; {} is not access-restricted (development only)", dir.display());
    }
    Ok(())
}

/// Elevated administrator or SYSTEM (the installed service always is).
#[cfg(windows)]
pub fn is_privileged() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    let mut token: HANDLE = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return false;
    }
    let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut len = 0u32;
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
    };
    unsafe { CloseHandle(token) };
    ok != 0 && elevation.TokenIsElevated != 0
}

#[cfg(unix)]
pub fn is_privileged() -> bool {
    // SAFETY: geteuid has no preconditions.
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    unsafe { geteuid() == 0 }
}

#[cfg(windows)]
fn harden(dir: &Path) -> anyhow::Result<()> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        GetSecurityDescriptorDacl, ACL, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR,
    };

    // Protected DACL (no inheritance from ProgramData, which grants Users
    // read/create): SYSTEM and Administrators full control, inherited by
    // everything inside.
    let sddl: Vec<u16> = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)".encode_utf16().chain(Some(0)).collect();
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut sd, std::ptr::null_mut()) } == 0 {
        anyhow::bail!("building the data directory ACL failed: {}", std::io::Error::last_os_error());
    }
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl: *mut ACL = std::ptr::null_mut();
    unsafe { GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted) };
    let wpath: Vec<u16> = dir.to_string_lossy().encode_utf16().chain(Some(0)).collect();
    let rc = unsafe {
        SetNamedSecurityInfoW(
            wpath.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl,
            std::ptr::null(),
        )
    };
    unsafe { LocalFree(sd.cast()) };
    if rc != 0 {
        anyhow::bail!("could not restrict {} to SYSTEM and Administrators (error {rc})", dir.display());
    }
    Ok(())
}

#[cfg(unix)]
fn harden(dir: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}
