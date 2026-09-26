use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::UnixMillis;

/// Raw counters read from the tunnel driver. Speeds are derived by the
/// consumer from two consecutive samples; nothing here is estimated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TunnelStats {
    #[ts(type = "number")]
    pub rx_bytes: u64,
    #[ts(type = "number")]
    pub tx_bytes: u64,
    #[ts(type = "number | null")]
    pub last_handshake: Option<UnixMillis>,
    #[ts(type = "number")]
    pub sampled_at: UnixMillis,
}
