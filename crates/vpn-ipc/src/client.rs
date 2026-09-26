use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde::de::DeserializeOwned;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_util::codec::{FramedRead, FramedWrite};
use vpn_types::brand::IPC_PROTOCOL_VERSION;
use vpn_types::ipc::{ClientKind, Event, HelloReply, Request, RequestFrame, ServerFrame};
use vpn_types::IpcError;

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    /// The service isn't running (no pipe/socket) or refused us.
    #[error("the VPN service is not reachable: {0}")]
    Unavailable(std::io::Error),
    #[error("the connection to the VPN service was lost")]
    Disconnected,
    #[error("the VPN service did not answer in time")]
    Timeout,
    #[error(transparent)]
    Service(#[from] IpcError),
    #[error("unexpected reply: {0}")]
    Decode(String),
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<serde_json::Value, IpcError>>>>>;

/// A connection to the service. Cheap to clone; all clones share it.
#[derive(Clone)]
pub struct IpcClient {
    tx: mpsc::Sender<String>,
    pending: Pending,
    next_id: Arc<AtomicU64>,
    events: broadcast::Sender<Event>,
    closed: Arc<AtomicBool>,
    pub service_version: String,
}

impl IpcClient {
    pub async fn connect(path: &str, kind: ClientKind) -> Result<Self, ClientError> {
        let stream = crate::transport::connect(path).await.map_err(ClientError::Unavailable)?;
        let (read, write) = tokio::io::split(stream);
        let mut reader = FramedRead::new(read, crate::codec());
        let mut writer = FramedWrite::new(write, crate::codec());

        let (tx, mut rx) = mpsc::channel::<String>(64);
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if writer.send(line).await.is_err() {
                    break;
                }
            }
        });

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, _) = broadcast::channel(256);
        let closed = Arc::new(AtomicBool::new(false));
        {
            let pending = pending.clone();
            let events = events.clone();
            let closed = closed.clone();
            tokio::spawn(async move {
                while let Some(Ok(line)) = reader.next().await {
                    match serde_json::from_str::<ServerFrame>(&line) {
                        Ok(ServerFrame::Response { id, result, error }) => {
                            if let Some(waiter) = pending.lock().expect("pending").remove(&id) {
                                let _ = waiter.send(match error {
                                    Some(e) => Err(e),
                                    None => Ok(result.unwrap_or(serde_json::Value::Null)),
                                });
                            }
                        }
                        Ok(ServerFrame::Event { event }) => {
                            let _ = events.send(event);
                        }
                        Err(e) => tracing::warn!("undecodable frame from service: {e}"),
                    }
                }
                // Connection gone: fail everything still waiting.
                closed.store(true, Ordering::SeqCst);
                pending.lock().expect("pending").clear();
            });
        }

        let mut client =
            Self { tx, pending, next_id: Arc::new(AtomicU64::new(1)), events, closed, service_version: String::new() };
        let hello: HelloReply =
            client.call(Request::Hello { protocol_version: IPC_PROTOCOL_VERSION, client: kind }).await?;
        client.service_version = hello.service_version;
        Ok(client)
    }

    /// Sends a request and decodes the reply as `T`.
    pub async fn call<T: DeserializeOwned>(&self, request: Request) -> Result<T, ClientError> {
        let timeout = match request {
            // Checks that probe the network take a while.
            Request::RunDiagnostics { .. } | Request::RunLeakTests | Request::MeasureLatencies { .. } => {
                Duration::from_secs(60)
            }
            _ => Duration::from_secs(15),
        };
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().expect("pending").insert(id, tx);
        let line = serde_json::to_string(&RequestFrame { id, request }).expect("requests serialize");
        if self.tx.send(line).await.is_err() {
            self.pending.lock().expect("pending").remove(&id);
            return Err(ClientError::Disconnected);
        }
        let value = match tokio::time::timeout(timeout, rx).await {
            Err(_) => {
                self.pending.lock().expect("pending").remove(&id);
                return Err(ClientError::Timeout);
            }
            Ok(Err(_)) => return Err(ClientError::Disconnected),
            Ok(Ok(result)) => result?,
        };
        serde_json::from_value(value).map_err(|e| ClientError::Decode(e.to_string()))
    }

    /// Subscribes this connection to service events.
    pub async fn subscribe(&self) -> Result<broadcast::Receiver<Event>, ClientError> {
        let rx = self.events.subscribe();
        self.call::<serde_json::Value>(Request::Subscribe).await?;
        Ok(rx)
    }

    /// Receiver for events without subscribing on the service (tests use it
    /// to check that unsubscribed connections get nothing).
    #[doc(hidden)]
    pub fn events_for_test(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// True once the service went away; reconnect with [`IpcClient::connect`].
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}
