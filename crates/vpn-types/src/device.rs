use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, Ipv6Addr};
use ts_rs::TS;

use crate::UnixMillis;

/// The device's WireGuard identity. The private key never leaves the service.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeviceInfo {
    /// Base64 Curve25519 public key.
    pub public_key: String,
    #[ts(type = "number")]
    pub key_created_at: UnixMillis,
    pub registration: Option<DeviceRegistration>,
}

/// What the backend assigned to this device's key. The desktop app obtains
/// it with the user's session and hands it to the service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeviceRegistration {
    pub device_id: String,
    /// The public key the backend registered. Must equal the service's key.
    pub public_key: String,
    #[ts(type = "string")]
    pub ipv4_address: Ipv4Addr,
    #[ts(type = "string | null")]
    pub ipv6_address: Option<Ipv6Addr>,
    /// Entitlement expiry. After it the backend removes the peer from nodes.
    #[ts(type = "number | null")]
    pub valid_until: Option<UnixMillis>,
}
