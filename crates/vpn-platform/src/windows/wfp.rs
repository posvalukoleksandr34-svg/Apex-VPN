//! Kill switch and leak protection on the Windows Filtering Platform.
//!
//! * All filters live under our own provider and sublayer (highest sublayer
//!   weight), so they're easy to find and never touch anyone else's rules.
//! * A policy is applied inside **one WFP transaction**: our old filters are
//!   deleted and the new ones added, then committed atomically. There is no
//!   instant with neither rule set in force.
//! * The engine session is *not* dynamic, so filters survive a crash of the
//!   service. While blocking, filters are also persistent, so they hold from
//!   boot until the service starts and takes over.
//! * Block filters clear the action right ("hard" block): a permit from a
//!   lower-priority sublayer (another program) can't override them.
//!
//! Rules are evaluated at the ALE connect and receive/accept layers (IPv4 and
//! IPv6). Within our sublayer, higher weight wins:
//!
//! | weight | rule |
//! |---|---|
//! | 15 | permit loopback |
//! | 14 | permit DHCP (v4 68↔67, v6 546↔547) |
//! | 13 | permit VPN server endpoint (UDP) |
//! | 12 | permit service/app → API endpoint (by executable) |
//! | 11 | permit DNS to the chosen resolvers on the tunnel |
//! | 10 | block DNS (port 53) everywhere else |
//! |  9 | permit all traffic on the tunnel interface |
//! |  8 | permit LAN (private, link-local, multicast), if allowed |
//! |  0 | block everything else |

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use vpn_core::firewall::{FirewallPolicy, Transport};
use vpn_core::{Firewall, PlatformError, PlatformResult};
use vpn_types::ipc::FirewallSummary;
use vpn_types::ErrorKind;
use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::{FWP_E_ALREADY_EXISTS, HANDLE};
use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::*;
use windows_sys::Win32::System::Rpc::RPC_C_AUTHN_WINNT;

use super::util::{check, platform_error, wide};

const PROVIDER_KEY: GUID = GUID::from_u128(0x6d657269_6469_616e_7766_700000000001);
const SUBLAYER_KEY: GUID = GUID::from_u128(0x6d657269_6469_616e_7766_700000000002);

const LAYERS: [(GUID, bool, bool); 4] = [
    // (layer, is_ipv6, is_outbound)
    (FWPM_LAYER_ALE_AUTH_CONNECT_V4, false, true),
    (FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4, false, false),
    (FWPM_LAYER_ALE_AUTH_CONNECT_V6, true, true),
    (FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6, true, false),
];

const PROTO_TCP: u8 = 6;
const PROTO_UDP: u8 = 17;

const LAN_V4: [(Ipv4Addr, u8); 6] = [
    (Ipv4Addr::new(10, 0, 0, 0), 8),
    (Ipv4Addr::new(172, 16, 0, 0), 12),
    (Ipv4Addr::new(192, 168, 0, 0), 16),
    (Ipv4Addr::new(169, 254, 0, 0), 16),
    (Ipv4Addr::new(224, 0, 0, 0), 4),
    (Ipv4Addr::new(255, 255, 255, 255), 32),
];
const LAN_V6: [(Ipv6Addr, u8); 3] = [
    (Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10),
    (Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 0), 7),
    (Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0), 8),
];

struct Engine(HANDLE);

unsafe impl Send for Engine {}

impl Drop for Engine {
    fn drop(&mut self) {
        unsafe { FwpmEngineClose0(self.0) };
    }
}

struct State {
    engine: Engine,
    description: String,
    expected_filters: u32,
}

#[derive(Clone)]
pub struct WfpFirewall {
    state: Arc<Mutex<State>>,
}

impl WfpFirewall {
    /// Opens the filtering engine and registers our provider and sublayer.
    /// Needs administrator/SYSTEM.
    pub fn open() -> Result<Self, PlatformError> {
        let name = wide("Apexy VPN");
        let mut session: FWPM_SESSION0 = unsafe { std::mem::zeroed() };
        session.displayData.name = name.as_ptr() as *mut u16;
        session.txnWaitTimeoutInMSec = 5_000;
        let mut handle: HANDLE = std::ptr::null_mut();
        check(ErrorKind::FirewallFailure, "opening the filtering engine", unsafe {
            FwpmEngineOpen0(std::ptr::null(), RPC_C_AUTHN_WINNT, std::ptr::null(), &session, &mut handle)
        })?;
        let engine = Engine(handle);
        ensure_provider_and_sublayer(engine.0)?;
        Ok(Self {
            state: Arc::new(Mutex::new(State { engine, description: "unknown".into(), expected_filters: 0 })),
        })
    }

    /// Removes every filter, the sublayer and the provider. Used by the
    /// uninstaller (`apexyd --reset-firewall`).
    pub fn remove_all(&self) -> PlatformResult<()> {
        let st = self.state.lock().expect("wfp state");
        let h = st.engine.0;
        transaction(h, || {
            delete_our_filters(h)?;
            let _ = unsafe { FwpmSubLayerDeleteByKey0(h, &SUBLAYER_KEY) };
            let _ = unsafe { FwpmProviderDeleteByKey0(h, &PROVIDER_KEY) };
            Ok(())
        })
    }

    fn apply_blocking(&self, policy: &FirewallPolicy) -> PlatformResult<()> {
        let mut st = self.state.lock().expect("wfp state");
        let h = st.engine.0;
        let mut added = 0u32;
        transaction(h, || {
            delete_our_filters(h)?;
            if !policy.is_open() {
                added = add_policy(h, policy)?;
            }
            Ok(())
        })?;
        st.description = policy.describe();
        st.expected_filters = added;
        tracing::debug!(filters = added, policy = %st.description, "WFP policy committed");
        Ok(())
    }
}

#[async_trait]
impl Firewall for WfpFirewall {
    async fn apply(&self, policy: &FirewallPolicy) -> PlatformResult<()> {
        let this = self.clone();
        let policy = policy.clone();
        tokio::task::spawn_blocking(move || this.apply_blocking(&policy))
            .await
            .map_err(|e| PlatformError::new(ErrorKind::Internal, e.to_string()))?
    }

    async fn summary(&self) -> FirewallSummary {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let st = this.state.lock().expect("wfp state");
            let count = list_our_filters(st.engine.0).map(|ids| ids.len() as u32);
            FirewallSummary {
                policy: st.description.clone(),
                verified: count.as_ref().is_ok_and(|c| *c == st.expected_filters),
                filter_count: count.unwrap_or(0),
            }
        })
        .await
        .unwrap_or(FirewallSummary { policy: "unknown".into(), verified: false, filter_count: 0 })
    }
}

fn transaction(h: HANDLE, body: impl FnOnce() -> PlatformResult<()>) -> PlatformResult<()> {
    check(ErrorKind::FirewallFailure, "beginning a WFP transaction", unsafe { FwpmTransactionBegin0(h, 0) })?;
    match body() {
        Ok(()) => check(ErrorKind::FirewallFailure, "committing the WFP transaction", unsafe {
            FwpmTransactionCommit0(h)
        }),
        Err(e) => {
            unsafe { FwpmTransactionAbort0(h) };
            Err(e)
        }
    }
}

fn ensure_provider_and_sublayer(h: HANDLE) -> PlatformResult<()> {
    let name = wide("Apexy VPN");
    let desc = wide("Kill switch and leak protection");
    transaction(h, || {
        let mut provider: FWPM_PROVIDER0 = unsafe { std::mem::zeroed() };
        provider.providerKey = PROVIDER_KEY;
        provider.displayData.name = name.as_ptr() as *mut u16;
        provider.displayData.description = desc.as_ptr() as *mut u16;
        provider.flags = FWPM_PROVIDER_FLAG_PERSISTENT;
        let rc = unsafe { FwpmProviderAdd0(h, &provider, std::ptr::null_mut()) };
        if rc != 0 && rc != FWP_E_ALREADY_EXISTS as u32 {
            return Err(platform_error(ErrorKind::FirewallFailure, "registering the WFP provider", rc));
        }
        let mut provider_key = PROVIDER_KEY;
        let mut sublayer: FWPM_SUBLAYER0 = unsafe { std::mem::zeroed() };
        sublayer.subLayerKey = SUBLAYER_KEY;
        sublayer.displayData.name = name.as_ptr() as *mut u16;
        sublayer.displayData.description = desc.as_ptr() as *mut u16;
        sublayer.flags = FWPM_SUBLAYER_FLAG_PERSISTENT;
        sublayer.providerKey = &mut provider_key;
        sublayer.weight = u16::MAX;
        let rc = unsafe { FwpmSubLayerAdd0(h, &sublayer, std::ptr::null_mut()) };
        if rc != 0 && rc != FWP_E_ALREADY_EXISTS as u32 {
            return Err(platform_error(ErrorKind::FirewallFailure, "registering the WFP sublayer", rc));
        }
        Ok(())
    })
}

fn list_our_filters(h: HANDLE) -> PlatformResult<Vec<u64>> {
    let mut ids = Vec::new();
    for (layer, _, _) in LAYERS {
        let mut provider_key = PROVIDER_KEY;
        let mut template: FWPM_FILTER_ENUM_TEMPLATE0 = unsafe { std::mem::zeroed() };
        template.providerKey = &mut provider_key;
        template.layerKey = layer;
        template.enumType = FWP_FILTER_ENUM_FULLY_CONTAINED;
        template.actionMask = u32::MAX;
        let mut eh: HANDLE = std::ptr::null_mut();
        check(ErrorKind::FirewallFailure, "enumerating filters", unsafe {
            FwpmFilterCreateEnumHandle0(h, &template, &mut eh)
        })?;
        loop {
            let mut entries: *mut *mut FWPM_FILTER0 = std::ptr::null_mut();
            let mut n = 0u32;
            let rc = unsafe { FwpmFilterEnum0(h, eh, 256, &mut entries, &mut n) };
            if rc != 0 {
                unsafe { FwpmFilterDestroyEnumHandle0(h, eh) };
                return Err(platform_error(ErrorKind::FirewallFailure, "enumerating filters", rc));
            }
            for i in 0..n as usize {
                let f = unsafe { &**entries.add(i) };
                if guid_eq(&f.subLayerKey, &SUBLAYER_KEY) {
                    ids.push(f.filterId);
                }
            }
            if !entries.is_null() {
                unsafe { FwpmFreeMemory0((&mut entries as *mut *mut *mut FWPM_FILTER0).cast()) };
            }
            if n < 256 {
                break;
            }
        }
        unsafe { FwpmFilterDestroyEnumHandle0(h, eh) };
    }
    Ok(ids)
}

fn guid_eq(a: &GUID, b: &GUID) -> bool {
    (a.data1, a.data2, a.data3, a.data4) == (b.data1, b.data2, b.data3, b.data4)
}

fn delete_our_filters(h: HANDLE) -> PlatformResult<()> {
    for id in list_our_filters(h)? {
        check(ErrorKind::FirewallFailure, "removing a filter", unsafe { FwpmFilterDeleteById0(h, id) })?;
    }
    Ok(())
}

// ── building filters ─────────────────────────────────────────────────────

enum Cond {
    Loopback,
    Interface(u64),
    RemoteV4(Ipv4Addr, u8),
    RemoteV6(Ipv6Addr, u8),
    RemotePort(u16),
    LocalPort(u16),
    Protocol(u8),
    AppId(Vec<u8>),
}

struct FilterSpec<'a> {
    name: &'a str,
    layer: GUID,
    weight: u8,
    permit: bool,
    conditions: Vec<Cond>,
}

fn add_policy(h: HANDLE, p: &FirewallPolicy) -> PlatformResult<u32> {
    let persistent = p.block_by_default;
    let tunnel_luid = p.tunnel.as_ref().and_then(|t| t.luid);
    let app_ids: Vec<(Vec<u8>, std::net::SocketAddr)> = p
        .exceptions
        .iter()
        .filter_map(|ex| match app_id(&ex.app) {
            Ok(blob) => Some((blob, ex.remote)),
            Err(e) => {
                tracing::warn!(app = %ex.app.display(), "skipping firewall exception: {e}");
                None
            }
        })
        .collect();
    let mut count = 0u32;
    let mut add = |spec: FilterSpec<'_>| -> PlatformResult<()> {
        add_filter(h, spec, persistent)?;
        count += 1;
        Ok(())
    };

    for (layer, v6, outbound) in LAYERS {
        let restrict_all = p.block_by_default || (v6 && p.block_ipv6_outside_tunnel);
        if restrict_all {
            add(FilterSpec { name: "Permit loopback", layer, weight: 15, permit: true, conditions: vec![Cond::Loopback] })?;
            let (client, server) = if v6 { (546, 547) } else { (68, 67) };
            add(FilterSpec {
                name: "Permit DHCP",
                layer,
                weight: 14,
                permit: true,
                conditions: vec![Cond::Protocol(PROTO_UDP), Cond::LocalPort(client), Cond::RemotePort(server)],
            })?;
            if let Some(luid) = tunnel_luid {
                add(FilterSpec { name: "Permit tunnel", layer, weight: 9, permit: true, conditions: vec![Cond::Interface(luid)] })?;
            }
            if p.allow_lan {
                if v6 {
                    for (net, len) in LAN_V6 {
                        add(FilterSpec { name: "Permit LAN", layer, weight: 8, permit: true, conditions: vec![Cond::RemoteV6(net, len)] })?;
                    }
                } else {
                    for (net, len) in LAN_V4 {
                        add(FilterSpec { name: "Permit LAN", layer, weight: 8, permit: true, conditions: vec![Cond::RemoteV4(net, len)] })?;
                    }
                }
            }
            add(FilterSpec { name: "Block all", layer, weight: 0, permit: false, conditions: vec![] })?;
        }

        if restrict_all && outbound {
            if let Some(peer) = p.peer.filter(|peer| peer.addr.is_ipv6() == v6) {
                let proto = match peer.transport {
                    Transport::Udp => PROTO_UDP,
                    Transport::Tcp => PROTO_TCP,
                };
                add(FilterSpec {
                    name: "Permit VPN server",
                    layer,
                    weight: 13,
                    permit: true,
                    conditions: vec![remote(peer.addr.ip()), Cond::RemotePort(peer.addr.port()), Cond::Protocol(proto)],
                })?;
            }
            for (blob, remote_addr) in app_ids.iter().filter(|(_, r)| r.is_ipv6() == v6) {
                add(FilterSpec {
                    name: "Permit API access",
                    layer,
                    weight: 12,
                    permit: true,
                    conditions: vec![
                        Cond::AppId(blob.clone()),
                        remote(remote_addr.ip()),
                        Cond::RemotePort(remote_addr.port()),
                        Cond::Protocol(PROTO_TCP),
                    ],
                })?;
            }
        }

        if let (Some(servers), true) = (&p.dns_only_via_tunnel, outbound) {
            for server in servers.iter().filter(|s| s.is_ipv6() == v6) {
                for proto in [PROTO_UDP, PROTO_TCP] {
                    let mut conditions = vec![remote(*server), Cond::RemotePort(53), Cond::Protocol(proto)];
                    if let Some(luid) = tunnel_luid {
                        conditions.push(Cond::Interface(luid));
                    }
                    add(FilterSpec { name: "Permit tunnel DNS", layer, weight: 11, permit: true, conditions })?;
                }
            }
            for proto in [PROTO_UDP, PROTO_TCP] {
                add(FilterSpec {
                    name: "Block DNS outside the tunnel",
                    layer,
                    weight: 10,
                    permit: false,
                    conditions: vec![Cond::RemotePort(53), Cond::Protocol(proto)],
                })?;
            }
        }
    }
    Ok(count)
}

fn remote(ip: IpAddr) -> Cond {
    match ip {
        IpAddr::V4(v4) => Cond::RemoteV4(v4, 32),
        IpAddr::V6(v6) => Cond::RemoteV6(v6, 128),
    }
}

fn add_filter(h: HANDLE, spec: FilterSpec<'_>, persistent: bool) -> PlatformResult<()> {
    // Condition values are pointers; this storage keeps them alive until
    // FwpmFilterAdd0 has copied them.
    let mut u64s: Vec<Box<u64>> = Vec::new();
    let mut v4s: Vec<Box<FWP_V4_ADDR_AND_MASK>> = Vec::new();
    let mut v6s: Vec<Box<FWP_V6_ADDR_AND_MASK>> = Vec::new();
    let mut blobs: Vec<(Box<[u8]>, Box<FWP_BYTE_BLOB>)> = Vec::new();

    let mut conditions: Vec<FWPM_FILTER_CONDITION0> = Vec::with_capacity(spec.conditions.len());
    for c in &spec.conditions {
        let mut cond: FWPM_FILTER_CONDITION0 = unsafe { std::mem::zeroed() };
        cond.matchType = FWP_MATCH_EQUAL;
        match c {
            Cond::Loopback => {
                cond.fieldKey = FWPM_CONDITION_FLAGS;
                cond.matchType = FWP_MATCH_FLAGS_ANY_SET;
                cond.conditionValue.r#type = FWP_UINT32;
                cond.conditionValue.Anonymous.uint32 = FWP_CONDITION_FLAG_IS_LOOPBACK;
            }
            Cond::Interface(luid) => {
                u64s.push(Box::new(*luid));
                cond.fieldKey = FWPM_CONDITION_IP_LOCAL_INTERFACE;
                cond.conditionValue.r#type = FWP_UINT64;
                cond.conditionValue.Anonymous.uint64 = &mut **u64s.last_mut().unwrap();
            }
            Cond::RemoteV4(addr, prefix) => {
                let mask = if *prefix == 0 { 0 } else { u32::MAX << (32 - *prefix as u32) };
                v4s.push(Box::new(FWP_V4_ADDR_AND_MASK { addr: u32::from(*addr), mask }));
                cond.fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
                cond.conditionValue.r#type = FWP_V4_ADDR_MASK;
                cond.conditionValue.Anonymous.v4AddrMask = &mut **v4s.last_mut().unwrap();
            }
            Cond::RemoteV6(addr, prefix) => {
                v6s.push(Box::new(FWP_V6_ADDR_AND_MASK { addr: addr.octets(), prefixLength: *prefix }));
                cond.fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
                cond.conditionValue.r#type = FWP_V6_ADDR_MASK;
                cond.conditionValue.Anonymous.v6AddrMask = &mut **v6s.last_mut().unwrap();
            }
            Cond::RemotePort(port) => {
                cond.fieldKey = FWPM_CONDITION_IP_REMOTE_PORT;
                cond.conditionValue.r#type = FWP_UINT16;
                cond.conditionValue.Anonymous.uint16 = *port;
            }
            Cond::LocalPort(port) => {
                cond.fieldKey = FWPM_CONDITION_IP_LOCAL_PORT;
                cond.conditionValue.r#type = FWP_UINT16;
                cond.conditionValue.Anonymous.uint16 = *port;
            }
            Cond::Protocol(p) => {
                cond.fieldKey = FWPM_CONDITION_IP_PROTOCOL;
                cond.conditionValue.r#type = FWP_UINT8;
                cond.conditionValue.Anonymous.uint8 = *p;
            }
            Cond::AppId(bytes) => {
                let mut data: Box<[u8]> = bytes.clone().into_boxed_slice();
                let blob = Box::new(FWP_BYTE_BLOB { size: data.len() as u32, data: data.as_mut_ptr() });
                blobs.push((data, blob));
                cond.fieldKey = FWPM_CONDITION_ALE_APP_ID;
                cond.conditionValue.r#type = FWP_BYTE_BLOB_TYPE;
                cond.conditionValue.Anonymous.byteBlob = &mut *blobs.last_mut().unwrap().1;
            }
        }
        conditions.push(cond);
    }

    let name = wide(spec.name);
    let mut provider_key = PROVIDER_KEY;
    let mut filter: FWPM_FILTER0 = unsafe { std::mem::zeroed() };
    filter.displayData.name = name.as_ptr() as *mut u16;
    filter.flags = if persistent { FWPM_FILTER_FLAG_PERSISTENT } else { FWPM_FILTER_FLAG_NONE };
    if !spec.permit {
        filter.flags |= FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT;
    }
    filter.providerKey = &mut provider_key;
    filter.layerKey = spec.layer;
    filter.subLayerKey = SUBLAYER_KEY;
    filter.weight.r#type = FWP_UINT8;
    filter.weight.Anonymous.uint8 = spec.weight;
    filter.numFilterConditions = conditions.len() as u32;
    filter.filterCondition = if conditions.is_empty() { std::ptr::null_mut() } else { conditions.as_mut_ptr() };
    filter.action.r#type = if spec.permit { FWP_ACTION_PERMIT } else { FWP_ACTION_BLOCK };

    let mut id = 0u64;
    check(ErrorKind::FirewallFailure, &format!("adding filter \"{}\"", spec.name), unsafe {
        FwpmFilterAdd0(h, &filter, std::ptr::null_mut(), &mut id)
    })?;
    drop((u64s, v4s, v6s, blobs));
    Ok(())
}

fn app_id(path: &std::path::Path) -> PlatformResult<Vec<u8>> {
    let wpath = wide(&path.to_string_lossy());
    let mut blob: *mut FWP_BYTE_BLOB = std::ptr::null_mut();
    check(ErrorKind::FirewallFailure, "resolving an application id", unsafe {
        FwpmGetAppIdFromFileName0(wpath.as_ptr(), &mut blob)
    })?;
    let bytes = unsafe { std::slice::from_raw_parts((*blob).data, (*blob).size as usize).to_vec() };
    unsafe { FwpmFreeMemory0((&mut blob as *mut *mut FWP_BYTE_BLOB).cast()) };
    Ok(bytes)
}
