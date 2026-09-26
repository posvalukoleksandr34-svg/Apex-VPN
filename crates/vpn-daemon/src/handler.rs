//! IPC request dispatch.

use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;
use tokio::sync::broadcast;
use vpn_ipc::{ConnectionInfo, Handler};
use vpn_types::ipc::{Event, Request};
use vpn_types::{IpcError, IpcErrorKind};

use crate::daemon::Daemon;

pub struct IpcHandler {
    pub daemon: Arc<Daemon>,
}

fn json<T: Serialize>(v: T) -> Result<serde_json::Value, IpcError> {
    serde_json::to_value(v).map_err(|e| IpcError::new(IpcErrorKind::Failed, e.to_string()))
}

#[async_trait]
impl Handler for IpcHandler {
    async fn handle(&self, conn: &ConnectionInfo, request: Request) -> Result<serde_json::Value, IpcError> {
        let d = &self.daemon;
        match request {
            Request::Hello { .. } | Request::Subscribe => json(()),
            Request::GetState => json(d.state.borrow().clone()),
            Request::Connect { target } => {
                tracing::info!(conn = conn.id, pid = ?conn.pid, "connect requested");
                d.connect(target).await?;
                json(())
            }
            Request::Disconnect => {
                tracing::info!(conn = conn.id, pid = ?conn.pid, "disconnect requested");
                d.disconnect().await;
                json(())
            }
            Request::Reconnect => {
                d.reconnect();
                json(())
            }
            Request::GetSettings => json(d.settings.read().expect("settings").clone()),
            Request::UpdateSettings { patch } => json(d.update_settings(patch).await?),
            Request::ResetSettings => json(d.reset_settings().await?),
            Request::GetCapabilities => json(d.capabilities()),
            Request::GetRelayList => json(d.relay_reply()),
            Request::RefreshRelayList => match d.refresh_relays().await {
                Ok(status) => json(status),
                Err(kind) => Err(IpcError::from_error_kind(kind, "refreshing the server list failed")),
            },
            Request::GetLatencies => json(d.latencies()),
            Request::MeasureLatencies { server_ids } => json(d.measure_latencies(server_ids).await),
            Request::GetDevice => json(d.device_info()),
            Request::SetDeviceRegistration { registration } => json(d.set_registration(registration)?),
            Request::ClearDeviceRegistration => json(d.clear_registration()),
            Request::RotateDeviceKey => json(d.rotate_key()?),
            Request::GetStats => json(*d.stats.borrow()),
            Request::GetConnectionReport => json(d.connection_report().await),
            Request::GetNetwork => json(d.platform.network.current()),
            Request::CheckIp => json(d.check_ip().await?),
            Request::GetIpObservations => json(d.ip_observations()),
            Request::RunLeakTests => json(crate::leaks::run(d).await),
            Request::TestDns { servers } => json(d.test_dns(servers).await),
            Request::RunDiagnostics { checks } => json(crate::diagnostics::run(d, checks).await),
            Request::GetLogs { query } => json(d.log.query(&query)),
            Request::ExportLogs => {
                let caps = d.capabilities();
                let header = format!(
                    "Meridian connection log\nservice {} on {:?} {} ({})\nexported {} — IP addresses {}\n",
                    caps.service_version,
                    caps.os.family,
                    caps.os.version,
                    caps.os.arch,
                    vpn_types::time::now_millis(),
                    if d.log.diagnostic_mode() { "NOT masked (diagnostic mode)" } else { "masked" },
                );
                json(d.log.export_text(&header))
            }
            Request::ClearLogs => {
                d.log.clear();
                json(())
            }
        }
    }

    fn events(&self) -> broadcast::Receiver<Event> {
        self.daemon.events.subscribe()
    }

    fn service_version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}
