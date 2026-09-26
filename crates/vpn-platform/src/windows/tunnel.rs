//! WireGuard tunnels on WireGuardNT: adapter, addresses, routes, MTU.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ipnet::IpNet;
use vpn_core::{PlatformError, PlatformResult, Tunnel, TunnelConfig, TunnelDriver};
use vpn_types::brand::{TUNNEL_ADAPTER_NAME, TUNNEL_TYPE};
use vpn_types::time::now_millis;
use vpn_types::{
    Availability, ErrorKind, InterfaceInfo, Protocol, ProtocolCapability, TunnelStats, UnavailableReason,
};
use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, ERROR_OBJECT_ALREADY_EXISTS};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    ConvertInterfaceLuidToIndex, CreateIpForwardEntry2, CreateUnicastIpAddressEntry, GetIpInterfaceEntry,
    InitializeIpForwardEntry, InitializeIpInterfaceEntry, InitializeUnicastIpAddressEntry, SetIpInterfaceEntry,
    MIB_IPFORWARD_ROW2, MIB_IPINTERFACE_ROW, MIB_UNICASTIPADDRESS_ROW,
};
use windows_sys::Win32::NetworkManagement::Ndis::NET_LUID_LH;
use windows_sys::Win32::Networking::WinSock::{IpDadStatePreferred, ADDRESS_FAMILY, AF_INET, AF_INET6};

use super::util::{platform_error, sockaddr_inet};
use super::wireguard_nt::{Adapter, PeerSettings, WireGuardNt};

/// Fixed adapter GUID, so Windows keeps one network profile for the tunnel
/// instead of creating "Network 2, 3, 4…" on every connect.
const ADAPTER_GUID: GUID = GUID::from_u128(0x6d657269_6469_616e_7475_6e0000000001);

pub struct WireGuardNtDriver {
    nt: Result<Arc<WireGuardNt>, PlatformError>,
}

impl WireGuardNtDriver {
    pub fn new(nt: Result<Arc<WireGuardNt>, PlatformError>) -> Self {
        if let Err(e) = &nt {
            tracing::error!("WireGuardNT unavailable: {e}");
        }
        Self { nt }
    }
}

#[async_trait]
impl TunnelDriver for WireGuardNtDriver {
    fn protocol(&self) -> Protocol {
        Protocol::WireGuard
    }

    fn capability(&self) -> ProtocolCapability {
        match &self.nt {
            Ok(nt) => ProtocolCapability {
                protocol: Protocol::WireGuard,
                availability: Availability::Available,
                implementation: Some(match nt.driver_version() {
                    Some(v) => format!("WireGuardNT {v}"),
                    None => "WireGuardNT".into(),
                }),
            },
            Err(_) => ProtocolCapability {
                protocol: Protocol::WireGuard,
                availability: Availability::Unavailable(UnavailableReason::DriverMissing),
                implementation: None,
            },
        }
    }

    async fn open(&self, config: TunnelConfig) -> PlatformResult<Box<dyn Tunnel>> {
        let nt = self.nt.clone()?;
        let tunnel = tokio::task::spawn_blocking(move || open_blocking(&nt, &config))
            .await
            .map_err(|e| PlatformError::new(ErrorKind::Internal, e.to_string()))??;
        Ok(Box::new(tunnel))
    }
}

fn open_blocking(nt: &Arc<WireGuardNt>, config: &TunnelConfig) -> PlatformResult<WindowsTunnel> {
    let adapter = Adapter::create(nt, TUNNEL_ADAPTER_NAME, TUNNEL_TYPE, &ADAPTER_GUID)?;
    let luid = adapter.luid();

    let has_v6 = config.addresses.iter().any(|a| matches!(a, IpNet::V6(_)));
    configure_interface(luid, AF_INET, config.mtu as u32)?;
    if has_v6 {
        configure_interface(luid, AF_INET6, (config.mtu as u32).max(1280))?;
    }
    for addr in &config.addresses {
        add_address(luid, addr)?;
    }
    for route in &config.peer.allowed_ips {
        add_route(luid, route)?;
    }

    adapter.configure(
        config.private_key.as_bytes(),
        &PeerSettings {
            public_key: *config.peer.public_key.as_bytes(),
            endpoint: config.peer.endpoint,
            persistent_keepalive: config.peer.persistent_keepalive,
            allowed_ips: config.peer.allowed_ips.clone(),
        },
    )?;
    adapter.set_up(true)?;

    let mut index = 0u32;
    let luid_lh = NET_LUID_LH { Value: luid };
    let index = (unsafe { ConvertInterfaceLuidToIndex(&luid_lh, &mut index) } == 0).then_some(index);
    let source_v4 = config.addresses.iter().find_map(|a| match a {
        IpNet::V4(v4) => Some(v4.addr()),
        _ => None,
    });
    tracing::info!(luid, ?index, "WireGuard adapter up");
    Ok(WindowsTunnel {
        adapter: Arc::new(adapter),
        info: InterfaceInfo { name: TUNNEL_ADAPTER_NAME.into(), index, luid: Some(luid) },
        source_v4,
    })
}

/// The IP interface appears shortly after the adapter; wait for it, then
/// set metric 0 (preferred for routing and DNS) and the MTU.
fn configure_interface(luid: u64, family: ADDRESS_FAMILY, mtu: u32) -> PlatformResult<()> {
    let mut row: MIB_IPINTERFACE_ROW = unsafe { std::mem::zeroed() };
    for attempt in 0..100 {
        unsafe { InitializeIpInterfaceEntry(&mut row) };
        row.Family = family;
        row.InterfaceLuid = NET_LUID_LH { Value: luid };
        match unsafe { GetIpInterfaceEntry(&mut row) } {
            0 => break,
            ERROR_NOT_FOUND if attempt < 99 => std::thread::sleep(Duration::from_millis(50)),
            e => return Err(platform_error(ErrorKind::RoutingFailure, "reading the tunnel interface", e)),
        }
    }
    row.UseAutomaticMetric = false;
    row.Metric = 0;
    row.NlMtu = mtu;
    row.SitePrefixLength = 0;
    let rc = unsafe { SetIpInterfaceEntry(&mut row) };
    if rc != 0 {
        return Err(platform_error(ErrorKind::RoutingFailure, "setting the tunnel metric and MTU", rc));
    }
    Ok(())
}

fn add_address(luid: u64, net: &IpNet) -> PlatformResult<()> {
    let mut row: MIB_UNICASTIPADDRESS_ROW = unsafe { std::mem::zeroed() };
    unsafe { InitializeUnicastIpAddressEntry(&mut row) };
    row.InterfaceLuid = NET_LUID_LH { Value: luid };
    row.Address = sockaddr_inet(std::net::SocketAddr::new(net.addr(), 0));
    row.OnLinkPrefixLength = net.prefix_len();
    row.DadState = IpDadStatePreferred;
    match unsafe { CreateUnicastIpAddressEntry(&row) } {
        0 | ERROR_OBJECT_ALREADY_EXISTS => Ok(()),
        e => Err(platform_error(ErrorKind::RoutingFailure, "assigning the tunnel address", e)),
    }
}

fn add_route(luid: u64, net: &IpNet) -> PlatformResult<()> {
    let mut row: MIB_IPFORWARD_ROW2 = unsafe { std::mem::zeroed() };
    unsafe { InitializeIpForwardEntry(&mut row) };
    row.InterfaceLuid = NET_LUID_LH { Value: luid };
    row.DestinationPrefix.Prefix = sockaddr_inet(std::net::SocketAddr::new(net.network(), 0));
    row.DestinationPrefix.PrefixLength = net.prefix_len();
    // On-link: next hop is the unspecified address of the same family.
    let unspecified = match net {
        IpNet::V4(_) => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        IpNet::V6(_) => IpAddr::V6(std::net::Ipv6Addr::UNSPECIFIED),
    };
    row.NextHop = sockaddr_inet(std::net::SocketAddr::new(unspecified, 0));
    row.Metric = 0;
    match unsafe { CreateIpForwardEntry2(&row) } {
        0 | ERROR_OBJECT_ALREADY_EXISTS => Ok(()),
        e => Err(platform_error(ErrorKind::RoutingFailure, "adding the tunnel route", e)),
    }
}

pub struct WindowsTunnel {
    adapter: Arc<Adapter>,
    info: InterfaceInfo,
    source_v4: Option<Ipv4Addr>,
}

#[async_trait]
impl Tunnel for WindowsTunnel {
    fn interface(&self) -> InterfaceInfo {
        self.info.clone()
    }

    async fn stats(&self) -> PlatformResult<TunnelStats> {
        let adapter = self.adapter.clone();
        let c = tokio::task::spawn_blocking(move || adapter.counters())
            .await
            .map_err(|e| PlatformError::new(ErrorKind::Internal, e.to_string()))??;
        Ok(TunnelStats {
            rx_bytes: c.rx_bytes,
            tx_bytes: c.tx_bytes,
            last_handshake: c.last_handshake_ms,
            sampled_at: now_millis(),
        })
    }

    async fn probe(&self, target: IpAddr, timeout: Duration) -> PlatformResult<Duration> {
        let source = self.source_v4.map(IpAddr::V4);
        tokio::task::spawn_blocking(move || super::icmp::echo(source, target, timeout))
            .await
            .map_err(|e| PlatformError::new(ErrorKind::Internal, e.to_string()))?
            .map_err(|e| PlatformError::new(ErrorKind::TunnelVerificationFailed, e.0))
    }

    async fn close(self: Box<Self>) {
        let adapter = self.adapter;
        // Removing the adapter also removes its addresses, routes and DNS.
        let _ = tokio::task::spawn_blocking(move || drop(adapter)).await;
        tracing::info!("WireGuard adapter removed");
    }
}
