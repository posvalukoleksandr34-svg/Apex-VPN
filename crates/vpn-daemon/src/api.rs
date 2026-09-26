//! The service's (unauthenticated) view of the backend: the signed relay
//! list, "what's my IP", and a health endpoint. Account calls are made by
//! the desktop app, never by the service.

use std::net::SocketAddr;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use serde::Deserialize;
use vpn_types::time::now_millis;
use vpn_types::{IpObservation, SignedRelayList};

pub struct ApiClient {
    base: String,
    host: String,
    port: u16,
    client: RwLock<reqwest::Client>,
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("API unreachable: {0}")]
    Unreachable(String),
    #[error("API returned HTTP {0}")]
    Status(u16),
    #[error("API response invalid: {0}")]
    Decode(String),
    /// The IP check answered with a loopback/private address: the check
    /// service is on this machine or network and can't see the public one.
    #[error("the IP check service saw {0}, which is not a public address; it is on this machine or network and can't observe your public IP")]
    NotPublic(std::net::IpAddr),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IpResponse {
    ip: std::net::IpAddr,
    country_code: Option<String>,
    country: Option<String>,
    city: Option<String>,
    timezone: Option<String>,
    asn: Option<u32>,
    organization: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
}

impl ApiClient {
    pub fn new(base: &str) -> anyhow::Result<Self> {
        let url = reqwest::Url::parse(base)?;
        let host = url.host_str().ok_or_else(|| anyhow::anyhow!("API URL has no host"))?.to_string();
        let port = url.port_or_known_default().unwrap_or(443);
        let client = build_client(&host, &[])?;
        Ok(Self { base: base.trim_end_matches('/').to_string(), host, port, client: RwLock::new(client) })
    }

    /// Pins the API host to already-resolved addresses. While the kill
    /// switch blocks DNS, the service can still reach the API through its
    /// firewall exception.
    pub fn pin_addresses(&self, addrs: &[SocketAddr]) {
        if let Ok(c) = build_client(&self.host, addrs) {
            *self.client.write().expect("api client") = c;
        }
    }

    pub async fn resolve(&self) -> Vec<SocketAddr> {
        match tokio::net::lookup_host((self.host.as_str(), self.port)).await {
            Ok(addrs) => addrs.collect(),
            Err(_) => Vec::new(),
        }
    }

    fn client(&self) -> reqwest::Client {
        self.client.read().expect("api client").clone()
    }

    pub async fn relays(&self) -> Result<SignedRelayList, ApiError> {
        self.get_json("/v1/servers/relays").await
    }

    pub async fn check_ip(&self, via_tunnel: bool) -> Result<IpObservation, ApiError> {
        let r: IpResponse = self.get_json("/v1/network/ip").await?;
        if !vpn_core::relay::is_global(r.ip) {
            return Err(ApiError::NotPublic(r.ip));
        }
        Ok(IpObservation {
            ip: r.ip,
            country_code: r.country_code,
            country: r.country,
            city: r.city,
            timezone: r.timezone,
            asn: r.asn,
            organization: r.organization,
            latitude: r.latitude,
            longitude: r.longitude,
            observed_at: now_millis(),
            via_tunnel,
        })
    }

    /// Round trip to the health endpoint.
    pub async fn health(&self) -> Result<Duration, ApiError> {
        let started = Instant::now();
        let resp = self
            .client()
            .get(format!("{}/v1/health", self.base))
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(ApiError::Status(resp.status().as_u16()));
        }
        Ok(started.elapsed())
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, ApiError> {
        let resp = self
            .client()
            .get(format!("{}{path}", self.base))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| ApiError::Unreachable(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(ApiError::Status(resp.status().as_u16()));
        }
        resp.json().await.map_err(|e| ApiError::Decode(e.to_string()))
    }
}

fn build_client(host: &str, pinned: &[SocketAddr]) -> anyhow::Result<reqwest::Client> {
    let mut b = reqwest::Client::builder()
        .user_agent(concat!("meridiand/", env!("CARGO_PKG_VERSION")))
        .https_only(false)
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none());
    if !pinned.is_empty() {
        b = b.resolve_to_addrs(host, pinned);
    }
    Ok(b.build()?)
}
