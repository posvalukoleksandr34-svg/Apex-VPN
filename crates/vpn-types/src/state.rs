//! The tunnel state. The service is the only producer of these values;
//! every UI surface renders them as received.

use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use ts_rs::TS;

use crate::{ErrorKind, Protocol, ServerFeature, ServerId, UnixMillis};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum TunnelState {
    /// No tunnel. `locked_down` = the Always-On kill switch is blocking
    /// all traffic.
    Disconnected {
        locked_down: bool,
    },
    Connecting {
        target: ConnectTarget,
        relay: Option<RelaySummary>,
        attempt: u32,
        phase: ConnectPhase,
        /// The kill switch is holding traffic while this runs.
        blocking: bool,
        /// Why the previous attempt failed, when this is a retry.
        last_error: Option<ErrorKind>,
        /// When `phase` is `WaitingToRetry`: when the next attempt starts.
        #[ts(type = "number | null")]
        retry_at: Option<UnixMillis>,
    },
    /// The handshake completed and a probe through the tunnel succeeded.
    Connected { details: Box<ConnectedDetails> },
    Reconnecting {
        target: ConnectTarget,
        relay: Option<RelaySummary>,
        attempt: u32,
        cause: ReconnectCause,
        phase: ConnectPhase,
        blocking: bool,
        last_error: Option<ErrorKind>,
        #[ts(type = "number | null")]
        retry_at: Option<UnixMillis>,
    },
    /// No usable network ("No internet"). Resumes by itself when the
    /// network returns, if the tunnel should be up.
    WaitingForNetwork {
        target: Option<ConnectTarget>,
        blocking: bool,
    },
    Disconnecting { then: AfterDisconnect },
    Error {
        error: TunnelError,
        /// The kill switch keeps traffic blocked until the user retries or
        /// disconnects.
        blocking: bool,
    },
}

impl TunnelState {
    pub fn is_connected(&self) -> bool {
        matches!(self, Self::Connected { .. })
    }

    /// True while the user wants the tunnel up (connecting, connected,
    /// reconnecting, waiting for network, or failed with traffic held).
    pub fn wants_tunnel(&self) -> bool {
        match self {
            Self::Disconnected { .. } | Self::Disconnecting { .. } => false,
            Self::Error { blocking, .. } => *blocking,
            _ => true,
        }
    }

    pub fn is_blocking(&self) -> bool {
        match self {
            Self::Disconnected { locked_down } => *locked_down,
            Self::Connecting { blocking, .. }
            | Self::Reconnecting { blocking, .. }
            | Self::WaitingForNetwork { blocking, .. }
            | Self::Error { blocking, .. } => *blocking,
            Self::Connected { .. } | Self::Disconnecting { .. } => false,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Disconnected { .. } => "disconnected",
            Self::Connecting { .. } => "connecting",
            Self::Connected { .. } => "connected",
            Self::Reconnecting { .. } => "reconnecting",
            Self::WaitingForNetwork { .. } => "waiting_for_network",
            Self::Disconnecting { .. } => "disconnecting",
            Self::Error { .. } => "error",
        }
    }
}

impl std::fmt::Display for TunnelState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disconnected { locked_down: false } => write!(f, "Disconnected"),
            Self::Disconnected { locked_down: true } => {
                write!(f, "Disconnected (blocked by Always-On kill switch)")
            }
            Self::Connecting { relay, phase, .. } => match relay {
                Some(r) => write!(f, "Connecting to {} ({phase:?})", r.hostname),
                None => write!(f, "Connecting ({phase:?})"),
            },
            Self::Connected { details } => write!(
                f,
                "Connected to {} — {}, {}",
                details.relay.hostname, details.relay.city, details.relay.country
            ),
            Self::Reconnecting { cause, attempt, .. } => {
                write!(f, "Reconnecting ({cause:?}, attempt {attempt})")
            }
            Self::WaitingForNetwork { .. } => write!(f, "Waiting for network"),
            Self::Disconnecting { .. } => write!(f, "Disconnecting"),
            Self::Error { error, blocking } => {
                write!(f, "Error: {}", error.kind.code())?;
                if *blocking {
                    write!(f, " (traffic blocked)")?;
                }
                Ok(())
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ConnectPhase {
    /// Backing off before the next attempt (see `retry_at`).
    WaitingToRetry,
    SelectingServer,
    CreatingInterface,
    ConfiguringNetwork,
    Handshaking,
    VerifyingTunnel,
    /// Reconnecting only: checking whether the existing tunnel still works
    /// after a network change or wake-up, before rebuilding it.
    CheckingTunnel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ReconnectCause {
    NetworkChanged,
    NetworkRestored,
    WokeFromSleep,
    HandshakeStale,
    ServerUnavailable,
    TunnelFailure,
    SettingsChanged,
    UserRequested,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AfterDisconnect {
    Nothing,
    Reconnect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TunnelError {
    pub kind: ErrorKind,
    /// Technical detail for the diagnostics view and logs; never shown as the
    /// headline. Already redacted.
    pub detail: Option<String>,
    #[ts(type = "number")]
    pub at: UnixMillis,
}

/// Where to connect. Profiles, quick actions and the CLI all resolve to one
/// of these; the service picks the concrete server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum ConnectTarget {
    Smart {
        mode: SmartMode,
        /// ISO country code to stay within.
        country: Option<String>,
        city: Option<String>,
        #[serde(default)]
        features: Vec<ServerFeature>,
    },
    Server {
        id: ServerId,
    },
}

impl ConnectTarget {
    pub fn smart(mode: SmartMode) -> Self {
        Self::Smart { mode, country: None, city: None, features: Vec::new() }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SmartMode {
    /// Lowest round-trip time measured from this device.
    Fastest,
    /// Shortest great-circle distance from the approximate location of the
    /// last unprotected IP.
    Nearest,
    LowestLoad,
    /// Weighted blend of latency, load, distance and fleet health.
    BestOverall,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RelaySummary {
    pub server_id: ServerId,
    pub hostname: String,
    pub country_code: String,
    pub country: String,
    pub city: String,
    pub protocol: Protocol,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConnectedDetails {
    pub relay: RelaySummary,
    #[ts(type = "string")]
    pub endpoint: SocketAddr,
    #[ts(type = "string | null")]
    pub tunnel_ipv4: Option<Ipv4Addr>,
    #[ts(type = "string | null")]
    pub tunnel_ipv6: Option<Ipv6Addr>,
    /// The resolvers the system is actually using through the tunnel.
    #[ts(type = "Array<string>")]
    pub dns_servers: Vec<IpAddr>,
    pub dns_mode: crate::DnsMode,
    pub mtu: u16,
    pub interface: InterfaceInfo,
    pub cipher: CipherSuite,
    #[ts(type = "number")]
    pub connected_at: UnixMillis,
    #[ts(type = "number | null")]
    pub last_handshake: Option<UnixMillis>,
    pub protections: Protections,
    /// Base64 public keys, for the advanced view.
    pub local_public_key: String,
    pub server_public_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InterfaceInfo {
    pub name: String,
    pub index: Option<u32>,
    /// Windows NET_LUID, for the advanced view.
    #[ts(type = "number | null")]
    pub luid: Option<u64>,
}

/// The cryptographic construction of the active protocol, as a fact about
/// the protocol (WireGuard's is fixed by the spec).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CipherSuite {
    /// e.g. `Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s`
    pub handshake: String,
    /// e.g. `ChaCha20-Poly1305`
    pub data: String,
    /// e.g. `Curve25519`
    pub key_exchange: String,
}

impl CipherSuite {
    pub fn wireguard() -> Self {
        Self {
            handshake: "Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s".into(),
            data: "ChaCha20-Poly1305".into(),
            key_exchange: "Curve25519".into(),
        }
    }
}

/// Protections the service has *applied and confirmed* for this session.
/// `false` means not active, never "unknown": unknowns are reported by the
/// security check, not here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Protections {
    pub kill_switch: bool,
    pub dns_leak_blocking: bool,
    pub ipv6_leak_blocking: bool,
    /// IPv6 is carried inside the tunnel.
    pub ipv6_tunneled: bool,
    pub split_tunnel: crate::SplitTunnelStatus,
}
