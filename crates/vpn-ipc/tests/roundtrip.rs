use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::broadcast;
use vpn_ipc::transport::Listener;
use vpn_ipc::{ClientError, ConnectionInfo, Handler, IpcClient, Server};
use vpn_types::ipc::{ClientKind, Event, Request};
use vpn_types::{IpcError, IpcErrorKind, TunnelState};

struct Echo {
    events: broadcast::Sender<Event>,
}

#[async_trait]
impl Handler for Echo {
    async fn handle(&self, conn: &ConnectionInfo, request: Request) -> Result<serde_json::Value, IpcError> {
        match request {
            Request::GetState => Ok(serde_json::to_value(TunnelState::Disconnected { locked_down: false }).unwrap()),
            Request::GetCapabilities => Ok(serde_json::json!({ "pid": conn.pid, "client": conn.client })),
            other => Err(IpcError::new(IpcErrorKind::Unsupported, other.method())),
        }
    }

    fn events(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    fn service_version(&self) -> String {
        "test".into()
    }
}

fn pipe_name(tag: &str) -> String {
    if cfg!(windows) {
        format!(r"\\.\pipe\meridian-test-{}-{tag}", std::process::id())
    } else {
        std::env::temp_dir().join(format!("meridian-test-{}-{tag}.sock", std::process::id())).to_string_lossy().into_owned()
    }
}

async fn start(tag: &str) -> (String, broadcast::Sender<Event>) {
    let path = pipe_name(tag);
    let (events, _) = broadcast::channel(16);
    let handler = Arc::new(Echo { events: events.clone() });
    let listener = Listener::bind(&path).unwrap();
    tokio::spawn(Server::new(handler).serve(listener));
    (path, events)
}

#[tokio::test]
async fn hello_call_and_errors() {
    let (path, _) = start("calls").await;
    let client = IpcClient::connect(&path, ClientKind::Cli).await.unwrap();
    assert_eq!(client.service_version, "test");

    let state: TunnelState = client.call(Request::GetState).await.unwrap();
    assert_eq!(state, TunnelState::Disconnected { locked_down: false });

    let info: serde_json::Value = client.call(Request::GetCapabilities).await.unwrap();
    assert_eq!(info["client"], "cli");
    assert_eq!(info["pid"], std::process::id(), "the service can see which process is calling");

    match client.call::<serde_json::Value>(Request::Disconnect).await {
        Err(ClientError::Service(e)) => assert_eq!(e.kind, IpcErrorKind::Unsupported),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn concurrent_calls_on_one_connection() {
    let (path, _) = start("concurrent").await;
    let client = IpcClient::connect(&path, ClientKind::Desktop).await.unwrap();
    let calls = (0..50).map(|_| {
        let c = client.clone();
        tokio::spawn(async move { c.call::<TunnelState>(Request::GetState).await.unwrap() })
    });
    for c in calls {
        c.await.unwrap();
    }
}

#[tokio::test]
async fn events_reach_subscribers_only() {
    let (path, events) = start("events").await;
    let subscriber = IpcClient::connect(&path, ClientKind::Desktop).await.unwrap();
    let mut rx = subscriber.subscribe().await.unwrap();
    let bystander = IpcClient::connect(&path, ClientKind::Cli).await.unwrap();
    let mut bystander_rx = bystander.events_for_test();

    events.send(Event::TunnelState(TunnelState::Disconnected { locked_down: true })).unwrap();
    let got = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv()).await.unwrap().unwrap();
    assert_eq!(got, Event::TunnelState(TunnelState::Disconnected { locked_down: true }));
    assert!(tokio::time::timeout(std::time::Duration::from_millis(200), bystander_rx.recv()).await.is_err());
}

#[cfg(windows)]
#[tokio::test]
async fn a_second_service_cannot_squat_the_pipe() {
    let (path, _) = start("squat").await;
    assert!(Listener::bind(&path).is_err(), "FILE_FLAG_FIRST_PIPE_INSTANCE must refuse a second owner");
}

#[tokio::test]
async fn no_service_is_reported_as_unavailable() {
    match IpcClient::connect(&pipe_name("nobody-home"), ClientKind::Cli).await {
        Err(ClientError::Unavailable(_)) => {}
        Err(other) => panic!("{other:?}"),
        Ok(_) => panic!("connected to nothing"),
    }
}
