//! `meridian` — the CLI. It talks to the same service over the same IPC as
//! the desktop app; there is no second VPN implementation.

mod account;
mod format;

use std::time::Duration;

use anyhow::Context;
use clap::{Parser, Subcommand, ValueEnum};
use vpn_ipc::IpcClient;
use vpn_types::brand::IPC_PATH;
use vpn_types::ipc::{ClientKind, ConnectionReport, Event, IpObservations, RelayListReply, Request};
use vpn_types::*;

#[derive(Parser)]
#[command(name = "meridian", version, about = "Meridian VPN command-line client")]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
    /// Machine-readable output.
    #[arg(long, global = true)]
    json: bool,
}

#[derive(Subcommand)]
enum Cmd {
    /// Show the connection state.
    Status,
    /// Connect to a server id, a country, or with a Smart Connect mode.
    Connect {
        /// Server id (see `meridian servers`).
        server: Option<String>,
        #[arg(long)]
        country: Option<String>,
        #[arg(long)]
        city: Option<String>,
        #[arg(long, value_enum)]
        mode: Option<Mode>,
        #[arg(long = "feature", value_enum)]
        features: Vec<Feature>,
        /// Return immediately instead of waiting for the outcome.
        #[arg(long)]
        no_wait: bool,
    },
    Disconnect,
    Reconnect,
    /// List servers.
    Servers {
        #[arg(long)]
        country: Option<String>,
        /// Measure latency before listing.
        #[arg(long)]
        ping: bool,
    },
    /// Run the diagnostics checks.
    Diagnostics,
    /// Run the leak tests (connected only).
    LeakTest,
    /// Show what the internet sees as your address.
    Ip,
    /// Show recent connection log entries.
    Logs {
        #[arg(long, value_enum)]
        level: Option<Level>,
        #[arg(long, short)]
        follow: bool,
        #[arg(long, default_value_t = 50)]
        limit: u32,
    },
    /// Technical details of the current connection.
    Details,
    /// Enroll this device with your account (for machines without the app).
    Login {
        #[arg(long)]
        email: String,
        /// Read the password from standard input instead of prompting.
        #[arg(long)]
        password_stdin: bool,
        #[arg(long)]
        device_name: Option<String>,
    },
    /// Show this device's WireGuard public key and registration.
    Device,
    /// Show settings, or change one: `meridian set kill-switch always-on`.
    Settings,
    Set {
        #[arg(value_enum)]
        key: SettingKey,
        value: String,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum Mode {
    Fastest,
    Nearest,
    LowestLoad,
    Best,
}

#[derive(Clone, Copy, ValueEnum)]
enum Feature {
    Streaming,
    Gaming,
    Privacy,
    P2p,
    LowLatency,
}

#[derive(Clone, Copy, ValueEnum)]
enum Level {
    Error,
    Warn,
    Info,
    Debug,
}

#[derive(Clone, Copy, ValueEnum)]
enum SettingKey {
    KillSwitch,
    Protocol,
    Dns,
    AllowLan,
    Ipv6,
    Mtu,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    if let Err(e) = run(cli).await {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> anyhow::Result<()> {
    let client = IpcClient::connect(IPC_PATH, ClientKind::Cli)
        .await
        .context("the Meridian service isn't running (start it, or run `meridiand foreground` as administrator)")?;
    let json = cli.json;
    match cli.command {
        Cmd::Status => {
            let state: TunnelState = client.call(Request::GetState).await?;
            print_out(json, &state, || format::state(&state));
        }
        Cmd::Connect { server, country, city, mode, features, no_wait } => {
            let target = target(server, country, city, mode, features);
            let mut events = client.subscribe().await?;
            client.call::<()>(Request::Connect { target }).await?;
            if no_wait {
                return Ok(());
            }
            let outcome = tokio::time::timeout(Duration::from_secs(120), async {
                let mut last = String::new();
                loop {
                    let Ok(Event::TunnelState(state)) = events.recv().await else { continue };
                    let line = format::state(&state);
                    if line != last && !json {
                        println!("{line}");
                        last = line;
                    }
                    match state {
                        TunnelState::Connected { .. } => return Ok(state),
                        TunnelState::Error { .. } => return Err(state),
                        _ => {}
                    }
                }
            })
            .await
            .context("timed out waiting for the connection")?;
            match outcome {
                Ok(state) => print_out(json, &state, || String::new()),
                Err(state) => {
                    print_out(json, &state, || String::new());
                    std::process::exit(2);
                }
            }
        }
        Cmd::Disconnect => {
            client.call::<()>(Request::Disconnect).await?;
            if !json {
                println!("Disconnect requested.");
            }
        }
        Cmd::Reconnect => {
            client.call::<()>(Request::Reconnect).await?;
        }
        Cmd::Servers { country, ping } => {
            if ping {
                client.call::<Vec<LatencySample>>(Request::MeasureLatencies { server_ids: None }).await?;
            }
            let reply: RelayListReply = client.call(Request::GetRelayList).await?;
            let latencies: Vec<LatencySample> = client.call(Request::GetLatencies).await?;
            let Some(list) = reply.list else {
                anyhow::bail!("no server list yet ({:?})", reply.status.last_error);
            };
            print_out(json, &list, || format::servers(&list, &latencies, country.as_deref()));
        }
        Cmd::Diagnostics => {
            let checks: Vec<CheckResult> = client.call(Request::RunDiagnostics { checks: None }).await?;
            print_out(json, &checks, || format::checks(&checks));
        }
        Cmd::LeakTest => {
            let results: Vec<LeakTestResult> = client.call(Request::RunLeakTests).await?;
            print_out(json, &results, || format::leaks(&results));
        }
        Cmd::Ip => {
            let obs: IpObservation = client.call(Request::CheckIp).await?;
            let all: IpObservations = client.call(Request::GetIpObservations).await?;
            print_out(json, &obs, || format::ip(&obs, &all));
        }
        Cmd::Logs { level, follow, limit } => {
            let min_level = level.map(|l| match l {
                Level::Error => LogLevel::Error,
                Level::Warn => LogLevel::Warn,
                Level::Info => LogLevel::Info,
                Level::Debug => LogLevel::Debug,
            });
            let entries: Vec<LogEntry> =
                client.call(Request::GetLogs { query: LogQuery { min_level, limit: Some(limit), ..Default::default() } }).await?;
            for e in &entries {
                println!("{}", if json { serde_json::to_string(e)? } else { format::log(e) });
            }
            if follow {
                let mut events = client.subscribe().await?;
                while let Ok(ev) = events.recv().await {
                    if let Event::Log(e) = ev {
                        println!("{}", if json { serde_json::to_string(&e)? } else { format::log(&e) });
                    }
                }
            }
        }
        Cmd::Details => {
            let report: ConnectionReport = client.call(Request::GetConnectionReport).await?;
            print_out(json, &report, || format::details(&report));
        }
        Cmd::Login { email, password_stdin, device_name } => {
            account::login(&client, &email, password_stdin, device_name).await?;
        }
        Cmd::Device => {
            let d: DeviceInfo = client.call(Request::GetDevice).await?;
            print_out(json, &d, || match &d.registration {
                Some(r) => format!("public key {}
registered as device {} with address {}", d.public_key, r.device_id, r.ipv4_address),
                None => format!("public key {}
not registered — run `meridian login --email you@example.com`", d.public_key),
            });
        }
        Cmd::Settings => {
            let s: Settings = client.call(Request::GetSettings).await?;
            println!("{}", serde_json::to_string_pretty(&s)?);
        }
        Cmd::Set { key, value } => {
            let current: Settings = client.call(Request::GetSettings).await?;
            let patch = patch_for(key, &value, &current)?;
            let s: Settings = client.call(Request::UpdateSettings { patch }).await?;
            if !json {
                println!("Saved. Kill switch: {:?}, protocol: {:?}, DNS: {:?}", s.kill_switch, s.protocol, s.dns.mode);
            }
        }
    }
    Ok(())
}

fn print_out<T: serde::Serialize>(json: bool, value: &T, human: impl FnOnce() -> String) {
    if json {
        println!("{}", serde_json::to_string_pretty(value).expect("serializable"));
    } else {
        let text = human();
        if !text.is_empty() {
            println!("{text}");
        }
    }
}

fn target(
    server: Option<String>,
    country: Option<String>,
    city: Option<String>,
    mode: Option<Mode>,
    features: Vec<Feature>,
) -> Option<ConnectTarget> {
    if let Some(id) = server {
        return Some(ConnectTarget::Server { id });
    }
    if country.is_none() && city.is_none() && mode.is_none() && features.is_empty() {
        return None; // the default target from settings
    }
    Some(ConnectTarget::Smart {
        mode: match mode.unwrap_or(Mode::Best) {
            Mode::Fastest => SmartMode::Fastest,
            Mode::Nearest => SmartMode::Nearest,
            Mode::LowestLoad => SmartMode::LowestLoad,
            Mode::Best => SmartMode::BestOverall,
        },
        country: country.map(|c| c.to_uppercase()),
        city,
        features: features
            .into_iter()
            .map(|f| match f {
                Feature::Streaming => ServerFeature::Streaming,
                Feature::Gaming => ServerFeature::Gaming,
                Feature::Privacy => ServerFeature::Privacy,
                Feature::P2p => ServerFeature::P2p,
                Feature::LowLatency => ServerFeature::LowLatency,
            })
            .collect(),
    })
}

fn patch_for(key: SettingKey, value: &str, current: &Settings) -> anyhow::Result<SettingsPatch> {
    let v = value.to_lowercase().replace('-', "_");
    let bool_value = || match v.as_str() {
        "on" | "true" | "yes" | "1" => Ok(true),
        "off" | "false" | "no" | "0" => Ok(false),
        _ => anyhow::bail!("expected on/off"),
    };
    let mut p = SettingsPatch::default();
    match key {
        SettingKey::KillSwitch => {
            p.kill_switch = Some(serde_json::from_value(serde_json::Value::String(v.replace("on_while_connected", "while_connected")))
                .context("kill-switch: off | while-connected | always-on")?)
        }
        SettingKey::Protocol => {
            p.protocol = Some(serde_json::from_value(serde_json::Value::String(v.clone()))
                .context("protocol: automatic | wireguard | openvpn | ikev2")?)
        }
        SettingKey::Dns => {
            let mut dns = current.dns.clone();
            match v.as_str() {
                "vpn" => dns.mode = DnsMode::Vpn,
                "automatic" | "system" => dns.mode = DnsMode::System,
                list => {
                    dns.mode = DnsMode::Custom;
                    dns.custom_servers = list.split(',').map(|s| s.trim().parse()).collect::<Result<_, _>>()
                        .context("dns: vpn | automatic | comma-separated IPs")?;
                }
            }
            p.dns = Some(dns);
        }
        SettingKey::AllowLan => p.allow_lan = Some(bool_value()?),
        SettingKey::Ipv6 => {
            let mut n = current.network.clone();
            n.enable_ipv6 = bool_value()?;
            p.network = Some(n);
        }
        SettingKey::Mtu => {
            let mut n = current.network.clone();
            n.mtu = if v == "auto" { None } else { Some(v.parse().context("mtu: auto | 1280–1500")?) };
            p.network = Some(n);
        }
    }
    Ok(p)
}
