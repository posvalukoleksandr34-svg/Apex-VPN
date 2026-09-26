//! Read-only routing queries (diagnostics, connection report).

use std::net::IpAddr;

use vpn_types::ipc::RouteSummary;

/// Interface (LUID on Windows) that currently carries traffic to `dest`.
pub fn best_route_luid(dest: IpAddr) -> Option<u64> {
    #[cfg(windows)]
    {
        crate::windows::routing::best_route_luid(dest)
    }
    #[cfg(not(windows))]
    {
        let _ = dest;
        None
    }
}

pub fn routes_on(luid: u64) -> Vec<RouteSummary> {
    #[cfg(windows)]
    {
        crate::windows::routing::routes_on(luid)
    }
    #[cfg(not(windows))]
    {
        let _ = luid;
        Vec::new()
    }
}
