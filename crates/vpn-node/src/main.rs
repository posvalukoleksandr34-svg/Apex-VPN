use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use clap::Parser;
use ipnet::IpNet;
use vpn_node::agent::{run_heartbeats, Syncer};
use vpn_node::api::{HttpApi, NodeApi};
use vpn_node::peers::Pools;
use vpn_node::wg::{MemoryBackend, WgBackend, WgCli};

#[derive(Parser)]
#[command(name = "apexy-node", version, about = "Keeps this node's WireGuard peers in step with the Apexy VPN API")]
struct Args {
    /// API base URL.
    #[arg(long, env = "APEXY_NODE_API")]
    api: String,
    /// File holding this node's token. Defaults to the systemd credential
    /// `node-token` (`LoadCredential=node-token:/etc/apexy/node-token`).
    #[arg(long, env = "APEXY_NODE_TOKEN_FILE")]
    token_file: Option<PathBuf>,
    /// The WireGuard interface to manage.
    #[arg(long, default_value = "wg0")]
    interface: String,
    /// The `wg` tool.
    #[arg(long, default_value = "wg")]
    wg: PathBuf,
    /// Tunnel address pools; peers may only claim single addresses inside them.
    #[arg(long = "pool", default_values = ["10.64.0.0/10", "fc00:bbbb:bbbb:bb01::/64"])]
    pools: Vec<IpNet>,
    /// After this many seconds without a peer set from the API, remove every
    /// peer until it answers again (the node can no longer tell who has lost access).
    #[arg(long, env = "APEXY_NODE_MAX_STALE_SECS", default_value_t = 900)]
    max_stale_secs: u64,
    /// Seconds between heartbeats.
    #[arg(long, env = "APEXY_NODE_HEARTBEAT_SECS", default_value_t = 60)]
    heartbeat_secs: u64,
    /// Keep peers in memory instead of changing WireGuard, and send no heartbeats.
    #[arg(long)]
    dry_run: bool,
    /// Allow a plain-HTTP API on a host other than loopback (development only).
    #[arg(long)]
    allow_insecure_http: bool,
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("APEXY_NODE_LOG").unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stdout()))
        .init();
    let args = Args::parse();

    let token_file = match args.token_file.clone().or_else(|| std::env::var_os("CREDENTIALS_DIRECTORY").map(|d| PathBuf::from(d).join("node-token"))) {
        Some(path) => path,
        None => {
            tracing::error!("no node token: pass --token-file, or run under systemd with LoadCredential=node-token:…");
            return ExitCode::from(2);
        }
    };
    let api = match HttpApi::new(&args.api, token_file, args.allow_insecure_http) {
        Ok(api) => Arc::new(api),
        Err(e) => {
            tracing::error!("{e:#}");
            return ExitCode::from(2);
        }
    };
    let wg: Arc<dyn WgBackend> = if args.dry_run {
        Arc::new(MemoryBackend::default())
    } else {
        Arc::new(WgCli::new(args.wg.clone(), args.interface.clone()))
    };
    if !args.dry_run {
        if let Err(e) = wg.public_key().await {
            // Keep going: the loop retries until the interface is up.
            tracing::warn!("{e:#}");
        }
    }
    tracing::info!(
        interface = %args.interface,
        api = api.host(),
        max_stale_secs = args.max_stale_secs,
        dry_run = args.dry_run,
        "syncing peers"
    );

    let node_api: Arc<dyn NodeApi> = api;
    let syncer = Syncer::new(node_api.clone(), wg.clone(), Pools::new(args.pools), Duration::from_secs(args.max_stale_secs));
    let heartbeats = async {
        if args.dry_run {
            std::future::pending::<()>().await;
        }
        run_heartbeats(node_api, wg, Duration::from_secs(args.heartbeat_secs.max(10))).await;
    };
    tokio::select! {
        () = syncer.run() => {}
        () = heartbeats => {}
        () = shutdown() => {
            // Peers stay as they are: restarting or upgrading the agent doesn't
            // disconnect anyone. To take the node out of service, stop WireGuard.
            tracing::info!("stopping; peers are left as they are");
        }
    }
    ExitCode::SUCCESS
}

async fn shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
