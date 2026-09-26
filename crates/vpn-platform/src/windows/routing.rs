//! Read-only routing queries for diagnostics.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use vpn_types::ipc::RouteSummary;
use windows_sys::Win32::NetworkManagement::IpHelper::{
    ConvertInterfaceLuidToAlias, FreeMibTable, GetBestRoute2, GetIpForwardTable2, MIB_IPFORWARD_ROW2,
    MIB_IPFORWARD_TABLE2,
};
use windows_sys::Win32::NetworkManagement::Ndis::NET_LUID_LH;
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6, SOCKADDR_INET};

use super::util::{from_sockaddr_inet, from_wide_buf, sockaddr_inet};

/// LUID of the interface Windows would use to reach `dest` right now.
pub fn best_route_luid(dest: IpAddr) -> Option<u64> {
    let dest = sockaddr_inet(SocketAddr::new(dest, 0));
    let mut row: MIB_IPFORWARD_ROW2 = unsafe { std::mem::zeroed() };
    let mut source: SOCKADDR_INET = unsafe { std::mem::zeroed() };
    let rc = unsafe { GetBestRoute2(std::ptr::null(), 0, std::ptr::null(), &dest, 0, &mut row, &mut source) };
    (rc == 0).then(|| unsafe { row.InterfaceLuid.Value })
}

/// Routes installed on the interface with this LUID.
pub fn routes_on(luid: u64) -> Vec<RouteSummary> {
    let alias = interface_alias(luid);
    let mut out = Vec::new();
    for family in [AF_INET, AF_INET6] {
        let mut table: *mut MIB_IPFORWARD_TABLE2 = std::ptr::null_mut();
        if unsafe { GetIpForwardTable2(family, &mut table) } != 0 || table.is_null() {
            continue;
        }
        let n = unsafe { (*table).NumEntries } as usize;
        let rows = unsafe { std::slice::from_raw_parts((*table).Table.as_ptr(), n) };
        for r in rows.iter().filter(|r| unsafe { r.InterfaceLuid.Value } == luid) {
            let Some(prefix) = (unsafe { from_sockaddr_inet(&r.DestinationPrefix.Prefix) }) else { continue };
            // Skip the host/multicast/broadcast routes Windows adds itself.
            let ip = prefix.ip();
            if ip.is_multicast() || ip == IpAddr::V4(Ipv4Addr::BROADCAST) || ip == IpAddr::V6(Ipv6Addr::UNSPECIFIED) && r.DestinationPrefix.PrefixLength != 0 {
                continue;
            }
            out.push(RouteSummary {
                destination: format!("{}/{}", ip, r.DestinationPrefix.PrefixLength),
                interface: alias.clone(),
                metric: r.Metric,
            });
        }
        unsafe { FreeMibTable(table.cast()) };
    }
    out
}

fn interface_alias(luid: u64) -> String {
    let mut buf = [0u16; 257];
    let rc = unsafe { ConvertInterfaceLuidToAlias(&NET_LUID_LH { Value: luid }, buf.as_mut_ptr(), buf.len()) };
    if rc == 0 { from_wide_buf(&buf) } else { format!("luid {luid}") }
}
