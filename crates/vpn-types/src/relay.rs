//! The server ("relay") list. It is produced by the backend, signed with the
//! fleet key, and verified by the service before anything in it is used.

use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, Ipv6Addr};
use ts_rs::TS;

use crate::UnixMillis;

pub type ServerId = String;
pub type LocationId = String;

/// A signed relay list as served by `GET /v1/servers/relays`.
/// `payload` is base64 of the exact JSON bytes that were signed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SignedRelayList {
    pub payload: String,
    pub signature: String,
    pub key_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RelayList {
    /// Monotonic. The service refuses a list older than the one it has.
    #[ts(type = "number")]
    pub version: u64,
    #[ts(type = "number")]
    pub generated_at: UnixMillis,
    /// After this instant the list is stale and no longer used for new
    /// connections (the service keeps the tunnel up and refetches).
    #[ts(type = "number")]
    pub expires_at: UnixMillis,
    pub locations: Vec<Location>,
    pub servers: Vec<Server>,
}

impl RelayList {
    pub fn location(&self, id: &str) -> Option<&Location> {
        self.locations.iter().find(|l| l.id == id)
    }

    pub fn server(&self, id: &str) -> Option<&Server> {
        self.servers.iter().find(|s| s.id == id)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Location {
    /// e.g. `de-fra`
    pub id: LocationId,
    /// ISO 3166-1 alpha-2, upper case.
    pub country_code: String,
    pub country: String,
    pub city: String,
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Server {
    pub id: ServerId,
    pub hostname: String,
    pub location_id: LocationId,
    pub status: ServerStatus,
    /// Share of capacity in use, 0–100, from the node's own report. `None`
    /// when the last report is too old to trust.
    pub load: Option<u8>,
    /// Maximum concurrent peers the node is provisioned for.
    pub capacity: u32,
    pub features: Vec<ServerFeature>,
    #[ts(type = "string")]
    pub ipv4: Ipv4Addr,
    #[ts(type = "string | null")]
    pub ipv6: Option<Ipv6Addr>,
    pub wireguard: Option<WireGuardEndpoint>,
    pub openvpn: Option<OpenVpnEndpoint>,
    pub ikev2: Option<Ikev2Endpoint>,
    /// Latest fleet-side health measurement (from the monitoring probes, not
    /// from this device). `None` when there is no recent measurement.
    pub health: Option<ServerHealth>,
}

impl Server {
    pub fn supports(&self, protocol: crate::Protocol) -> bool {
        match protocol {
            crate::Protocol::WireGuard => self.wireguard.is_some(),
            crate::Protocol::OpenVpn => self.openvpn.is_some(),
            crate::Protocol::Ikev2 => self.ikev2.is_some(),
        }
    }

    pub fn accepts_connections(&self) -> bool {
        matches!(self.status, ServerStatus::Online | ServerStatus::Busy)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ServerStatus {
    Online,
    /// Reachable but above the soft load threshold; still accepts peers.
    Busy,
    Maintenance,
    Offline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ServerFeature {
    Streaming,
    Gaming,
    /// Hardened node: RAM-only, no persistent storage.
    Privacy,
    P2p,
    LowLatency,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WireGuardEndpoint {
    /// Base64 Curve25519 public key of the node.
    pub public_key: String,
    pub ports: Vec<u16>,
    /// The node's address inside the tunnel. Used as the connectivity probe
    /// target and the VPN DNS resolver.
    #[ts(type = "string")]
    pub gateway_ipv4: Ipv4Addr,
    #[ts(type = "string | null")]
    pub gateway_ipv6: Option<Ipv6Addr>,
    /// The resolver "VPN DNS" uses, reached through the tunnel. Absent means
    /// the gateway (every Meridian node runs one there); third-party nodes
    /// without a resolver name one explicitly.
    #[serde(default)]
    #[ts(type = "string | null")]
    pub dns_ipv4: Option<Ipv4Addr>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OpenVpnEndpoint {
    pub udp_ports: Vec<u16>,
    pub tcp_ports: Vec<u16>,
    /// SHA-256 fingerprint of the node's CA certificate.
    pub ca_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Ikev2Endpoint {
    pub remote_id: String,
    pub ca_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ServerHealth {
    #[ts(type = "number")]
    pub measured_at: UnixMillis,
    /// Packet loss seen by the fleet monitor, percent.
    pub packet_loss: Option<f32>,
    pub wireguard_healthy: Option<bool>,
    pub openvpn_healthy: Option<bool>,
    pub ikev2_healthy: Option<bool>,
}

/// Round-trip time measured by *this device* to a server's public address.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LatencySample {
    pub server_id: ServerId,
    /// `None` when every probe timed out.
    pub rtt_ms: Option<u32>,
    #[ts(type = "number")]
    pub measured_at: UnixMillis,
    /// Measured while the tunnel was up (then it's tunnel-inclusive and not
    /// comparable to direct measurements).
    pub via_tunnel: bool,
}

/// What the service knows about the relay list it holds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RelayListStatus {
    #[ts(type = "number | null")]
    pub version: Option<u64>,
    #[ts(type = "number | null")]
    pub fetched_at: Option<UnixMillis>,
    #[ts(type = "number | null")]
    pub expires_at: Option<UnixMillis>,
    pub stale: bool,
    pub last_error: Option<crate::ErrorKind>,
}
