//! The bridge to `meridiand`. One IPC connection, kept alive for the life of
//! the app: service events are forwarded to the WebView as they arrive, and
//! the WebView's requests are checked against the protocol before they are
//! passed on.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{broadcast, Notify};
use vpn_ipc::IpcClient;
use vpn_types::brand::IPC_PATH;
use vpn_types::ipc::{ClientKind, Event, Request};
use vpn_types::Capabilities;

use crate::error::{CoreError, CoreResult};

pub const EVENT: &str = "service://event";
pub const STATUS: &str = "service://status";

/// Account API address baked in at build time (`MERIDIAN_API_URL`), used
/// only until the service has told the app its configured address.
const BUILD_API_URL: Option<&str> = option_env!("MERIDIAN_API_URL");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceStatus {
    /// Trying to reach the service (at start, or after the user asked).
    Connecting,
    Ready,
    Unavailable,
}

pub struct ServiceBridge {
    client: Mutex<Option<IpcClient>>,
    status: Mutex<ServiceStatus>,
    retry_now: Notify,
    /// The account service's address, as the service is configured. Cached on
    /// disk so sign-in state can be checked before the service is reachable.
    api_base_url: Mutex<Option<String>>,
    endpoint_file: Option<PathBuf>,
}

impl ServiceBridge {
    pub fn new(endpoint_file: Option<PathBuf>) -> Self {
        // The service's configuration wins once it's reached; until then the
        // last address it reported, then the one this build was made for.
        let cached = endpoint_file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).map(|s| s.trim().to_owned());
        let initial = cached.into_iter().chain(BUILD_API_URL.map(str::to_owned)).find(|s| valid_api_url(s));
        Self {
            client: Mutex::new(None),
            status: Mutex::new(ServiceStatus::Connecting),
            retry_now: Notify::new(),
            api_base_url: Mutex::new(initial),
            endpoint_file,
        }
    }

    pub fn client(&self) -> Option<IpcClient> {
        self.client.lock().expect("client").clone().filter(|c| !c.is_closed())
    }

    pub fn api_base_url(&self) -> Option<String> {
        self.api_base_url.lock().expect("api url").clone()
    }

    fn set_status(&self, app: &AppHandle, status: ServiceStatus) {
        let mut current = self.status.lock().expect("status");
        if *current != status {
            *current = status;
            let _ = app.emit(STATUS, status);
        }
    }

    /// Runs for the life of the app.
    pub async fn run(self: Arc<Self>, app: AppHandle) {
        let mut delay = Duration::from_millis(500);
        loop {
            match self.connect().await {
                Ok((client, events)) => {
                    delay = Duration::from_millis(500);
                    *self.client.lock().expect("client") = Some(client.clone());
                    self.set_status(&app, ServiceStatus::Ready);
                    self.forward(&app, &client, events).await;
                    *self.client.lock().expect("client") = None;
                    tracing::warn!("lost the connection to the VPN service");
                }
                Err(e) => tracing::debug!("VPN service not reachable: {e}"),
            }
            // Retries in the background stay "unavailable"; only an explicit
            // retry shows "connecting", so the UI doesn't flicker every few
            // seconds while the service is down.
            self.set_status(&app, ServiceStatus::Unavailable);
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = self.retry_now.notified() => self.set_status(&app, ServiceStatus::Connecting),
            }
            delay = (delay * 2).min(Duration::from_secs(5));
        }
    }

    async fn connect(&self) -> CoreResult<(IpcClient, broadcast::Receiver<Event>)> {
        let client = IpcClient::connect(IPC_PATH, ClientKind::Desktop).await?;
        let events = client.subscribe().await?;
        match client.call::<Capabilities>(Request::GetCapabilities).await {
            Ok(caps) => self.remember_api(&caps.api_base_url),
            Err(e) => tracing::warn!("could not read the service's capabilities: {e}"),
        }
        tracing::info!(version = %client.service_version, "connected to the VPN service");
        Ok((client, events))
    }

    fn remember_api(&self, url: &str) {
        let url = url.trim_end_matches('/').to_owned();
        if !valid_api_url(&url) {
            tracing::error!("the service's account API address is not https (or loopback) and will not be used: {url}");
            return;
        }
        let mut current = self.api_base_url.lock().expect("api url");
        if current.as_deref() != Some(url.as_str()) {
            if let Some(file) = &self.endpoint_file {
                let _ = file.parent().map(std::fs::create_dir_all);
                if let Err(e) = std::fs::write(file, &url) {
                    tracing::warn!("could not cache the account API address: {e}");
                }
            }
            *current = Some(url);
        }
    }

    async fn forward(&self, app: &AppHandle, client: &IpcClient, mut events: broadcast::Receiver<Event>) {
        // The receiver doesn't close when the pipe does (the client keeps a
        // sender), so the connection is also polled.
        let mut check = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                event = events.recv() => match event {
                    Ok(event) => { let _ = app.emit(EVENT, &event); }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        // Events were dropped: "ready" makes the UI reload everything.
                        tracing::warn!("dropped {n} service events; asking the UI to resync");
                        let _ = app.emit(STATUS, ServiceStatus::Ready);
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                _ = check.tick() => if client.is_closed() { return },
            }
        }
    }
}

/// https, or plain http only to this machine (local development).
pub fn valid_api_url(url: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else { return false };
    if !u.username().is_empty() || u.password().is_some() || u.query().is_some() || u.fragment().is_some() {
        return false;
    }
    let Some(host) = u.host_str() else { return false };
    match u.scheme() {
        "https" => true,
        "http" => host == "localhost" || host.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()),
        _ => false,
    }
}

/// Requests only the core itself may send.
fn reserved(request: &Request) -> bool {
    // Hello/Subscribe manage the connection; the registration must come from
    // the account service via `account_enroll_device`, not from page script.
    matches!(request, Request::Hello { .. } | Request::Subscribe | Request::SetDeviceRegistration { .. })
}

#[tauri::command]
pub async fn service_request(bridge: State<'_, Arc<ServiceBridge>>, request: serde_json::Value) -> CoreResult<serde_json::Value> {
    let request: Request =
        serde_json::from_value(request).map_err(|e| CoreError::service("invalid_request", e.to_string(), None))?;
    if reserved(&request) {
        return Err(CoreError::rejected("this request is reserved for the app core"));
    }
    let client = bridge.client().ok_or_else(CoreError::service_unavailable)?;
    Ok(client.call(request).await?)
}

#[tauri::command]
pub fn service_status(bridge: State<'_, Arc<ServiceBridge>>) -> ServiceStatus {
    *bridge.status.lock().expect("status")
}

#[tauri::command]
pub fn service_reconnect(bridge: State<'_, Arc<ServiceBridge>>) {
    bridge.retry_now.notify_one();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn api_urls() {
        assert!(valid_api_url("https://api.example.com"));
        assert!(valid_api_url("http://127.0.0.1:8787"));
        assert!(valid_api_url("http://localhost:8787"));
        assert!(!valid_api_url("http://api.example.com"));
        assert!(valid_api_url("http://[::1]:8787"));
        assert!(!valid_api_url("http://127.0.0.1.evil.example:80"));
        assert!(!valid_api_url("http://127.0.0.1:8787@evil.example"));
        assert!(!valid_api_url("https://user:pw@api.example.com"));
        assert!(!valid_api_url("https://"));
        assert!(!valid_api_url("ftp://x"));
    }

    #[test]
    fn page_script_cannot_register_devices_or_manage_the_connection() {
        let parse = |v: serde_json::Value| serde_json::from_value::<Request>(v).unwrap();
        assert!(reserved(&parse(json!({ "method": "subscribe" }))));
        assert!(reserved(&parse(json!({ "method": "hello", "params": { "protocolVersion": 1, "client": "desktop" } }))));
        assert!(!reserved(&parse(json!({ "method": "get_state" }))));
        assert!(!reserved(&parse(json!({ "method": "clear_device_registration" }))));
    }
}
