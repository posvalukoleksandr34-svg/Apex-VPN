//! Settings owned and persisted by the service. UI-only preferences (theme,
//! language, window behaviour) live in the desktop app, not here.

use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use ts_rs::TS;

use crate::ConnectTarget;

pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct Settings {
    pub schema_version: u32,
    pub protocol: ProtocolPreference,
    pub kill_switch: KillSwitchMode,
    pub allow_lan: bool,
    pub dns: DnsSettings,
    pub network: NetworkSettings,
    pub split_tunnel: SplitTunnelSettings,
    pub auto_connect: AutoConnectSettings,
    pub trusted_networks: Vec<TrustedNetwork>,
    /// Used by "Connect" when no explicit target is given.
    pub default_target: ConnectTarget,
    /// Last successfully connected target ("Last used" quick action).
    pub last_target: Option<ConnectTarget>,
    pub logging: LoggingSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            protocol: ProtocolPreference::Automatic,
            kill_switch: KillSwitchMode::WhileConnected,
            allow_lan: true,
            dns: DnsSettings::default(),
            network: NetworkSettings::default(),
            split_tunnel: SplitTunnelSettings::default(),
            auto_connect: AutoConnectSettings::default(),
            trusted_networks: Vec::new(),
            default_target: ConnectTarget::smart(crate::SmartMode::BestOverall),
            last_target: None,
            logging: LoggingSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Protocol {
    #[serde(rename = "wireguard")]
    WireGuard,
    #[serde(rename = "openvpn")]
    OpenVpn,
    Ikev2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ProtocolPreference {
    /// The service picks among the protocols this build and the chosen
    /// server both support, WireGuard first.
    Automatic,
    #[serde(rename = "wireguard")]
    WireGuard,
    #[serde(rename = "openvpn")]
    OpenVpn,
    Ikev2,
}

impl ProtocolPreference {
    pub fn fixed(self) -> Option<Protocol> {
        match self {
            Self::Automatic => None,
            Self::WireGuard => Some(Protocol::WireGuard),
            Self::OpenVpn => Some(Protocol::OpenVpn),
            Self::Ikev2 => Some(Protocol::Ikev2),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum KillSwitchMode {
    /// No firewall rules. Traffic can leave unprotected while (re)connecting.
    Off,
    /// Blocks traffic outside the tunnel from "Connect" until the user
    /// disconnects, including every reconnect and error in between.
    WhileConnected,
    /// Blocks traffic outside the tunnel at all times, even when
    /// disconnected, from boot.
    AlwaysOn,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct DnsSettings {
    pub mode: DnsMode,
    #[ts(type = "Array<string>")]
    pub custom_servers: Vec<IpAddr>,
    /// Drop DNS (port 53) to anything but the resolver in use while connected.
    pub block_leaks: bool,
}

impl Default for DnsSettings {
    fn default() -> Self {
        Self { mode: DnsMode::Vpn, custom_servers: Vec::new(), block_leaks: true }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DnsMode {
    /// The resolver running on the VPN server, reached through the tunnel.
    Vpn,
    /// User-chosen resolvers, reached through the tunnel.
    Custom,
    /// Leave the operating system's DNS alone ("Automatic" in the UI). Lookups
    /// may go to the local network's resolver outside the tunnel.
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct NetworkSettings {
    /// Route IPv6 through the tunnel when the server supports it.
    pub enable_ipv6: bool,
    /// While connected, drop IPv6 that would leave outside the tunnel.
    pub block_ipv6_leaks: bool,
    /// `None` = automatic (1420 for WireGuard over IPv4, 1400 over IPv6 paths).
    pub mtu: Option<u16>,
    pub reconnect: ReconnectBehavior,
    /// Seconds. WireGuard keepalive keeps NAT mappings open.
    pub persistent_keepalive: u16,
}

impl Default for NetworkSettings {
    fn default() -> Self {
        Self {
            enable_ipv6: true,
            block_ipv6_leaks: true,
            mtu: None,
            reconnect: ReconnectBehavior::default(),
            persistent_keepalive: 25,
        }
    }
}

pub const MTU_MIN: u16 = 1280;
pub const MTU_MAX: u16 = 1500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct ReconnectBehavior {
    /// Rebuild the tunnel automatically when it drops.
    pub auto_reconnect: bool,
    /// Give up after this many consecutive attempts (0 = never give up).
    pub max_attempts: u32,
    /// After this many failed attempts on one server, move to the next best.
    pub switch_server_after: u32,
}

impl Default for ReconnectBehavior {
    fn default() -> Self {
        Self { auto_reconnect: true, max_attempts: 0, switch_server_after: 3 }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct SplitTunnelSettings {
    pub mode: SplitTunnelMode,
    pub apps: Vec<SplitTunnelApp>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SplitTunnelMode {
    /// Route all traffic through the VPN.
    #[default]
    Off,
    /// Listed apps bypass the VPN.
    ExcludeApps,
    /// Only listed apps use the VPN.
    OnlyApps,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SplitTunnelApp {
    /// Absolute path to the executable.
    pub path: String,
    pub name: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct AutoConnectSettings {
    /// Connect when the service starts (i.e. at system startup), before
    /// anyone signs in.
    pub on_system_start: bool,
    /// Connect when joining a network that is not in the trusted list.
    pub on_untrusted_network: bool,
    /// Treat open (password-less) Wi-Fi as untrusted even if listed.
    pub on_open_wifi: bool,
    /// When the tunnel was up and the internet dropped, reconnect as soon as
    /// it returns.
    pub reconnect_when_online: bool,
}

impl Default for AutoConnectSettings {
    fn default() -> Self {
        Self {
            on_system_start: false,
            on_untrusted_network: false,
            on_open_wifi: true,
            reconnect_when_online: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TrustedNetwork {
    pub id: String,
    pub name: String,
    /// Wi-Fi SSID. `None` for wired networks, matched by the network's
    /// identity instead.
    pub ssid: Option<String>,
    pub policy: TrustedNetworkPolicy,
    pub kind: NetworkKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TrustedNetworkPolicy {
    /// Always connect on this network.
    RequireVpn,
    /// Don't auto-connect; the user decides.
    Optional,
    /// Disconnect on this network (never with the Always-On kill switch).
    Bypass,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum NetworkKind {
    Home,
    Work,
    Public,
    Travel,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct LoggingSettings {
    pub level: LogLevel,
    /// Stop masking IP addresses and keys in the service log. Turn it on only
    /// while reproducing a problem.
    pub diagnostic_mode: bool,
}

impl Default for LoggingSettings {
    fn default() -> Self {
        Self { level: LogLevel::Info, diagnostic_mode: false }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
}

/// A partial update. Every field is optional; only present fields change.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct SettingsPatch {
    pub protocol: Option<ProtocolPreference>,
    pub kill_switch: Option<KillSwitchMode>,
    pub allow_lan: Option<bool>,
    pub dns: Option<DnsSettings>,
    pub network: Option<NetworkSettings>,
    pub split_tunnel: Option<SplitTunnelSettings>,
    pub auto_connect: Option<AutoConnectSettings>,
    pub trusted_networks: Option<Vec<TrustedNetwork>>,
    pub default_target: Option<ConnectTarget>,
    pub logging: Option<LoggingSettings>,
}
