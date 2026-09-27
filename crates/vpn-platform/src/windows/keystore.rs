//! Machine-bound secret sealing with DPAPI. The sealed file also sits in a
//! directory only SYSTEM and Administrators can read (set by the service).

use vpn_core::{PlatformError, PlatformResult};
use vpn_types::ErrorKind;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};
use zeroize::Zeroizing;

use super::util::{last_error, platform_error};
use crate::SecretStore;

const ENTROPY: &[u8] = b"apexy/device-key/v1";

pub struct DpapiStore;

fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
}

impl SecretStore for DpapiStore {
    fn seal(&self, plaintext: &[u8]) -> PlatformResult<Vec<u8>> {
        let (input, entropy) = (blob(plaintext), blob(ENTROPY));
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err(platform_error(ErrorKind::Internal, "sealing the device key", last_error()));
        }
        let sealed = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
        unsafe { LocalFree(out.pbData.cast()) };
        Ok(sealed)
    }

    fn open(&self, sealed: &[u8]) -> PlatformResult<Zeroizing<Vec<u8>>> {
        let (input, entropy) = (blob(sealed), blob(ENTROPY));
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err(PlatformError::new(ErrorKind::ConfigurationCorrupted, "the device key could not be unsealed"));
        }
        let plain = unsafe { std::slice::from_raw_parts_mut(out.pbData, out.cbData as usize) };
        let copy = Zeroizing::new(plain.to_vec());
        zeroize::Zeroize::zeroize(plain);
        unsafe { LocalFree(out.pbData.cast()) };
        Ok(copy)
    }
}
