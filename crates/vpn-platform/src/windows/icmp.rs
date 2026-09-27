//! ICMP echo via the IP Helper API (no raw sockets, no admin needed for the
//! latency pings).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use vpn_core::Pinger;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::NetworkManagement::IpHelper::{
    Icmp6CreateFile, Icmp6SendEcho2, IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho2Ex, ICMPV6_ECHO_REPLY_LH,
    ICMP_ECHO_REPLY,
};
use windows_sys::Win32::Networking::WinSock::{AF_INET6, SOCKADDR_IN6, SOCKADDR_IN6_0};

use super::util::in6_addr;

const PAYLOAD: &[u8; 16] = b"apexy-probe.....";

#[derive(Debug)]
pub struct EchoError(pub String);

/// One echo request. `source` pins the source address (the tunnel address
/// for probes through the tunnel); `None` lets routing decide.
pub fn echo(source: Option<IpAddr>, target: IpAddr, timeout: Duration) -> Result<Duration, EchoError> {
    let timeout_ms = timeout.as_millis().clamp(1, u32::MAX as u128) as u32;
    let started = Instant::now();
    let rtt_ms = match target {
        IpAddr::V4(t) => {
            let src = match source {
                Some(IpAddr::V4(s)) => s,
                _ => Ipv4Addr::UNSPECIFIED,
            };
            echo_v4(src, t, timeout_ms)?
        }
        IpAddr::V6(t) => echo_v6(t, timeout_ms)?,
    };
    // The API reports whole milliseconds (0 for sub-ms); use our own clock
    // when it's finer.
    let measured = started.elapsed();
    Ok(if rtt_ms == 0 { measured.min(Duration::from_millis(1)) } else { Duration::from_millis(rtt_ms as u64) })
}

fn echo_v4(source: Ipv4Addr, target: Ipv4Addr, timeout_ms: u32) -> Result<u32, EchoError> {
    let h = unsafe { IcmpCreateFile() };
    if h == INVALID_HANDLE_VALUE {
        return Err(EchoError("IcmpCreateFile failed".into()));
    }
    let mut reply = vec![0u8; std::mem::size_of::<ICMP_ECHO_REPLY>() + PAYLOAD.len() + 8 + 64];
    let n = unsafe {
        IcmpSendEcho2Ex(
            h,
            std::ptr::null_mut(),
            None,
            std::ptr::null(),
            u32::from_ne_bytes(source.octets()),
            u32::from_ne_bytes(target.octets()),
            PAYLOAD.as_ptr().cast(),
            PAYLOAD.len() as u16,
            std::ptr::null(),
            reply.as_mut_ptr().cast(),
            reply.len() as u32,
            timeout_ms,
        )
    };
    unsafe { IcmpCloseHandle(h) };
    if n == 0 {
        return Err(EchoError(format!("no reply (error {})", super::util::last_error())));
    }
    let r = unsafe { std::ptr::read_unaligned(reply.as_ptr() as *const ICMP_ECHO_REPLY) };
    if r.Status != 0 {
        return Err(EchoError(format!("ICMP status {}", r.Status)));
    }
    Ok(r.RoundTripTime)
}

fn echo_v6(target: Ipv6Addr, timeout_ms: u32) -> Result<u32, EchoError> {
    let h = unsafe { Icmp6CreateFile() };
    if h == INVALID_HANDLE_VALUE {
        return Err(EchoError("Icmp6CreateFile failed".into()));
    }
    let any = SOCKADDR_IN6 {
        sin6_family: AF_INET6,
        sin6_port: 0,
        sin6_flowinfo: 0,
        sin6_addr: in6_addr(Ipv6Addr::UNSPECIFIED),
        Anonymous: SOCKADDR_IN6_0 { sin6_scope_id: 0 },
    };
    let dest = SOCKADDR_IN6 { sin6_addr: in6_addr(target), ..any };
    let mut reply = vec![0u8; std::mem::size_of::<ICMPV6_ECHO_REPLY_LH>() + PAYLOAD.len() + 8 + 64];
    let n = unsafe {
        Icmp6SendEcho2(
            h,
            std::ptr::null_mut(),
            None,
            std::ptr::null(),
            &any,
            &dest,
            PAYLOAD.as_ptr().cast(),
            PAYLOAD.len() as u16,
            std::ptr::null(),
            reply.as_mut_ptr().cast(),
            reply.len() as u32,
            timeout_ms,
        )
    };
    unsafe { IcmpCloseHandle(h) };
    if n == 0 {
        return Err(EchoError(format!("no reply (error {})", super::util::last_error())));
    }
    let r = unsafe { std::ptr::read_unaligned(reply.as_ptr() as *const ICMPV6_ECHO_REPLY_LH) };
    if r.Status != 0 {
        return Err(EchoError(format!("ICMPv6 status {}", r.Status)));
    }
    Ok(r.RoundTripTime)
}

pub struct IcmpPinger;

#[async_trait]
impl Pinger for IcmpPinger {
    async fn ping(&self, target: IpAddr, timeout: Duration) -> Option<Duration> {
        tokio::task::spawn_blocking(move || echo(None, target, timeout).ok()).await.ok().flatten()
    }
}
