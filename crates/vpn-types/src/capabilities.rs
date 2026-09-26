//! What this build can do on this machine. The UI reads capabilities instead
//! of assuming, so an integration point is shown as unavailable rather
//! than pretending to work.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::Protocol;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Capabilities {
    pub service_version: String,
    /// The backend this service trusts (from its protected configuration).
    /// Clients use it for account calls so everything talks to one backend.
    pub api_base_url: String,
    pub os: OsInfo,
    pub protocols: Vec<ProtocolCapability>,
    pub kill_switch: Availability,
    pub split_tunnel: Availability,
    pub wifi_detection: Availability,
    pub ipv6: Availability,
    /// Present when the build contains the development simulator.
    pub simulated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OsInfo {
    pub family: OsFamily,
    pub version: String,
    pub arch: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum OsFamily {
    Windows,
    Macos,
    Linux,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProtocolCapability {
    pub protocol: Protocol,
    pub availability: Availability,
    /// e.g. the WireGuardNT driver version.
    pub implementation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "status", content = "reason", rename_all = "snake_case")]
#[ts(export)]
pub enum Availability {
    Available,
    Unavailable(UnavailableReason),
}

impl Availability {
    pub fn is_available(&self) -> bool {
        matches!(self, Self::Available)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum UnavailableReason {
    /// Implementation exists as an integration point only.
    NotBundled,
    /// Needs a driver or system component that isn't installed.
    DriverMissing,
    /// The OS version is too old or the platform has no implementation yet.
    UnsupportedPlatform,
    /// Available, but the service is missing privileges.
    PermissionDenied,
}

/// Where split tunnelling stands right now (reported per connection).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SplitTunnelStatus {
    /// Mode is Off: all traffic goes through the tunnel.
    Inactive,
    /// Rules are configured and enforced.
    Enforced,
    /// Rules are configured but the platform can't enforce them. All
    /// traffic still goes through the tunnel.
    NotEnforced,
}
