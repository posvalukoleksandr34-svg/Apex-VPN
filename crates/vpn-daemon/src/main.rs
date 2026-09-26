//! meridiand — the privileged Meridian VPN service.
//!
//! ```text
//! meridiand run-service         (started by the Windows service manager)
//! meridiand foreground          (development: run in this console, Ctrl-C to stop)
//! meridiand install | uninstall (installer hooks; need administrator)
//! meridiand reset-firewall      (remove every Meridian filter; recovery tool)
//! ```

mod api;
mod config;
mod daemon;
mod diagnostics;
mod handler;
mod leaks;
mod logbook;
mod logging;
mod paths;
#[cfg(windows)]
mod service;
mod store;

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use tokio::sync::mpsc;
use vpn_core::PlatformEvent;

#[derive(Parser)]
#[command(name = "meridiand", version, about = "Meridian VPN service")]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
    /// Private state directory (default: %ProgramData%\Meridian).
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    /// Service configuration (default: <data-dir>/service.json).
    #[arg(long, global = true)]
    config: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Cmd {
    RunService,
    Foreground,
    Install,
    Uninstall,
    ResetFirewall,
}

pub(crate) fn options(data_dir: Option<PathBuf>, config: Option<PathBuf>) -> daemon::Options {
    let data_dir = data_dir.unwrap_or_else(paths::default_data_dir);
    let config_path = config.unwrap_or_else(|| data_dir.join("service.json"));
    daemon::Options { data_dir, config_path }
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        #[cfg(windows)]
        Cmd::RunService => service::run(),
        #[cfg(not(windows))]
        Cmd::RunService => anyhow::bail!("use `foreground` under systemd/launchd"),
        Cmd::Foreground => {
            let opts = options(cli.data_dir, cli.config);
            let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
            runtime.block_on(async {
                let (_power_tx, power_rx) = mpsc::unbounded_channel();
                let stop = async {
                    let _ = tokio::signal::ctrl_c().await;
                };
                run_daemon(opts, true, stop, power_rx, || {}).await
            })
        }
        #[cfg(windows)]
        Cmd::Install => service::install(),
        #[cfg(windows)]
        Cmd::Uninstall => service::uninstall(),
        #[cfg(windows)]
        Cmd::ResetFirewall => {
            vpn_platform::windows::reset_firewall().map_err(|e| anyhow::anyhow!("{e}"))?;
            println!("All Meridian firewall rules removed.");
            Ok(())
        }
        #[cfg(not(windows))]
        Cmd::Install | Cmd::Uninstall | Cmd::ResetFirewall => anyhow::bail!("not available on this platform yet"),
    }
}

/// Runs the service until `stop` resolves.
pub(crate) async fn run_daemon(
    opts: daemon::Options,
    foreground: bool,
    stop: impl Future<Output = ()>,
    mut power: mpsc::UnboundedReceiver<PlatformEvent>,
    on_ready: impl FnOnce(),
) -> anyhow::Result<()> {
    paths::prepare(&opts.data_dir)?;
    let _log_guard = logging::init(&opts.data_dir.join("logs"), foreground)?;
    std::panic::set_hook(Box::new(|info| tracing::error!("panic: {info}")));

    let daemon = daemon::Daemon::start(&opts).await.inspect_err(|e| tracing::error!("startup failed: {e:#}"))?;
    let listener = vpn_ipc::transport::Listener::bind(vpn_types::brand::IPC_PATH).map_err(|e| {
        anyhow::anyhow!("could not open the IPC endpoint (is another instance running?): {e}")
    })?;
    let server = vpn_ipc::Server::new(Arc::new(handler::IpcHandler { daemon: daemon.clone() }));
    let ipc = tokio::spawn(server.serve(listener));
    tracing::info!(path = vpn_types::brand::IPC_PATH, "service ready");
    on_ready();

    let d = daemon.clone();
    let power_task = tokio::spawn(async move {
        while let Some(ev) = power.recv().await {
            d.power_event(ev);
        }
    });

    stop.await;
    tracing::info!("stopping");
    ipc.abort();
    power_task.abort();
    daemon.shutdown().await;
    Ok(())
}
