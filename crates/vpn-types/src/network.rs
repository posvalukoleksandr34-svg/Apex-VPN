use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use ts_rs::TS;

use crate::UnixMillis;

/// The physical networks the service sees (outside the tunnel).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NetworkSnapshot {
    /// There is a default route on a non-tunnel interface.
    pub online: bool,
    /// The interface currently holding the best default route.
    pub primary: Option<PhysicalNetwork>,
    pub networks: Vec<PhysicalNetwork>,
    #[ts(type = "number")]
    pub observed_at: UnixMillis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PhysicalNetwork {
    /// Stable identifier of the interface (Windows: interface GUID).
    pub id: String,
    pub interface_name: String,
    pub medium: NetworkMedium,
    /// Wi-Fi only.
    pub ssid: Option<String>,
    pub wifi_security: Option<WifiSecurity>,
    pub has_ipv4: bool,
    pub has_ipv6: bool,
    #[ts(type = "Array<string>")]
    pub dns_servers: Vec<IpAddr>,
    #[ts(type = "string | null")]
    pub gateway: Option<IpAddr>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum NetworkMedium {
    Wifi,
    Ethernet,
    Cellular,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum WifiSecurity {
    Open,
    Protected,
}

/// What an external service saw as this device's address. Produced by
/// `GET /v1/network/ip` on the backend; geo fields are `None` when the
/// backend has no GeoIP database configured.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IpObservation {
    #[ts(type = "string")]
    pub ip: IpAddr,
    pub country_code: Option<String>,
    pub country: Option<String>,
    pub city: Option<String>,
    pub timezone: Option<String>,
    pub asn: Option<u32>,
    pub organization: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    #[ts(type = "number")]
    pub observed_at: UnixMillis,
    /// The tunnel was connected when this was observed.
    pub via_tunnel: bool,
}

/// Outcome of each leak test.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LeakVerdict {
    Protected,
    PotentialLeak,
    UnableToVerify,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LeakTestResult {
    pub test: LeakTest,
    pub verdict: LeakVerdict,
    /// Stable code for the explanation (`leak.findings.<code>`).
    pub finding: String,
    /// Addresses observed during the test (redacted in logs, shown in UI).
    #[ts(type = "Array<string>")]
    pub observed: Vec<IpAddr>,
    #[ts(type = "Array<string>")]
    pub expected: Vec<IpAddr>,
    #[ts(type = "number")]
    pub tested_at: UnixMillis,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LeakTest {
    Ipv4,
    Ipv6,
    Dns,
    /// Run in the WebView by the app (WebRTC is a browser-engine concern).
    Webrtc,
}
