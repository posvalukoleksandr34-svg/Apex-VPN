//! Physical network monitoring: route, interface and address change
//! notifications from IP Helper, debounced into `NetworkSnapshot`s.

use std::collections::HashMap;
use std::ffi::c_void;
use std::time::Duration;

use tokio::sync::{mpsc, watch};
use vpn_types::brand::TUNNEL_ADAPTER_NAME;
use vpn_types::time::now_millis;
use vpn_types::{NetworkMedium, NetworkSnapshot, PhysicalNetwork, WifiSecurity};
use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, HANDLE};
use windows_sys::Win32::NetworkManagement::IpHelper::*;
use windows_sys::Win32::NetworkManagement::Ndis::{IfOperStatusUp, NET_LUID_LH};
use windows_sys::Win32::Networking::WinSock::{ADDRESS_FAMILY, AF_INET, AF_INET6, AF_UNSPEC};

use super::util::{from_wide, ip_from_sockaddr};
use super::wlan::{self, WifiConnection, WlanStatus};
use crate::NetworkMonitor;

pub struct WindowsNetworkMonitor {
    tx: watch::Sender<NetworkSnapshot>,
    _registrations: Vec<Registration>,
    wlan_status: std::sync::Arc<std::sync::Mutex<WlanStatus>>,
}

struct Registration(HANDLE);

unsafe impl Send for Registration {}
unsafe impl Sync for Registration {}

impl Drop for Registration {
    fn drop(&mut self) {
        unsafe { CancelMibChangeNotify2(self.0) };
    }
}

impl WindowsNetworkMonitor {
    pub fn start() -> Self {
        let (snapshot, wlan) = build_snapshot();
        let wlan_status = std::sync::Arc::new(std::sync::Mutex::new(wlan));
        let (tx, _) = watch::channel(snapshot);
        let (ping_tx, mut ping_rx) = mpsc::unbounded_channel::<()>();

        // The context outlives the registrations: it's leaked on purpose
        // (one small allocation per process) so a callback racing with
        // cancellation can never touch freed memory.
        let ctx: &'static mpsc::UnboundedSender<()> = Box::leak(Box::new(ping_tx));
        let ctx_ptr = ctx as *const _ as *const c_void;
        let mut registrations = Vec::new();
        unsafe {
            let mut h: HANDLE = std::ptr::null_mut();
            if NotifyRouteChange2(AF_UNSPEC, Some(on_route_change), ctx_ptr, false, &mut h) == 0 {
                registrations.push(Registration(h));
            }
            let mut h: HANDLE = std::ptr::null_mut();
            if NotifyIpInterfaceChange(AF_UNSPEC, Some(on_interface_change), ctx_ptr, false, &mut h) == 0 {
                registrations.push(Registration(h));
            }
            let mut h: HANDLE = std::ptr::null_mut();
            if NotifyUnicastIpAddressChange(AF_UNSPEC, Some(on_address_change), ctx_ptr, false, &mut h) == 0 {
                registrations.push(Registration(h));
            }
        }
        if registrations.len() < 3 {
            tracing::warn!("some network change notifications could not be registered");
        }

        let task_tx = tx.clone();
        let task_wlan = wlan_status.clone();
        tokio::spawn(async move {
            while ping_rx.recv().await.is_some() {
                // Changes arrive in bursts; let them settle.
                tokio::time::sleep(Duration::from_millis(400)).await;
                while ping_rx.try_recv().is_ok() {}
                let (next, wlan) = tokio::task::spawn_blocking(build_snapshot).await.unwrap_or_else(|_| {
                    (task_tx.borrow().clone(), WlanStatus::NoService)
                });
                *task_wlan.lock().expect("wlan status") = wlan;
                task_tx.send_if_modified(|current| {
                    let changed = !same_networks(current, &next);
                    if changed {
                        *current = next;
                    }
                    changed
                });
            }
        });

        Self { tx, _registrations: registrations, wlan_status }
    }

    pub fn wlan_status(&self) -> WlanStatus {
        *self.wlan_status.lock().expect("wlan status")
    }
}

impl NetworkMonitor for WindowsNetworkMonitor {
    fn current(&self) -> NetworkSnapshot {
        self.tx.borrow().clone()
    }

    fn subscribe(&self) -> watch::Receiver<NetworkSnapshot> {
        self.tx.subscribe()
    }
}

fn same_networks(a: &NetworkSnapshot, b: &NetworkSnapshot) -> bool {
    a.online == b.online && a.primary == b.primary && a.networks == b.networks
}

unsafe extern "system" fn on_route_change(ctx: *const c_void, _row: *const MIB_IPFORWARD_ROW2, _t: MIB_NOTIFICATION_TYPE) {
    notify(ctx);
}

unsafe extern "system" fn on_interface_change(ctx: *const c_void, _row: *const MIB_IPINTERFACE_ROW, _t: MIB_NOTIFICATION_TYPE) {
    notify(ctx);
}

unsafe extern "system" fn on_address_change(
    ctx: *const c_void,
    _row: *const MIB_UNICASTIPADDRESS_ROW,
    _t: MIB_NOTIFICATION_TYPE,
) {
    notify(ctx);
}

fn notify(ctx: *const c_void) {
    if ctx.is_null() {
        return;
    }
    let tx = unsafe { &*(ctx as *const mpsc::UnboundedSender<()>) };
    let _ = tx.send(());
}

/// Reads all adapters and derives the snapshot. The tunnel adapter and
/// loopback are excluded: this describes the network *under* the VPN.
pub fn build_snapshot() -> (NetworkSnapshot, WlanStatus) {
    let (wifi, wlan) = wlan::connections();
    let adapters = adapters();
    let default_routes = default_route_metrics();
    let mut networks = Vec::new();
    let mut best: Option<(u32, usize)> = None;
    for a in adapters {
        let Some(network) = a.to_network(&wifi) else { continue };
        // The primary network is the one Windows would actually route through:
        // lowest route metric + interface metric among default routes. (An
        // adapter merely *having* a gateway, like many virtual adapters, isn't
        // enough.)
        if let Some(&metric) = default_routes.get(&a.luid) {
            if best.is_none_or(|(m, _)| metric < m) {
                best = Some((metric, networks.len()));
            }
        }
        networks.push(network);
    }
    let primary = best.map(|(_, i)| networks[i].clone());
    (NetworkSnapshot { online: primary.is_some(), primary, networks, observed_at: now_millis() }, wlan)
}

struct AdapterInfo {
    id: String,
    luid: u64,
    name: String,
    if_type: u32,
    has_ipv4: bool,
    has_ipv6: bool,
    gateway: Option<std::net::IpAddr>,
    dns: Vec<std::net::IpAddr>,
}

/// Effective metric (route + interface) of the best default route per
/// interface LUID, over IPv4 and IPv6.
fn default_route_metrics() -> HashMap<u64, u32> {
    let mut out: HashMap<u64, u32> = HashMap::new();
    for family in [AF_INET, AF_INET6] {
        let mut table: *mut MIB_IPFORWARD_TABLE2 = std::ptr::null_mut();
        if unsafe { GetIpForwardTable2(family, &mut table) } != 0 || table.is_null() {
            continue;
        }
        let n = unsafe { (*table).NumEntries } as usize;
        let rows = unsafe { std::slice::from_raw_parts((*table).Table.as_ptr(), n) };
        for row in rows.iter().filter(|r| r.DestinationPrefix.PrefixLength == 0) {
            let luid = unsafe { row.InterfaceLuid.Value };
            let Some(if_metric) = interface_metric(luid, family) else { continue };
            let metric = row.Metric.saturating_add(if_metric);
            out.entry(luid).and_modify(|m| *m = (*m).min(metric)).or_insert(metric);
        }
        unsafe { FreeMibTable(table.cast()) };
    }
    out
}

fn interface_metric(luid: u64, family: ADDRESS_FAMILY) -> Option<u32> {
    let mut row: MIB_IPINTERFACE_ROW = unsafe { std::mem::zeroed() };
    unsafe { InitializeIpInterfaceEntry(&mut row) };
    row.Family = family;
    row.InterfaceLuid = NET_LUID_LH { Value: luid };
    (unsafe { GetIpInterfaceEntry(&mut row) } == 0 && row.Connected).then_some(row.Metric)
}

impl AdapterInfo {
    fn to_network(&self, wifi: &HashMap<String, WifiConnection>) -> Option<PhysicalNetwork> {
        if !(self.has_ipv4 || self.has_ipv6) {
            return None;
        }
        let medium = match self.if_type {
            IF_TYPE_IEEE80211 => NetworkMedium::Wifi,
            IF_TYPE_ETHERNET_CSMACD => NetworkMedium::Ethernet,
            IF_TYPE_WWANPP | IF_TYPE_WWANPP2 => NetworkMedium::Cellular,
            _ => NetworkMedium::Other,
        };
        let w = wifi.get(&self.id.to_uppercase());
        Some(PhysicalNetwork {
            id: self.id.clone(),
            interface_name: self.name.clone(),
            medium,
            ssid: w.map(|w| w.ssid.clone()),
            wifi_security: w.map(|w| if w.secured { WifiSecurity::Protected } else { WifiSecurity::Open }),
            has_ipv4: self.has_ipv4,
            has_ipv6: self.has_ipv6,
            dns_servers: self.dns.clone(),
            gateway: self.gateway,
        })
    }
}

fn adapters() -> Vec<AdapterInfo> {
    let flags = GAA_FLAG_INCLUDE_GATEWAYS | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST;
    let mut size: u32 = 16 * 1024;
    let mut buf: Vec<u64>;
    loop {
        buf = vec![0u64; (size as usize).div_ceil(8)];
        let rc = unsafe {
            GetAdaptersAddresses(AF_UNSPEC as u32, flags, std::ptr::null(), buf.as_mut_ptr().cast(), &mut size)
        };
        match rc {
            0 => break,
            ERROR_BUFFER_OVERFLOW => continue,
            _ => return Vec::new(),
        }
    }
    let mut out = Vec::new();
    let mut cur = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
    while !cur.is_null() {
        let a = unsafe { &*cur };
        cur = a.Next;
        let name = unsafe { from_wide(a.FriendlyName) };
        if a.OperStatus != IfOperStatusUp || a.IfType == IF_TYPE_SOFTWARE_LOOPBACK || name == TUNNEL_ADAPTER_NAME {
            continue;
        }
        let id = unsafe { std::ffi::CStr::from_ptr(a.AdapterName as *const std::ffi::c_char) }
            .to_string_lossy()
            .into_owned();
        let (mut has_ipv4, mut has_ipv6) = (false, false);
        let mut u = a.FirstUnicastAddress;
        while !u.is_null() {
            let ua = unsafe { &*u };
            match unsafe { ip_from_sockaddr(ua.Address.lpSockaddr) } {
                Some(std::net::IpAddr::V4(v4)) if !v4.is_link_local() => has_ipv4 = true,
                Some(std::net::IpAddr::V6(v6)) if (v6.segments()[0] & 0xffc0) != 0xfe80 && !v6.is_loopback() => has_ipv6 = true,
                _ => {}
            }
            u = ua.Next;
        }
        let mut gateway = None;
        let mut g = a.FirstGatewayAddress;
        while !g.is_null() {
            let ga = unsafe { &*g };
            if gateway.is_none() {
                gateway = unsafe { ip_from_sockaddr(ga.Address.lpSockaddr) };
            }
            g = ga.Next;
        }
        let mut dns = Vec::new();
        let mut d = a.FirstDnsServerAddress;
        while !d.is_null() {
            let da = unsafe { &*d };
            if let Some(ip) = unsafe { ip_from_sockaddr(da.Address.lpSockaddr) } {
                // fec0:0:0:ffff::1-3 are Windows' placeholder site-local resolvers.
                if !matches!(ip, std::net::IpAddr::V6(v6) if v6.segments()[0] == 0xfec0) {
                    dns.push(ip);
                }
            }
            d = da.Next;
        }
        out.push(AdapterInfo {
            id,
            luid: unsafe { a.Luid.Value },
            name,
            if_type: a.IfType,
            has_ipv4,
            has_ipv6,
            gateway,
            dns,
        });
    }
    out
}
