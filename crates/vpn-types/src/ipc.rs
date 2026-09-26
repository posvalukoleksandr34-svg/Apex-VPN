//! Local IPC between clients (desktop app, CLI) and the service.
//!
//! Framing: one JSON document per line (UTF-8, `\n`-terminated, max 1 MiB).
//! A client sends `RequestFrame`s and receives `ServerFrame`s. Events are only
//! sent to connections that sent `Subscribe`.
//!
//! Security notes:
//! * No request makes the service (running as SYSTEM/root) read or write a
//!   caller-supplied path. Exports return content; the caller saves it.
//! * `Connect` can only target servers from the signed relay list.

use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use ts_rs::TS;

use crate::{
    CheckId, ConnectTarget, DeviceInfo, DeviceRegistration, IpcError, LatencySample, LogEntry,
    LogQuery, NetworkSnapshot, RelayListStatus, ServerId, Settings, SettingsPatch, TunnelState,
    TunnelStats,
};

/// Hard upper bound for one frame, both directions.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RequestFrame {
    #[ts(type = "number")]
    pub id: u64,
    pub request: Request,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "method", content = "params", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum Request {
    /// Must be the first request on a connection.
    Hello { protocol_version: u32, client: ClientKind },
    Subscribe,

    GetState,
    /// `None` = the default target from settings.
    Connect { target: Option<ConnectTarget> },
    Disconnect,
    Reconnect,

    GetSettings,
    UpdateSettings { patch: SettingsPatch },
    ResetSettings,
    GetCapabilities,

    GetRelayList,
    RefreshRelayList,
    GetLatencies,
    MeasureLatencies { server_ids: Option<Vec<ServerId>> },

    GetDevice,
    SetDeviceRegistration { registration: DeviceRegistration },
    ClearDeviceRegistration,
    /// Generates a new key pair and drops the registration. The app must
    /// register the new key with the backend.
    RotateDeviceKey,

    GetStats,
    GetConnectionReport,
    GetNetwork,
    CheckIp,
    GetIpObservations,
    RunLeakTests,
    TestDns {
        #[ts(type = "Array<string> | null")]
        servers: Option<Vec<IpAddr>>,
    },
    RunDiagnostics { checks: Option<Vec<CheckId>> },

    GetLogs { query: LogQuery },
    /// Returns the redacted log as text; the client chooses where to save it.
    ExportLogs,
    ClearLogs,
}

impl Request {
    pub fn method(&self) -> &'static str {
        match self {
            Self::Hello { .. } => "hello",
            Self::Subscribe => "subscribe",
            Self::GetState => "get_state",
            Self::Connect { .. } => "connect",
            Self::Disconnect => "disconnect",
            Self::Reconnect => "reconnect",
            Self::GetSettings => "get_settings",
            Self::UpdateSettings { .. } => "update_settings",
            Self::ResetSettings => "reset_settings",
            Self::GetCapabilities => "get_capabilities",
            Self::GetRelayList => "get_relay_list",
            Self::RefreshRelayList => "refresh_relay_list",
            Self::GetLatencies => "get_latencies",
            Self::MeasureLatencies { .. } => "measure_latencies",
            Self::GetDevice => "get_device",
            Self::SetDeviceRegistration { .. } => "set_device_registration",
            Self::ClearDeviceRegistration => "clear_device_registration",
            Self::RotateDeviceKey => "rotate_device_key",
            Self::GetStats => "get_stats",
            Self::GetConnectionReport => "get_connection_report",
            Self::GetNetwork => "get_network",
            Self::CheckIp => "check_ip",
            Self::GetIpObservations => "get_ip_observations",
            Self::RunLeakTests => "run_leak_tests",
            Self::TestDns { .. } => "test_dns",
            Self::RunDiagnostics { .. } => "run_diagnostics",
            Self::GetLogs { .. } => "get_logs",
            Self::ExportLogs => "export_logs",
            Self::ClearLogs => "clear_logs",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ClientKind {
    Desktop,
    Cli,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum ServerFrame {
    Response {
        #[ts(type = "number")]
        id: u64,
        #[ts(type = "unknown")]
        result: Option<serde_json::Value>,
        error: Option<IpcError>,
    },
    Event { event: Event },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
#[ts(export)]
pub enum Event {
    TunnelState(TunnelState),
    Stats(TunnelStats),
    Settings(Box<Settings>),
    RelayList(RelayListStatus),
    Latencies(Vec<LatencySample>),
    Network(NetworkSnapshot),
    Device(DeviceInfo),
    Log(LogEntry),
}

/// Reply to `Hello`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelloReply {
    pub protocol_version: u32,
    pub service_version: String,
}

/// Reply to `GetRelayList`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RelayListReply {
    pub status: RelayListStatus,
    pub list: Option<crate::RelayList>,
}

/// Reply to `GetIpObservations`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IpObservations {
    /// Most recent observation taken while the tunnel was *not* up: the
    /// user's own address ("Original IP").
    pub unprotected: Option<crate::IpObservation>,
    /// Most recent observation taken through the tunnel.
    pub protected: Option<crate::IpObservation>,
}

/// Reply to `TestDns`, one per resolver.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DnsTestResult {
    #[ts(type = "string")]
    pub server: IpAddr,
    pub query: String,
    pub ok: bool,
    pub rtt_ms: Option<u32>,
    /// DNS RCODE name or transport error code.
    pub outcome: String,
    #[ts(type = "Array<string>")]
    pub answers: Vec<IpAddr>,
}

/// Reply to `GetConnectionReport`: everything the Connection Details and
/// Security pages show, captured at one instant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConnectionReport {
    pub state: TunnelState,
    pub stats: Option<TunnelStats>,
    pub firewall: FirewallSummary,
    /// DNS servers configured on the tunnel interface right now, read back
    /// from the OS (not what we asked for).
    #[ts(type = "Array<string>")]
    pub effective_dns: Vec<IpAddr>,
    pub routes: Vec<RouteSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FirewallSummary {
    /// Policy the service believes is applied, and whether reading it back
    /// from the OS confirmed it.
    pub policy: String,
    pub verified: bool,
    pub filter_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RouteSummary {
    pub destination: String,
    pub interface: String,
    pub metric: u32,
}
