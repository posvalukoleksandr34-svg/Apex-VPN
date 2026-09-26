use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::UnixMillis;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CheckId {
    Internet,
    Dns,
    Service,
    /// Performed by the desktop app (it holds the session), not the service.
    Authentication,
    ServerReachability,
    Tunnel,
    Routing,
    KillSwitch,
    Ipv6,
}

impl CheckId {
    pub const SERVICE_CHECKS: [CheckId; 8] = [
        CheckId::Internet,
        CheckId::Dns,
        CheckId::Service,
        CheckId::ServerReachability,
        CheckId::Tunnel,
        CheckId::Routing,
        CheckId::KillSwitch,
        CheckId::Ipv6,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CheckStatus {
    Working,
    Warning,
    Failed,
    /// Not applicable right now (e.g. tunnel check while disconnected).
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CheckResult {
    pub id: CheckId,
    pub status: CheckStatus,
    /// Stable finding code; the UI maps it to `diagnostics.findings.<code>.*`
    /// (summary, causes, actions).
    pub finding: String,
    /// Observed facts backing the finding (e.g. `{"rttMs": 23}`), shown in
    /// the report. Redacted unless diagnostic mode is on.
    #[ts(type = "Record<string, unknown>")]
    pub evidence: serde_json::Map<String, serde_json::Value>,
    #[ts(type = "number")]
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiagnosticsReport {
    #[ts(type = "number")]
    pub generated_at: UnixMillis,
    pub service_version: String,
    pub os: crate::OsInfo,
    pub tunnel_state: String,
    pub checks: Vec<CheckResult>,
}
