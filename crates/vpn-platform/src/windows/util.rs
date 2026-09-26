use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};

use vpn_core::PlatformError;
use vpn_types::ErrorKind;
use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, GetLastError, LocalFree};
use windows_sys::Win32::Networking::WinSock::{
    AF_INET, AF_INET6, IN6_ADDR, IN6_ADDR_0, IN_ADDR, IN_ADDR_0, SOCKADDR, SOCKADDR_IN, SOCKADDR_IN6,
    SOCKADDR_IN6_0, SOCKADDR_INET,
};
use windows_sys::Win32::System::Diagnostics::Debug::{
    FormatMessageW, FORMAT_MESSAGE_ALLOCATE_BUFFER, FORMAT_MESSAGE_FROM_SYSTEM, FORMAT_MESSAGE_IGNORE_INSERTS,
};

/// NUL-terminated UTF-16.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Reads a NUL-terminated UTF-16 string.
///
/// # Safety
/// `p` must be null or point to a NUL-terminated UTF-16 string.
pub unsafe fn from_wide(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut len = 0;
    while unsafe { *p.add(len) } != 0 {
        len += 1;
    }
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(p, len) })
}

pub fn from_wide_buf(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

pub fn last_error() -> u32 {
    unsafe { GetLastError() }
}

/// Human-readable Win32 error text, e.g. `Access is denied. (0x5)`.
pub fn describe_error(code: u32) -> String {
    let mut buf: *mut u16 = std::ptr::null_mut();
    let len = unsafe {
        FormatMessageW(
            FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
            std::ptr::null(),
            code,
            0,
            (&mut buf as *mut *mut u16) as *mut u16,
            0,
            std::ptr::null(),
        )
    };
    let text = if len > 0 && !buf.is_null() {
        let s = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(buf, len as usize) });
        unsafe { LocalFree(buf as _) };
        s.trim().to_string()
    } else {
        "Unknown error".to_string()
    };
    format!("{text} (0x{code:x})")
}

/// Classifies a Win32/WFP error for the user.
pub fn platform_error(kind: ErrorKind, what: &str, code: u32) -> PlatformError {
    let kind = if code == ERROR_ACCESS_DENIED { ErrorKind::PermissionDenied } else { kind };
    PlatformError::new(kind, format!("{what}: {}", describe_error(code)))
}

pub fn check(kind: ErrorKind, what: &str, code: u32) -> Result<(), PlatformError> {
    if code == 0 {
        Ok(())
    } else {
        Err(platform_error(kind, what, code))
    }
}

pub fn sockaddr_inet(addr: SocketAddr) -> SOCKADDR_INET {
    let mut out: SOCKADDR_INET = unsafe { std::mem::zeroed() };
    match addr {
        SocketAddr::V4(v4) => {
            out.Ipv4 = SOCKADDR_IN {
                sin_family: AF_INET,
                sin_port: v4.port().to_be(),
                sin_addr: in_addr(*v4.ip()),
                sin_zero: [0; 8],
            };
        }
        SocketAddr::V6(v6) => {
            out.Ipv6 = SOCKADDR_IN6 {
                sin6_family: AF_INET6,
                sin6_port: v6.port().to_be(),
                sin6_flowinfo: 0,
                sin6_addr: in6_addr(*v6.ip()),
                Anonymous: SOCKADDR_IN6_0 { sin6_scope_id: 0 },
            };
        }
    }
    out
}

pub fn in_addr(ip: Ipv4Addr) -> IN_ADDR {
    IN_ADDR { S_un: IN_ADDR_0 { S_addr: u32::from_ne_bytes(ip.octets()) } }
}

pub fn in6_addr(ip: Ipv6Addr) -> IN6_ADDR {
    IN6_ADDR { u: IN6_ADDR_0 { Byte: ip.octets() } }
}

/// # Safety
/// `sa` must be null or point to a valid `SOCKADDR_INET`.
pub unsafe fn from_sockaddr_inet(sa: &SOCKADDR_INET) -> Option<SocketAddr> {
    unsafe {
        match sa.si_family {
            AF_INET => {
                let v4 = sa.Ipv4;
                Some(SocketAddr::V4(SocketAddrV4::new(
                    Ipv4Addr::from(v4.sin_addr.S_un.S_addr.to_ne_bytes()),
                    u16::from_be(v4.sin_port),
                )))
            }
            AF_INET6 => {
                let v6 = sa.Ipv6;
                Some(SocketAddr::V6(SocketAddrV6::new(
                    Ipv6Addr::from(v6.sin6_addr.u.Byte),
                    u16::from_be(v6.sin6_port),
                    0,
                    0,
                )))
            }
            _ => None,
        }
    }
}

/// # Safety
/// `sa` must be null or point to a valid sockaddr of the length its family implies.
pub unsafe fn ip_from_sockaddr(sa: *const SOCKADDR) -> Option<IpAddr> {
    if sa.is_null() {
        return None;
    }
    unsafe {
        match (*sa).sa_family {
            AF_INET => {
                let v4 = &*(sa as *const SOCKADDR_IN);
                Some(IpAddr::V4(Ipv4Addr::from(v4.sin_addr.S_un.S_addr.to_ne_bytes())))
            }
            AF_INET6 => {
                let v6 = &*(sa as *const SOCKADDR_IN6);
                Some(IpAddr::V6(Ipv6Addr::from(v6.sin6_addr.u.Byte)))
            }
            _ => None,
        }
    }
}

pub fn guid_string(g: &GUID) -> String {
    format!(
        "{{{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}",
        g.data1, g.data2, g.data3, g.data4[0], g.data4[1], g.data4[2], g.data4[3], g.data4[4], g.data4[5], g.data4[6],
        g.data4[7]
    )
}

pub fn parse_guid(s: &str) -> Option<GUID> {
    let hex: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 32 {
        return None;
    }
    let v = u128::from_str_radix(&hex, 16).ok()?;
    Some(GUID::from_u128(v))
}

/// FILETIME (100 ns since 1601) → Unix milliseconds. 0 stays `None`.
pub fn filetime_to_unix_ms(ft: u64) -> Option<u64> {
    const EPOCH_DIFF_MS: u64 = 11_644_473_600_000;
    if ft == 0 {
        return None;
    }
    (ft / 10_000).checked_sub(EPOCH_DIFF_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guid_roundtrip() {
        let g = GUID::from_u128(0x0123_4567_89ab_cdef_0011_2233_4455_6677);
        let s = guid_string(&g);
        assert_eq!(s, "{01234567-89AB-CDEF-0011-223344556677}");
        let back = parse_guid(&s).unwrap();
        assert_eq!(guid_string(&back), s);
    }

    #[test]
    fn filetime_conversion() {
        // 2021-01-01T00:00:00Z
        assert_eq!(filetime_to_unix_ms(132_539_328_000_000_000), Some(1_609_459_200_000));
        assert_eq!(filetime_to_unix_ms(0), None);
    }

    #[test]
    fn sockaddr_roundtrip() {
        for a in ["185.65.134.10:51820", "[2a03:1b20::5]:51820"] {
            let addr: SocketAddr = a.parse().unwrap();
            let sa = sockaddr_inet(addr);
            assert_eq!(unsafe { from_sockaddr_inet(&sa) }, Some(addr));
        }
    }
}
