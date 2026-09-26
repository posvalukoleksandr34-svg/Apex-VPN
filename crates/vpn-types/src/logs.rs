use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{LogLevel, UnixMillis};

/// One structured event in the connection log. Events describe what the
/// service did, never what the user's traffic contained.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LogEntry {
    #[ts(type = "number")]
    pub seq: u64,
    #[ts(type = "number")]
    pub at: UnixMillis,
    pub level: LogLevel,
    pub category: LogCategory,
    /// Stable event code, e.g. `connect.attempt`, `dns.apply_failed`.
    pub event: String,
    /// Human-readable, redacted.
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LogCategory {
    Connection,
    Server,
    Protocol,
    Auth,
    Dns,
    Network,
    Firewall,
    Service,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct LogQuery {
    #[ts(type = "number | null")]
    pub after_seq: Option<u64>,
    pub min_level: Option<LogLevel>,
    pub category: Option<LogCategory>,
    pub limit: Option<u32>,
}
