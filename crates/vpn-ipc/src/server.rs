use std::sync::Arc;

use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use tokio::sync::{broadcast, mpsc};
use tokio_util::codec::{FramedRead, FramedWrite};
use vpn_types::brand::IPC_PROTOCOL_VERSION;
use vpn_types::ipc::{ClientKind, Event, HelloReply, Request, RequestFrame, ServerFrame};
use vpn_types::{IpcError, IpcErrorKind};

use crate::transport::{Listener, Stream};

#[derive(Debug, Clone)]
pub struct ConnectionInfo {
    pub id: u64,
    pub pid: Option<u32>,
    pub client: ClientKind,
}

#[async_trait]
pub trait Handler: Send + Sync + 'static {
    async fn handle(&self, conn: &ConnectionInfo, request: Request) -> Result<serde_json::Value, IpcError>;
    fn events(&self) -> broadcast::Receiver<Event>;
    fn service_version(&self) -> String;
}

pub struct Server<H: Handler> {
    handler: Arc<H>,
}

impl<H: Handler> Server<H> {
    pub fn new(handler: Arc<H>) -> Self {
        Self { handler }
    }

    /// Accepts clients until the listener fails.
    pub async fn serve(self, mut listener: Listener) -> std::io::Result<()> {
        let mut next_id = 1u64;
        loop {
            let (stream, pid) = listener.accept().await?;
            let id = next_id;
            next_id += 1;
            let handler = self.handler.clone();
            tokio::spawn(async move {
                if let Err(e) = serve_connection(handler, stream, id, pid).await {
                    tracing::debug!(conn = id, "IPC connection ended: {e}");
                }
            });
        }
    }
}

async fn serve_connection<H: Handler>(
    handler: Arc<H>,
    stream: Box<dyn Stream>,
    id: u64,
    pid: Option<u32>,
) -> Result<(), String> {
    let (read, write) = tokio::io::split(stream);
    let mut reader = FramedRead::new(read, crate::codec());
    let mut writer = FramedWrite::new(write, crate::codec());

    // Everything written goes through one queue, so responses from concurrent
    // requests and events never interleave mid-line.
    let (out_tx, mut out_rx) = mpsc::channel::<ServerFrame>(256);
    let writer_task = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            let line = serde_json::to_string(&frame).expect("frames serialize");
            if writer.send(line).await.is_err() {
                break;
            }
        }
    });

    // The first request must be a compatible Hello.
    let first = reader.next().await.ok_or("closed before hello")?.map_err(|e| e.to_string())?;
    let frame: RequestFrame = serde_json::from_str(&first).map_err(|e| e.to_string())?;
    let client = match frame.request {
        Request::Hello { protocol_version, client } if protocol_version == IPC_PROTOCOL_VERSION => {
            let reply = HelloReply { protocol_version: IPC_PROTOCOL_VERSION, service_version: handler.service_version() };
            let _ = out_tx.send(ok(frame.id, serde_json::to_value(reply).unwrap())).await;
            client
        }
        Request::Hello { protocol_version, .. } => {
            let _ = out_tx
                .send(err(frame.id, IpcError::new(IpcErrorKind::VersionMismatch, format!(
                    "service speaks protocol {IPC_PROTOCOL_VERSION}, client {protocol_version}"
                ))))
                .await;
            drop(out_tx);
            let _ = writer_task.await;
            return Err("version mismatch".into());
        }
        _ => {
            let _ = out_tx.send(err(frame.id, IpcError::new(IpcErrorKind::InvalidRequest, "hello expected"))).await;
            drop(out_tx);
            let _ = writer_task.await;
            return Err("no hello".into());
        }
    };
    let conn = Arc::new(ConnectionInfo { id, pid, client });
    tracing::debug!(conn = id, ?pid, ?client, "IPC client connected");

    let mut subscribed = false;
    while let Some(line) = reader.next().await {
        let line = line.map_err(|e| e.to_string())?;
        let frame: RequestFrame = match serde_json::from_str(&line) {
            Ok(f) => f,
            Err(e) => {
                // Without a parsable id we can't answer; drop the client.
                return Err(format!("malformed frame: {e}"));
            }
        };
        match frame.request {
            Request::Subscribe if !subscribed => {
                subscribed = true;
                let mut events = handler.events();
                let tx = out_tx.clone();
                tokio::spawn(async move {
                    loop {
                        match events.recv().await {
                            Ok(event) => {
                                if tx.send(ServerFrame::Event { event }).await.is_err() {
                                    break;
                                }
                            }
                            // A slow client missed events; it resyncs with
                            // Get* requests, so keep going.
                            Err(broadcast::error::RecvError::Lagged(n)) => {
                                tracing::debug!("IPC subscriber lagged by {n} events");
                            }
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                    }
                });
                let _ = out_tx.send(ok(frame.id, serde_json::Value::Null)).await;
            }
            Request::Subscribe | Request::Hello { .. } => {
                let _ = out_tx.send(ok(frame.id, serde_json::Value::Null)).await;
            }
            request => {
                let handler = handler.clone();
                let conn = conn.clone();
                let tx = out_tx.clone();
                tokio::spawn(async move {
                    let method = request.method();
                    let reply = match handler.handle(&conn, request).await {
                        Ok(v) => ok(frame.id, v),
                        Err(e) => {
                            tracing::debug!(conn = conn.id, method, "request failed: {e}");
                            err(frame.id, e)
                        }
                    };
                    let _ = tx.send(reply).await;
                });
            }
        }
    }
    drop(out_tx);
    writer_task.abort();
    Ok(())
}

fn ok(id: u64, value: serde_json::Value) -> ServerFrame {
    ServerFrame::Response { id, result: Some(value), error: None }
}

fn err(id: u64, e: IpcError) -> ServerFrame {
    ServerFrame::Response { id, result: None, error: Some(e) }
}
