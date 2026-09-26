//! The seam between VPN logic and the operating system. `vpn-platform`
//! implements these per OS; tests implement them with fakes.

use async_trait::async_trait;
use ipnet::IpNet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;
use vpn_types::{
    ipc::FirewallSummary, ErrorKind, InterfaceInfo, NetworkSnapshot, Protocol, ProtocolCapability,
    TunnelStats,
};

use crate::firewall::FirewallPolicy;
use crate::keys::{PrivateKey, PublicKey};

/// A platform failure, already classified for the user.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{kind}: {detail}")]
pub struct PlatformError {
    pub kind: ErrorKind,
    pub detail: String,
}

impl PlatformError {
    pub fn new(kind: ErrorKind, detail: impl Into<String>) -> Self {
        Self { kind, detail: detail.into() }
    }

    pub fn unsupported(what: &str) -> Self {
        Self::new(ErrorKind::UnsupportedPlatform, format!("{what} is not implemented on this platform"))
    }
}

pub type PlatformResult<T> = Result<T, PlatformError>;

/// Everything a driver needs to bring one tunnel up.
#[derive(Debug, Clone)]
pub struct TunnelConfig {
    pub protocol: Protocol,
    pub private_key: PrivateKey,
    /// Addresses assigned to this device inside the tunnel.
    pub addresses: Vec<IpNet>,
    pub mtu: u16,
    pub peer: PeerConfig,
}

#[derive(Debug, Clone)]
pub struct PeerConfig {
    pub public_key: PublicKey,
    pub endpoint: SocketAddr,
    /// What to route into the tunnel (0.0.0.0/0 and, with IPv6, ::/0).
    pub allowed_ips: Vec<IpNet>,
    pub persistent_keepalive: u16,
    /// The node's in-tunnel address; probe target.
    pub gateway_v4: Ipv4Addr,
    pub gateway_v6: Option<Ipv6Addr>,
}

#[async_trait]
pub trait TunnelDriver: Send + Sync {
    fn protocol(&self) -> Protocol;
    /// Whether this build can run the protocol on this machine, and why not.
    fn capability(&self) -> ProtocolCapability;
    /// Creates the interface, assigns addresses and routes, applies the
    /// protocol config and brings it up. Returns before the handshake.
    async fn open(&self, config: TunnelConfig) -> PlatformResult<Box<dyn Tunnel>>;
}

#[async_trait]
pub trait Tunnel: Send + Sync {
    fn interface(&self) -> InterfaceInfo;
    /// Counters and last handshake, read from the driver.
    async fn stats(&self) -> PlatformResult<TunnelStats>;
    /// Sends an ICMP echo to `target` sourced from the tunnel address and
    /// returns the round trip. This is the "something got through" test.
    async fn probe(&self, target: IpAddr, timeout: Duration) -> PlatformResult<Duration>;
    /// Tears the interface down. Must be idempotent and must not fail
    /// silently: errors are logged by the implementation.
    async fn close(self: Box<Self>);
}

#[async_trait]
pub trait Firewall: Send + Sync {
    /// Replaces the active policy atomically: there is no instant at which
    /// neither the old nor the new rule set is in force.
    async fn apply(&self, policy: &FirewallPolicy) -> PlatformResult<()>;
    /// Reads back what is installed.
    async fn summary(&self) -> FirewallSummary;
}

#[async_trait]
pub trait DnsConfigurator: Send + Sync {
    /// Makes `servers` the resolvers used by the system while the tunnel is
    /// up, and flushes the resolver cache.
    async fn apply(&self, tunnel: &InterfaceInfo, servers: &[IpAddr]) -> PlatformResult<()>;
    /// Undoes `apply`.
    async fn reset(&self) -> PlatformResult<()>;
    /// What the OS reports as configured on `tunnel` right now.
    async fn effective(&self, tunnel: &InterfaceInfo) -> Vec<IpAddr>;
}

/// Asynchronous notifications from the OS, delivered to the state machine.
#[derive(Debug, Clone, PartialEq)]
pub enum PlatformEvent {
    Network(NetworkSnapshot),
    Suspending,
    Resumed,
}

#[async_trait]
pub trait Pinger: Send + Sync {
    /// ICMP echo round-trip to a public address, outside the tunnel when
    /// the tunnel is down. `None` on timeout.
    async fn ping(&self, target: IpAddr, timeout: Duration) -> Option<Duration>;
}
