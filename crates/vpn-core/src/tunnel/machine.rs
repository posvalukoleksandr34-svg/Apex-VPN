use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use ipnet::{IpNet, Ipv4Net, Ipv6Net};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;
use vpn_types::time::now_millis;
use vpn_types::{
    CipherSuite, ConnectPhase, ConnectTarget, ConnectedDetails, DeviceRegistration, DnsMode,
    ErrorKind, InterfaceInfo, LatencySample, Location, LogCategory, LogLevel, NetworkSnapshot,
    Protections, Protocol, ReconnectCause, RelayList, RelaySummary, Server, ServerId, Settings,
    SplitTunnelMode, SplitTunnelStatus, TunnelError, TunnelState, TunnelStats,
};

use crate::firewall::{self, AppException, FirewallPolicy, PeerEndpoint, Phase, Transport};
use crate::geo::GeoPoint;
use crate::keys::{PrivateKey, PublicKey};
use crate::platform::{
    DnsConfigurator, Firewall, PeerConfig, PlatformError, PlatformEvent, Tunnel, TunnelConfig,
    TunnelDriver,
};
use crate::reconnect;
use crate::selection::{self, SelectionInput};
use crate::settings::{impact, ChangeImpact};

/// Structured connection log (the Diagnostics → Logs view).
pub trait ConnectionLog: Send + Sync {
    fn record(&self, level: LogLevel, category: LogCategory, event: &'static str, message: String);
}

#[derive(Clone)]
pub struct DeviceCredentials {
    pub private_key: PrivateKey,
    pub registration: DeviceRegistration,
}

impl std::fmt::Debug for DeviceCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceCredentials").field("device_id", &self.registration.device_id).finish()
    }
}

pub struct Dependencies {
    pub drivers: Vec<Arc<dyn TunnelDriver>>,
    pub firewall: Arc<dyn Firewall>,
    pub dns: Arc<dyn DnsConfigurator>,
    pub log: Arc<dyn ConnectionLog>,
}

#[derive(Debug, Clone)]
pub struct Timing {
    pub open_timeout: Duration,
    /// From interface up to the first completed handshake.
    pub handshake_timeout: Duration,
    /// From handshake to the first successful probe through the tunnel.
    pub verify_timeout: Duration,
    pub probe_timeout: Duration,
    pub stats_interval: Duration,
    /// No bytes received for this long triggers an active liveness probe.
    pub liveness_idle: Duration,
    /// Wait after a network change before probing, so routes settle.
    pub network_settle: Duration,
    /// WireGuard's REJECT_AFTER_TIME (180 s) plus margin.
    pub stale_handshake: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            open_timeout: Duration::from_secs(20),
            handshake_timeout: Duration::from_secs(8),
            verify_timeout: Duration::from_secs(6),
            probe_timeout: Duration::from_secs(1),
            stats_interval: Duration::from_secs(1),
            liveness_idle: Duration::from_secs(30),
            network_settle: Duration::from_millis(1500),
            stale_handshake: Duration::from_secs(195),
        }
    }
}

pub struct Inputs {
    pub settings: Settings,
    pub relays: Option<Arc<RelayList>>,
    pub device: Option<DeviceCredentials>,
    pub network: Option<NetworkSnapshot>,
    pub exceptions: Vec<AppException>,
    /// Per-device seed for spreading load across equally good servers.
    pub spread_seed: u64,
    pub split_tunnel_supported: bool,
    /// The user wanted the tunnel up when the service last stopped: start
    /// blocked (per kill switch) and reconnect straight away.
    pub resume: Option<ConnectTarget>,
}

#[derive(Debug)]
pub enum Command {
    /// `None` connects to the default target from settings.
    Connect(Option<ConnectTarget>),
    Disconnect,
    Reconnect,
    /// Already validated and persisted by the caller.
    Settings(Box<Settings>),
    Relays(Arc<RelayList>),
    Latencies(Arc<HashMap<ServerId, LatencySample>>),
    Location(Option<GeoPoint>),
    Device(Option<DeviceCredentials>),
    Exceptions(Vec<AppException>),
    Platform(PlatformEvent),
    /// Stop the machine. With a wanted tunnel and a kill switch on, traffic
    /// stays blocked after the service exits so a restart or update can't leak.
    Shutdown(oneshot::Sender<()>),
}

/// What the firewall currently enforces, for diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyStatus {
    pub description: String,
    /// The last apply failed; the previous rule set is still in force.
    pub last_apply_failed: bool,
}

pub struct MachineHandle {
    pub commands: mpsc::UnboundedSender<Command>,
    pub state: watch::Receiver<TunnelState>,
    pub stats: watch::Receiver<Option<TunnelStats>>,
    pub policy: watch::Receiver<PolicyStatus>,
}

pub fn spawn(deps: Dependencies, inputs: Inputs, timing: Timing) -> (MachineHandle, tokio::task::JoinHandle<()>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let locked = inputs.settings.kill_switch == vpn_types::KillSwitchMode::AlwaysOn;
    let (state_tx, state_rx) = watch::channel(TunnelState::Disconnected { locked_down: locked });
    let (stats_tx, stats_rx) = watch::channel(None);
    let (policy_tx, policy_rx) =
        watch::channel(PolicyStatus { description: "unknown".into(), last_apply_failed: false });
    let resume = inputs.resume.clone();
    let machine = Machine {
        deps,
        timing,
        rx,
        closed: false,
        deferred: VecDeque::new(),
        state_tx,
        stats_tx,
        policy_tx,
        settings: inputs.settings,
        relays: inputs.relays,
        latencies: Arc::new(HashMap::new()),
        location: None,
        device: inputs.device,
        network: inputs.network,
        exceptions: inputs.exceptions,
        spread_seed: inputs.spread_seed,
        split_tunnel_supported: inputs.split_tunnel_supported,
        applied: None,
        mode: Mode::Idle,
    };
    let task = tokio::spawn(machine.run(resume));
    (MachineHandle { commands: tx, state: state_rx, stats: stats_rx, policy: policy_rx }, task)
}

enum Mode {
    Idle,
    Active(Session),
    /// The user wants the tunnel, an attempt failed in a way retrying won't
    /// fix on its own, and we're waiting for the user.
    ///
    /// `hold`: the kill switch keeps traffic blocked. True when protection
    /// was active and lapsed (the user expects no traffic outside the tunnel);
    /// false when the connection was refused before anything started, since
    /// there was no protection to keep and blocking would only take the
    /// user's internet away.
    Failed { target: ConnectTarget, error: TunnelError, hold: bool },
}

/// How far the device clock may run ahead before a registration counts as
/// expired. The nodes enforce the real deadline; this only decides when the
/// app stops trying and explains why.
const ENTITLEMENT_CLOCK_GRACE_MS: u64 = 10 * 60 * 1000;

struct Session {
    target: ConnectTarget,
    attempt: u32,
    ever_connected: bool,
    cause: Option<ReconnectCause>,
    relay: Option<RelaySummary>,
    server: Option<ServerId>,
    failures_on_server: u32,
    excluded: HashSet<ServerId>,
    udp_failures: u32,
    last_error: Option<TunnelError>,
    link: Link,
}

impl Session {
    fn new(target: ConnectTarget) -> Self {
        Self {
            target,
            attempt: 0,
            ever_connected: false,
            cause: None,
            relay: None,
            server: None,
            failures_on_server: 0,
            excluded: HashSet::new(),
            udp_failures: 0,
            last_error: None,
            link: Link::Down { next_attempt_at: Instant::now(), retry_at_ms: None },
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LinkKind {
    Up,
    Down,
    Waiting,
}

enum Link {
    Down { next_attempt_at: Instant, retry_at_ms: Option<u64> },
    Waiting,
    Up(Box<Live>),
}

struct Live {
    tunnel: Box<dyn Tunnel>,
    details: ConnectedDetails,
    peer: PeerEndpoint,
    dns: Vec<IpAddr>,
    ipv6_tunneled: bool,
    server_id: ServerId,
    probe_target: IpAddr,
    last_rx: u64,
    last_rx_change: Instant,
    next_tick: Instant,
}

struct Plan {
    server: Server,
    location: Location,
    protocol: Protocol,
    config: TunnelConfig,
    dns: Vec<IpAddr>,
    peer: PeerEndpoint,
    probe_target: IpAddr,
    ipv6_tunneled: bool,
    relay: RelaySummary,
    server_public_key: String,
    local_public_key: String,
}

struct Interrupted;

struct Machine {
    deps: Dependencies,
    timing: Timing,
    rx: mpsc::UnboundedReceiver<Command>,
    closed: bool,
    deferred: VecDeque<Command>,
    state_tx: watch::Sender<TunnelState>,
    stats_tx: watch::Sender<Option<TunnelStats>>,
    policy_tx: watch::Sender<PolicyStatus>,

    settings: Settings,
    relays: Option<Arc<RelayList>>,
    latencies: Arc<HashMap<ServerId, LatencySample>>,
    location: Option<GeoPoint>,
    device: Option<DeviceCredentials>,
    network: Option<NetworkSnapshot>,
    exceptions: Vec<AppException>,
    spread_seed: u64,
    split_tunnel_supported: bool,

    /// Last policy the firewall confirmed. Applies are atomic, so after a
    /// failed apply this is still what's in force.
    applied: Option<FirewallPolicy>,
    mode: Mode,
}

impl Machine {
    async fn run(mut self, resume: Option<ConnectTarget>) {
        match resume {
            Some(target) => {
                self.log(LogLevel::Info, LogCategory::Connection, "connect.resume", "Resuming the connection wanted before the service stopped".into());
                self.mode = Mode::Active(Session::new(target));
                // Block first (per kill switch) so nothing leaks while we get going.
                let _ = self.apply_policy(self.compute(Phase::Holding)).await;
                self.run_attempt().await;
            }
            None => {
                // Also clears stale rules left by a crash when they're no longer wanted.
                let _ = self.apply_policy(self.compute(Phase::Idle)).await;
                self.emit(TunnelState::Disconnected { locked_down: self.blocking() });
            }
        }

        loop {
            let cmd = if let Some(c) = self.deferred.pop_front() {
                Some(c)
            } else if self.closed {
                None
            } else {
                let deadline = self.next_deadline();
                tokio::select! {
                    c = self.rx.recv() => c,
                    _ = sleep_until(deadline) => {
                        self.on_timer().await;
                        continue;
                    }
                }
            };
            match cmd {
                None => {
                    self.shutdown().await;
                    return;
                }
                Some(Command::Shutdown(ack)) => {
                    self.shutdown().await;
                    let _ = ack.send(());
                    return;
                }
                Some(c) => self.handle(c).await,
            }
        }
    }

    // ── commands ────────────────────────────────────────────────────────

    async fn handle(&mut self, cmd: Command) {
        match cmd {
            Command::Connect(target) => self.connect(target).await,
            Command::Disconnect => self.disconnect().await,
            Command::Reconnect => self.reconnect().await,
            Command::Settings(s) => self.update_settings(*s).await,
            Command::Relays(list) => self.update_relays(list).await,
            Command::Device(dev) => self.update_device(dev).await,
            Command::Exceptions(ex) => {
                self.exceptions = ex;
                self.reapply_policy().await;
            }
            Command::Platform(ev) => self.platform_event(ev).await,
            other => {
                if let Some(c) = self.absorb(other) {
                    // Only passive commands reach here; `absorb` handles them all.
                    debug_assert!(false, "unexpected command {c:?}");
                }
            }
        }
    }

    /// Applies commands that don't disturb an in-flight operation. Returns
    /// the command back if it must preempt the operation instead.
    fn absorb(&mut self, cmd: Command) -> Option<Command> {
        match cmd {
            Command::Latencies(l) => self.latencies = l,
            Command::Location(p) => self.location = p,
            Command::Relays(list) => {
                // Stored now; whether the live server is affected is checked
                // when the command is handled outside an operation.
                self.relays = Some(list.clone());
                if matches!(&self.mode, Mode::Active(Session { link: Link::Up(_), .. })) {
                    return Some(Command::Relays(list));
                }
            }
            Command::Platform(PlatformEvent::Suspending) => {
                self.log(LogLevel::Info, LogCategory::Network, "power.suspend", "System is going to sleep".into());
            }
            Command::Platform(PlatformEvent::Network(ref snap)) if !self.network_change_is_material(snap) => {
                self.network = Some(snap.clone());
            }
            other => return Some(other),
        }
        None
    }

    async fn connect(&mut self, target: Option<ConnectTarget>) {
        let target = target.unwrap_or_else(|| self.settings.default_target.clone());
        if matches!(&self.mode, Mode::Active(s) if s.target == target) {
            // "Connect" while backing off means "try now"; otherwise we're
            // already on it.
            self.retry_now();
            return;
        }
        self.log(LogLevel::Info, LogCategory::Connection, "connect.requested", format!("Connect requested: {}", describe_target(&target)));
        if !self.protecting() {
            if let Some(e) = self.cannot_start() {
                // Refuse up front: nothing is protected yet, so don't engage
                // the kill switch for a connection that can't work.
                self.log(LogLevel::Warn, LogCategory::Connection, "connect.refused", format!("Not connecting: {} — {}", e.kind.code(), e.detail));
                let error = TunnelError { kind: e.kind, detail: Some(e.detail), at: now_millis() };
                self.mode = Mode::Failed { target, error: error.clone(), hold: false };
                let _ = self.apply_policy(self.compute(Phase::Idle)).await;
                self.emit(TunnelState::Error { error, blocking: self.blocking() });
                return;
            }
        }
        self.teardown_link().await;
        self.mode = Mode::Active(Session::new(target));
        self.run_attempt().await;
    }

    async fn disconnect(&mut self) {
        if matches!(self.mode, Mode::Idle) {
            return;
        }
        self.log(LogLevel::Info, LogCategory::Connection, "disconnect", "Disconnect requested".into());
        self.emit(TunnelState::Disconnecting { then: vpn_types::AfterDisconnect::Nothing });
        self.teardown_link().await;
        self.mode = Mode::Idle;
        let _ = self.apply_policy(self.compute(Phase::Idle)).await;
        self.stats_tx.send_replace(None);
        self.emit(TunnelState::Disconnected { locked_down: self.blocking() });
    }

    async fn reconnect(&mut self) {
        match &self.mode {
            Mode::Idle => {}
            Mode::Failed { target, .. } => {
                let target = target.clone();
                self.log(LogLevel::Info, LogCategory::Connection, "connect.retry", "Retry requested".into());
                self.mode = Mode::Active(Session::new(target));
                self.run_attempt().await;
            }
            Mode::Active(_) => self.drop_and_reconnect(ReconnectCause::UserRequested).await,
        }
    }

    async fn update_settings(&mut self, new: Settings) {
        let old = std::mem::replace(&mut self.settings, new);
        let change = impact(&old, &self.settings);
        self.log(LogLevel::Info, LogCategory::Service, "settings.changed", format!("Settings changed ({change:?})"));
        match change {
            ChangeImpact::None => {}
            ChangeImpact::Reconnect if self.is_up() => {
                self.drop_and_reconnect(ReconnectCause::SettingsChanged).await;
            }
            ChangeImpact::Reconnect | ChangeImpact::Firewall => {
                self.reapply_policy().await;
            }
        }
    }

    async fn update_relays(&mut self, list: Arc<RelayList>) {
        self.relays = Some(list.clone());
        let affected = match &self.mode {
            Mode::Active(Session { link: Link::Up(live), .. }) => {
                !list.server(&live.server_id).is_some_and(|s| s.accepts_connections())
            }
            _ => false,
        };
        if affected {
            self.log(LogLevel::Warn, LogCategory::Server, "server.unavailable", "The connected server was taken out of service; moving to another".into());
            self.drop_and_reconnect(ReconnectCause::ServerUnavailable).await;
        }
    }

    async fn update_device(&mut self, device: Option<DeviceCredentials>) {
        let removed = device.is_none();
        self.device = device;
        if removed && !matches!(self.mode, Mode::Idle) {
            self.teardown_link().await;
            self.fail(err(ErrorKind::AuthRequired, "the device registration was removed")).await;
        }
    }

    async fn platform_event(&mut self, ev: PlatformEvent) {
        match ev {
            PlatformEvent::Suspending => {
                self.log(LogLevel::Info, LogCategory::Network, "power.suspend", "System is going to sleep".into());
            }
            PlatformEvent::Resumed => {
                self.log(LogLevel::Info, LogCategory::Network, "power.resume", "System woke up".into());
                match self.link_kind() {
                    Some(LinkKind::Up) => self.check_existing_tunnel(ReconnectCause::WokeFromSleep).await,
                    Some(LinkKind::Down) => self.retry_now(),
                    _ => {}
                }
            }
            PlatformEvent::Network(snap) => self.network_changed(snap).await,
        }
    }

    fn network_change_is_material(&self, next: &NetworkSnapshot) -> bool {
        let Some(prev) = &self.network else { return true };
        prev.online != next.online || primary_id(prev) != primary_id(next)
    }

    async fn network_changed(&mut self, snap: NetworkSnapshot) {
        let material = self.network_change_is_material(&snap);
        let prev_online = self.network.as_ref().map_or(true, |n| n.online);
        self.network = Some(snap.clone());
        if !material {
            return;
        }
        if snap.online != prev_online {
            let (event, msg) = if snap.online { ("network.online", "Network connectivity restored") } else { ("network.offline", "Network connectivity lost") };
            self.log(LogLevel::Info, LogCategory::Network, event, msg.into());
        } else {
            self.log(LogLevel::Info, LogCategory::Network, "network.changed", format!(
                "Primary network changed to {}",
                snap.primary.as_ref().map_or("none".to_string(), |p| p.interface_name.clone())
            ));
        }
        let Some(kind) = self.link_kind() else { return };
        match (kind, snap.online) {
            (LinkKind::Waiting, true) => {
                if self.settings.auto_connect.reconnect_when_online {
                    if let Mode::Active(s) = &mut self.mode {
                        s.cause = Some(ReconnectCause::NetworkRestored);
                        s.attempt = 0;
                        s.link = Link::Down { next_attempt_at: Instant::now(), retry_at_ms: None };
                    }
                    self.publish_progress(ConnectPhase::SelectingServer, None);
                } else {
                    self.fail(err(ErrorKind::NoInternet, "the connection was lost while offline and automatic reconnect is off")).await;
                }
            }
            (LinkKind::Waiting, false) => {}
            (_, false) => self.enter_waiting().await,
            (LinkKind::Up, true) => self.check_existing_tunnel(ReconnectCause::NetworkChanged).await,
            (LinkKind::Down, true) => self.retry_now(),
        }
    }

    fn link_kind(&self) -> Option<LinkKind> {
        match &self.mode {
            Mode::Active(s) => Some(match s.link {
                Link::Up(_) => LinkKind::Up,
                Link::Down { .. } => LinkKind::Down,
                Link::Waiting => LinkKind::Waiting,
            }),
            _ => None,
        }
    }

    /// While backing off: skip the rest of the wait.
    fn retry_now(&mut self) {
        if let Mode::Active(Session { link: Link::Down { next_attempt_at, .. }, .. }) = &mut self.mode {
            *next_attempt_at = Instant::now();
        }
    }

    async fn shutdown(&mut self) {
        let wanted = !matches!(self.mode, Mode::Idle);
        self.teardown_link().await;
        let phase = if wanted { Phase::Holding } else { Phase::Idle };
        let _ = self.apply_policy(self.compute(phase)).await;
        self.log(LogLevel::Info, LogCategory::Service, "service.stop", if wanted && self.blocking() {
            "Service stopping; kill switch keeps traffic blocked until it restarts".into()
        } else {
            "Service stopping".into()
        });
        self.mode = Mode::Idle;
    }

    // ── timers ──────────────────────────────────────────────────────────

    fn next_deadline(&self) -> Option<Instant> {
        match &self.mode {
            Mode::Active(s) => match &s.link {
                Link::Down { next_attempt_at, .. } => Some(*next_attempt_at),
                Link::Up(live) => Some(live.next_tick),
                Link::Waiting => None,
            },
            _ => None,
        }
    }

    async fn on_timer(&mut self) {
        match &self.mode {
            Mode::Active(Session { link: Link::Down { .. }, .. }) => self.run_attempt().await,
            Mode::Active(Session { link: Link::Up(_), .. }) => self.tick().await,
            _ => {}
        }
    }

    /// Stats sampling and liveness while connected.
    async fn tick(&mut self) {
        let now = Instant::now();
        let interval = self.timing.stats_interval;
        let idle_limit = self.timing.liveness_idle;
        let Mode::Active(Session { link: Link::Up(live), .. }) = &mut self.mode else { return };
        live.next_tick = now + interval;
        match live.tunnel.stats().await {
            Ok(stats) => {
                if stats.rx_bytes != live.last_rx {
                    live.last_rx = stats.rx_bytes;
                    live.last_rx_change = now;
                }
                live.details.last_handshake = stats.last_handshake;
                self.stats_tx.send_replace(Some(stats));
                if now.duration_since(live.last_rx_change) >= idle_limit {
                    self.liveness_probe().await;
                }
            }
            Err(e) => {
                self.log(LogLevel::Warn, LogCategory::Protocol, "tunnel.stats_failed", format!("Reading tunnel counters failed: {}", e.detail));
                self.drop_and_reconnect(ReconnectCause::TunnelFailure).await;
            }
        }
    }

    async fn liveness_probe(&mut self) {
        let Some(live) = self.take_live() else { return };
        let (timeout, stale) = (self.timing.probe_timeout * 2, self.timing.stale_handshake);
        let target = live.probe_target;
        let result = self
            .interruptible(async {
                for _ in 0..2 {
                    if live.tunnel.probe(target, timeout).await.is_ok() {
                        return true;
                    }
                }
                false
            })
            .await;
        match result {
            Ok(true) => {
                let mut live = live;
                live.last_rx_change = Instant::now();
                self.put_live(live);
            }
            Ok(false) => {
                let handshake_age = live
                    .details
                    .last_handshake
                    .map(|h| Duration::from_millis(now_millis().saturating_sub(h)))
                    .unwrap_or(Duration::MAX);
                let cause = if handshake_age > stale { ReconnectCause::HandshakeStale } else { ReconnectCause::TunnelFailure };
                self.log(LogLevel::Warn, LogCategory::Connection, "tunnel.unresponsive", format!("Nothing came back through the tunnel ({cause:?}); reconnecting"));
                self.close_live(live).await;
                self.schedule_reconnect(cause).await;
            }
            Err(Interrupted) => {
                // Put it back; the deferred command decides what happens next.
                self.put_live(live);
            }
        }
    }

    // ── connecting ──────────────────────────────────────────────────────

    async fn run_attempt(&mut self) {
        let max_attempts = self.settings.network.reconnect.max_attempts;
        let Mode::Active(session) = &mut self.mode else { return };
        session.attempt += 1;
        if max_attempts > 0 && session.attempt > max_attempts {
            let e = session.last_error.clone().unwrap_or_else(|| err(ErrorKind::Timeout, "gave up after the maximum number of attempts"));
            self.fail(e).await;
            return;
        }
        self.publish_progress(ConnectPhase::SelectingServer, None);

        if !self.is_online() {
            self.enter_waiting().await;
            return;
        }

        let plan = match self.plan() {
            Ok(p) => p,
            Err(e) => {
                self.attempt_failed(e, None).await;
                return;
            }
        };
        let server_id = plan.server.id.clone();
        if let Mode::Active(s) = &mut self.mode {
            if s.server.as_ref() != Some(&server_id) {
                s.failures_on_server = 0;
            }
            s.server = Some(server_id.clone());
            s.relay = Some(plan.relay.clone());
        }
        let attempt_no = self.attempt_no();
        self.log(LogLevel::Info, LogCategory::Connection, "connect.attempt", format!(
            "Attempt {attempt_no}: {} ({}, {}) over {:?}",
            plan.server.hostname, plan.location.city, plan.location.country, plan.protocol
        ));

        // 1. The firewall lets the peer through before a single packet goes out.
        if let Err(e) = self.apply_policy(self.compute(Phase::Establishing { peer: plan.peer, tunnel: None, dns: None })).await {
            self.firewall_failed(e).await;
            return;
        }

        // 2. Interface and protocol config.
        self.publish_progress(ConnectPhase::CreatingInterface, None);
        let Some(driver) = self.deps.drivers.iter().find(|d| d.protocol() == plan.protocol).cloned() else {
            self.attempt_failed(PlatformError::new(ErrorKind::ProtocolUnavailable, "no driver for the chosen protocol"), Some(server_id)).await;
            return;
        };
        let open_timeout = self.timing.open_timeout;
        let config = plan.config.clone();
        let opened = self.interruptible(tokio::time::timeout(open_timeout, driver.open(config))).await;
        let tunnel = match opened {
            Err(Interrupted) => return self.attempt_interrupted(),
            Ok(Err(_)) => {
                return self.attempt_failed(PlatformError::new(ErrorKind::Timeout, "creating the tunnel interface timed out"), Some(server_id)).await
            }
            Ok(Ok(Err(e))) => return self.attempt_failed(e, Some(server_id)).await,
            Ok(Ok(Ok(t))) => t,
        };
        let iface = tunnel.interface();

        self.publish_progress(ConnectPhase::ConfiguringNetwork, None);
        if let Err(e) = self.apply_policy(self.compute(Phase::Establishing { peer: plan.peer, tunnel: Some(&iface), dns: None })).await {
            tunnel.close().await;
            self.firewall_failed(e).await;
            return;
        }

        // 3. Handshake, then something through the tunnel and back.
        self.publish_progress(ConnectPhase::Handshaking, None);
        let started = now_millis();
        let timing = self.timing.clone();
        let target = plan.probe_target;
        let hs = self.interruptible(await_handshake(&*tunnel, target, &timing, started)).await;
        let verified = match hs {
            Err(Interrupted) => {
                tunnel.close().await;
                return self.attempt_interrupted();
            }
            Ok(Err(e)) => {
                tunnel.close().await;
                return self.attempt_failed(e, Some(server_id)).await;
            }
            Ok(Ok(v)) => v,
        };
        if verified.is_none() {
            self.publish_progress(ConnectPhase::VerifyingTunnel, None);
            match self.interruptible(verify_tunnel(&*tunnel, target, &timing)).await {
                Err(Interrupted) => {
                    tunnel.close().await;
                    return self.attempt_interrupted();
                }
                Ok(Err(e)) => {
                    tunnel.close().await;
                    return self.attempt_failed(e, Some(server_id)).await;
                }
                Ok(Ok(_)) => {}
            }
        }

        // 4. DNS, then the final rule set.
        if !plan.dns.is_empty() {
            if let Err(e) = self.deps.dns.apply(&iface, &plan.dns).await {
                self.log(LogLevel::Error, LogCategory::Dns, "dns.apply_failed", e.detail.clone());
                tunnel.close().await;
                let e = PlatformError::new(ErrorKind::DnsFailure, e.detail);
                return self.attempt_failed(e, Some(server_id)).await;
            }
            self.log(LogLevel::Info, LogCategory::Dns, "dns.applied", format!("DNS set to {} resolver(s) through the tunnel", plan.dns.len()));
        }
        let established = self.compute(Phase::Established {
            peer: plan.peer,
            tunnel: &iface,
            dns: &plan.dns,
            ipv6_tunneled: plan.ipv6_tunneled,
        });
        if let Err(e) = self.apply_policy(established).await {
            let _ = self.deps.dns.reset().await;
            tunnel.close().await;
            self.firewall_failed(e).await;
            return;
        }

        // 5. Connected.
        let stats = tunnel.stats().await.ok();
        let details = self.connected_details(&plan, &iface, stats.and_then(|s| s.last_handshake), now_millis());
        let now = Instant::now();
        let live = Live {
            tunnel,
            details: details.clone(),
            peer: plan.peer,
            dns: plan.dns.clone(),
            ipv6_tunneled: plan.ipv6_tunneled,
            server_id,
            probe_target: plan.probe_target,
            last_rx: stats.map_or(0, |s| s.rx_bytes),
            last_rx_change: now,
            next_tick: now + self.timing.stats_interval,
        };
        if let Mode::Active(s) = &mut self.mode {
            s.ever_connected = true;
            s.attempt = 0;
            s.failures_on_server = 0;
            s.excluded.clear();
            s.udp_failures = 0;
            s.last_error = None;
            s.cause = None;
            s.link = Link::Up(Box::new(live));
        }
        self.stats_tx.send_replace(stats);
        self.log(LogLevel::Info, LogCategory::Connection, "connect.succeeded", format!(
            "Connected to {} ({}, {})",
            details.relay.hostname, details.relay.city, details.relay.country
        ));
        self.emit(TunnelState::Connected { details: Box::new(details) });
    }

    fn plan(&self) -> Result<Plan, PlatformError> {
        let Mode::Active(session) = &self.mode else {
            return Err(PlatformError::new(ErrorKind::Internal, "no active session"));
        };
        if let Some(e) = self.cannot_start() {
            return Err(e);
        }
        let device = self.device.as_ref().ok_or_else(|| {
            PlatformError::new(ErrorKind::AuthRequired, "this device has no registered key; sign in again")
        })?;
        let relays = self.relays.as_ref().ok_or_else(|| {
            PlatformError::new(ErrorKind::RelayListUnavailable, "no server list has been downloaded yet")
        })?;
        if relays.expires_at <= now_millis() {
            return Err(PlatformError::new(ErrorKind::RelayListUnavailable, "the server list has expired and could not be refreshed"));
        }
        let available: Vec<Protocol> = self
            .deps
            .drivers
            .iter()
            .filter(|d| d.capability().availability.is_available())
            .map(|d| d.protocol())
            .collect();
        let input = SelectionInput {
            relays,
            latencies: &self.latencies,
            location: self.location,
            available_protocols: &available,
            preference: self.settings.protocol,
            excluded: &session.excluded,
            udp_failures: session.udp_failures,
            spread_seed: self.spread_seed,
        };
        let candidates = selection::candidates(&session.target, &input)
            .map_err(|e| PlatformError::new(e.into(), e.to_string()))?;
        let switch_after = self.settings.network.reconnect.switch_server_after;
        let chosen = session
            .server
            .as_ref()
            .filter(|_| session.failures_on_server < switch_after)
            .and_then(|id| candidates.iter().find(|c| &c.server.id == id))
            .unwrap_or(&candidates[0]);

        if chosen.protocol != Protocol::WireGuard {
            return Err(PlatformError::new(ErrorKind::ProtocolUnavailable, "only WireGuard is available in this build"));
        }
        let wg = chosen
            .server
            .wireguard
            .as_ref()
            .ok_or_else(|| PlatformError::new(ErrorKind::ProtocolUnavailable, "server has no WireGuard endpoint"))?;
        let server_key = PublicKey::from_base64(&wg.public_key)
            .map_err(|_| PlatformError::new(ErrorKind::RelayListInvalid, "server key is malformed"))?;
        let port = wg.ports[(session.attempt.saturating_sub(1) as usize) % wg.ports.len()];
        let endpoint = std::net::SocketAddr::new(IpAddr::V4(chosen.server.ipv4), port);

        let reg = &device.registration;
        let ipv6_tunneled = self.settings.network.enable_ipv6 && wg.gateway_ipv6.is_some() && reg.ipv6_address.is_some();
        let mut addresses = vec![IpNet::V4(Ipv4Net::new(reg.ipv4_address, 32).expect("/32 is valid"))];
        let mut allowed_ips = vec![IpNet::V4(Ipv4Net::default())];
        if ipv6_tunneled {
            addresses.push(IpNet::V6(Ipv6Net::new(reg.ipv6_address.expect("checked"), 128).expect("/128 is valid")));
            allowed_ips.push(IpNet::V6(Ipv6Net::default()));
        }
        let dns: Vec<IpAddr> = match self.settings.dns.mode {
            DnsMode::Vpn => {
                let mut v = vec![IpAddr::V4(wg.dns_ipv4.unwrap_or(wg.gateway_ipv4))];
                if let (true, Some(g6)) = (ipv6_tunneled, wg.gateway_ipv6) {
                    v.push(IpAddr::V6(g6));
                }
                v
            }
            DnsMode::Custom => self
                .settings
                .dns
                .custom_servers
                .iter()
                .copied()
                .filter(|ip| ip.is_ipv4() || ipv6_tunneled)
                .collect(),
            DnsMode::System => Vec::new(),
        };
        let location = chosen.location.clone();
        Ok(Plan {
            relay: RelaySummary {
                server_id: chosen.server.id.clone(),
                hostname: chosen.server.hostname.clone(),
                country_code: location.country_code.clone(),
                country: location.country.clone(),
                city: location.city.clone(),
                protocol: chosen.protocol,
            },
            server: chosen.server.clone(),
            location,
            protocol: chosen.protocol,
            config: TunnelConfig {
                protocol: chosen.protocol,
                private_key: device.private_key.clone(),
                addresses,
                mtu: self.settings.network.mtu.unwrap_or(1420),
                peer: PeerConfig {
                    public_key: server_key,
                    endpoint,
                    allowed_ips,
                    persistent_keepalive: self.settings.network.persistent_keepalive,
                    gateway_v4: wg.gateway_ipv4,
                    gateway_v6: wg.gateway_ipv6.filter(|_| ipv6_tunneled),
                },
            },
            dns,
            peer: PeerEndpoint { addr: endpoint, transport: Transport::Udp },
            probe_target: IpAddr::V4(wg.gateway_ipv4),
            ipv6_tunneled,
            server_public_key: wg.public_key.clone(),
            local_public_key: device.private_key.public_key().to_base64(),
        })
    }

    fn connected_details(&self, plan: &Plan, iface: &InterfaceInfo, last_handshake: Option<u64>, connected_at: u64) -> ConnectedDetails {
        let reg = &self.device.as_ref().expect("connected implies device").registration;
        let dns_servers = if plan.dns.is_empty() {
            self.network.as_ref().and_then(|n| n.primary.as_ref()).map(|p| p.dns_servers.clone()).unwrap_or_default()
        } else {
            plan.dns.clone()
        };
        ConnectedDetails {
            relay: plan.relay.clone(),
            endpoint: plan.peer.addr,
            tunnel_ipv4: Some(reg.ipv4_address),
            tunnel_ipv6: reg.ipv6_address.filter(|_| plan.ipv6_tunneled),
            dns_servers,
            dns_mode: self.settings.dns.mode,
            mtu: plan.config.mtu,
            interface: iface.clone(),
            cipher: CipherSuite::wireguard(),
            connected_at,
            last_handshake,
            protections: self.protections(plan.ipv6_tunneled),
            local_public_key: plan.local_public_key.clone(),
            server_public_key: plan.server_public_key.clone(),
        }
    }

    fn protections(&self, ipv6_tunneled: bool) -> Protections {
        let p = self.applied.as_ref();
        let blocking = p.is_some_and(|p| p.block_by_default);
        Protections {
            kill_switch: blocking,
            dns_leak_blocking: p.is_some_and(|p| p.dns_only_via_tunnel.is_some()),
            ipv6_leak_blocking: p.is_some_and(|p| p.block_ipv6_outside_tunnel) || (ipv6_tunneled && blocking),
            ipv6_tunneled,
            split_tunnel: match self.settings.split_tunnel.mode {
                SplitTunnelMode::Off => SplitTunnelStatus::Inactive,
                _ if self.split_tunnel_supported => SplitTunnelStatus::Enforced,
                _ => SplitTunnelStatus::NotEnforced,
            },
        }
    }

    fn attempt_interrupted(&mut self) {
        // The deferred command runs next; if the session survives it, the
        // attempt restarts immediately.
        if let Mode::Active(s) = &mut self.mode {
            s.attempt = s.attempt.saturating_sub(1);
            s.link = Link::Down { next_attempt_at: Instant::now(), retry_at_ms: None };
        }
    }

    async fn attempt_failed(&mut self, e: PlatformError, server: Option<ServerId>) {
        let reconnect = self.settings.network.reconnect.clone();
        let terr = TunnelError { kind: e.kind, detail: Some(e.detail.clone()), at: now_millis() };
        self.log(LogLevel::Warn, LogCategory::Connection, "connect.failed", format!("Attempt failed: {} — {}", e.kind.code(), e.detail));
        let Mode::Active(session) = &mut self.mode else { return };
        session.last_error = Some(terr.clone());

        // "All matching servers are down" is worth waiting out, too.
        let recoverable = e.kind.auto_recoverable();
        if !(recoverable && reconnect.auto_reconnect) {
            self.fail(terr).await;
            return;
        }
        if e.kind == ErrorKind::HandshakeTimeout {
            session.udp_failures += 1;
        }
        if let Some(id) = server {
            session.failures_on_server += 1;
            let smart = matches!(session.target, ConnectTarget::Smart { .. });
            if smart && session.failures_on_server >= reconnect.switch_server_after {
                session.excluded.insert(id);
                session.server = None;
                session.failures_on_server = 0;
            }
        }
        let delay = reconnect::delay(session.attempt + 1, rand::random::<f64>());
        let retry_at_ms = now_millis() + delay.as_millis() as u64;
        session.link = Link::Down { next_attempt_at: Instant::now() + delay, retry_at_ms: Some(retry_at_ms) };
        let _ = self.apply_policy(self.compute(Phase::Holding)).await;
        self.publish_progress(ConnectPhase::WaitingToRetry, Some(retry_at_ms));
    }

    async fn firewall_failed(&mut self, e: PlatformError) {
        self.log(LogLevel::Error, LogCategory::Firewall, "firewall.failed", e.detail.clone());
        // Refuse to continue: connecting without the rules the user asked
        // for would be a silent downgrade.
        self.fail(TunnelError { kind: ErrorKind::FirewallFailure, detail: Some(e.detail), at: now_millis() }).await;
    }

    async fn fail(&mut self, error: TunnelError) {
        self.teardown_link().await;
        let target = match std::mem::replace(&mut self.mode, Mode::Idle) {
            Mode::Active(s) => s.target,
            Mode::Failed { target, .. } => target,
            Mode::Idle => self.settings.default_target.clone(),
        };
        self.log(LogLevel::Error, LogCategory::Connection, "connect.error", format!("Connection failed: {}", error.kind.code()));
        self.mode = Mode::Failed { target, error: error.clone(), hold: true };
        if error.kind != ErrorKind::FirewallFailure {
            let _ = self.apply_policy(self.compute(Phase::Holding)).await;
        }
        self.stats_tx.send_replace(None);
        self.emit(TunnelState::Error { error, blocking: self.blocking() });
    }

    async fn enter_waiting(&mut self) {
        self.teardown_link().await;
        if let Mode::Active(s) = &mut self.mode {
            s.link = Link::Waiting;
        }
        let _ = self.apply_policy(self.compute(Phase::Holding)).await;
        self.stats_tx.send_replace(None);
        let target = match &self.mode {
            Mode::Active(s) => Some(s.target.clone()),
            _ => None,
        };
        self.emit(TunnelState::WaitingForNetwork { target, blocking: self.blocking() });
    }

    /// After a network change or wake-up: check whether the tunnel we have
    /// still carries traffic before paying for a rebuild.
    async fn check_existing_tunnel(&mut self, cause: ReconnectCause) {
        let Some(live) = self.take_live() else { return };
        self.log(LogLevel::Info, LogCategory::Connection, "reconnect.check", format!("Checking the tunnel after {cause:?}"));
        if let Mode::Active(s) = &mut self.mode {
            s.cause = Some(cause);
        }
        self.publish_progress(ConnectPhase::CheckingTunnel, None);
        let _ = self
            .apply_policy(self.compute(Phase::Establishing { peer: live.peer, tunnel: Some(&live.details.interface), dns: Some(&live.dns) }))
            .await;
        let (settle, timeout, target) = (self.timing.network_settle, self.timing.probe_timeout * 2, live.probe_target);
        let ok = self
            .interruptible(async {
                tokio::time::sleep(settle).await;
                for _ in 0..3 {
                    if live.tunnel.probe(target, timeout).await.is_ok() {
                        return true;
                    }
                }
                false
            })
            .await;
        match ok {
            Ok(true) => {
                let established = self.compute(Phase::Established {
                    peer: live.peer,
                    tunnel: &live.details.interface,
                    dns: &live.dns,
                    ipv6_tunneled: live.ipv6_tunneled,
                });
                if let Err(e) = self.apply_policy(established).await {
                    self.close_live(live).await;
                    self.firewall_failed(e).await;
                    return;
                }
                let mut live = live;
                live.last_rx_change = Instant::now();
                live.details.protections = self.protections(live.ipv6_tunneled);
                let details = live.details.clone();
                if let Mode::Active(s) = &mut self.mode {
                    s.cause = None;
                    s.attempt = 0;
                }
                self.put_live(live);
                self.log(LogLevel::Info, LogCategory::Connection, "reconnect.kept", "Tunnel still works; kept it".into());
                self.emit(TunnelState::Connected { details: Box::new(details) });
            }
            Ok(false) => {
                self.log(LogLevel::Info, LogCategory::Connection, "reconnect.rebuild", "Tunnel stopped working; rebuilding".into());
                self.close_live(live).await;
                self.schedule_reconnect(cause).await;
            }
            Err(Interrupted) => {
                self.close_live(live).await;
                self.attempt_interrupted();
            }
        }
    }

    async fn drop_and_reconnect(&mut self, cause: ReconnectCause) {
        self.log(LogLevel::Info, LogCategory::Connection, "reconnect", format!("Reconnecting: {cause:?}"));
        self.teardown_link().await;
        self.schedule_reconnect(cause).await;
    }

    async fn schedule_reconnect(&mut self, cause: ReconnectCause) {
        if let Mode::Active(s) = &mut self.mode {
            s.cause = Some(cause);
            s.attempt = 0;
            s.link = Link::Down { next_attempt_at: Instant::now(), retry_at_ms: None };
        }
        self.stats_tx.send_replace(None);
        let _ = self.apply_policy(self.compute(Phase::Holding)).await;
        self.publish_progress(ConnectPhase::SelectingServer, None);
    }

    // ── tunnel ownership ────────────────────────────────────────────────

    fn is_up(&self) -> bool {
        matches!(&self.mode, Mode::Active(Session { link: Link::Up(_), .. }))
    }

    fn take_live(&mut self) -> Option<Box<Live>> {
        let Mode::Active(s) = &mut self.mode else { return None };
        if !matches!(s.link, Link::Up(_)) {
            return None;
        }
        match std::mem::replace(&mut s.link, Link::Down { next_attempt_at: far_future(), retry_at_ms: None }) {
            Link::Up(live) => Some(live),
            _ => unreachable!(),
        }
    }

    fn put_live(&mut self, live: Box<Live>) {
        if let Mode::Active(s) = &mut self.mode {
            s.link = Link::Up(live);
        }
    }

    async fn close_live(&mut self, live: Box<Live>) {
        if !live.dns.is_empty() {
            if let Err(e) = self.deps.dns.reset().await {
                self.log(LogLevel::Warn, LogCategory::Dns, "dns.reset_failed", e.detail);
            }
        }
        live.tunnel.close().await;
    }

    async fn teardown_link(&mut self) {
        if let Some(live) = self.take_live() {
            self.close_live(live).await;
        }
    }

    // ── firewall ────────────────────────────────────────────────────────

    fn compute(&self, phase: Phase<'_>) -> FirewallPolicy {
        firewall::compute(phase, &self.settings, &self.exceptions)
    }

    async fn apply_policy(&mut self, policy: FirewallPolicy) -> Result<(), PlatformError> {
        if self.applied.as_ref() == Some(&policy) {
            return Ok(());
        }
        match self.deps.firewall.apply(&policy).await {
            Ok(()) => {
                self.log(LogLevel::Debug, LogCategory::Firewall, "firewall.applied", format!("Firewall policy: {}", policy.describe()));
                self.policy_tx.send_replace(PolicyStatus { description: policy.describe(), last_apply_failed: false });
                self.applied = Some(policy);
                Ok(())
            }
            Err(e) => {
                self.policy_tx.send_modify(|p| p.last_apply_failed = true);
                Err(e)
            }
        }
    }

    /// Recompute the policy for the current mode (after settings or
    /// exception changes) and refresh the published state.
    async fn reapply_policy(&mut self) {
        let policy = match &self.mode {
            Mode::Idle => self.compute(Phase::Idle),
            Mode::Failed { hold: true, .. } => self.compute(Phase::Holding),
            Mode::Failed { hold: false, .. } => self.compute(Phase::Idle),
            Mode::Active(s) => match &s.link {
                Link::Up(live) => self.compute(Phase::Established {
                    peer: live.peer,
                    tunnel: &live.details.interface,
                    dns: &live.dns,
                    ipv6_tunneled: live.ipv6_tunneled,
                }),
                _ => self.compute(Phase::Holding),
            },
        };
        if let Err(e) = self.apply_policy(policy).await {
            self.log(LogLevel::Error, LogCategory::Firewall, "firewall.failed", e.detail);
        }
        self.refresh_state();
    }

    fn refresh_state(&mut self) {
        let blocking = self.blocking();
        let ipv6 = match &self.mode {
            Mode::Active(Session { link: Link::Up(live), .. }) => Some(live.ipv6_tunneled),
            _ => None,
        };
        if let Some(ipv6) = ipv6 {
            let p = self.protections(ipv6);
            if let Mode::Active(Session { link: Link::Up(live), .. }) = &mut self.mode {
                live.details.protections = p;
            }
        }
        let state = match &self.mode {
            Mode::Idle => TunnelState::Disconnected { locked_down: blocking },
            Mode::Failed { error, .. } => TunnelState::Error { error: error.clone(), blocking },
            Mode::Active(s) => match &s.link {
                Link::Up(live) => TunnelState::Connected { details: Box::new(live.details.clone()) },
                Link::Waiting => TunnelState::WaitingForNetwork { target: Some(s.target.clone()), blocking },
                Link::Down { retry_at_ms, .. } => {
                    let phase = if retry_at_ms.is_some() { ConnectPhase::WaitingToRetry } else { ConnectPhase::SelectingServer };
                    self.publish_progress(phase, *retry_at_ms);
                    return;
                }
            },
        };
        self.emit(state);
    }

    /// Why a connection can't start at all, regardless of server or network:
    /// no registered device, or a registration whose plan has ended.
    fn cannot_start(&self) -> Option<PlatformError> {
        let Some(device) = self.device.as_ref() else {
            return Some(PlatformError::new(ErrorKind::AuthRequired, "this device has no registered key; sign in again"));
        };
        let until = device.registration.valid_until?;
        (until.saturating_add(ENTITLEMENT_CLOCK_GRACE_MS) <= now_millis())
            .then(|| PlatformError::new(ErrorKind::SubscriptionInactive, "the plan on this account has ended; renew it to connect"))
    }

    /// Protection is (or was meant to be) in force: a session is running, or
    /// one lapsed and the kill switch is holding.
    fn protecting(&self) -> bool {
        matches!(self.mode, Mode::Active(_) | Mode::Failed { hold: true, .. })
    }

    fn blocking(&self) -> bool {
        self.applied.as_ref().is_some_and(|p| p.block_by_default)
    }

    // ── publishing ──────────────────────────────────────────────────────

    fn attempt_no(&self) -> u32 {
        match &self.mode {
            Mode::Active(s) => s.attempt,
            _ => 0,
        }
    }

    fn publish_progress(&self, phase: ConnectPhase, retry_at: Option<u64>) {
        let Mode::Active(s) = &self.mode else { return };
        let blocking = self.blocking();
        let last_error = s.last_error.as_ref().map(|e| e.kind);
        let state = if s.ever_connected {
            TunnelState::Reconnecting {
                target: s.target.clone(),
                relay: s.relay.clone(),
                attempt: s.attempt,
                cause: s.cause.unwrap_or(ReconnectCause::TunnelFailure),
                phase,
                blocking,
                last_error,
                retry_at,
            }
        } else {
            TunnelState::Connecting {
                target: s.target.clone(),
                relay: s.relay.clone(),
                attempt: s.attempt,
                phase,
                blocking,
                last_error,
                retry_at,
            }
        };
        self.emit(state);
    }

    fn emit(&self, state: TunnelState) {
        self.state_tx.send_if_modified(|current| {
            if *current == state {
                false
            } else {
                *current = state;
                true
            }
        });
    }

    fn log(&self, level: LogLevel, category: LogCategory, event: &'static str, message: String) {
        self.deps.log.record(level, category, event, message);
    }

    fn is_online(&self) -> bool {
        self.network.as_ref().map_or(true, |n| n.online)
    }

    /// Runs `fut` while still taking commands. Passive commands are applied
    /// as they arrive; anything else cancels `fut` (it's dropped) and is
    /// queued to be handled next.
    async fn interruptible<F: Future>(&mut self, fut: F) -> Result<F::Output, Interrupted> {
        tokio::pin!(fut);
        loop {
            tokio::select! {
                biased;
                out = &mut fut => return Ok(out),
                cmd = self.rx.recv(), if !self.closed => match cmd {
                    None => {
                        self.closed = true;
                        return Err(Interrupted);
                    }
                    Some(c) => {
                        if let Some(c) = self.absorb(c) {
                            self.deferred.push_back(c);
                            return Err(Interrupted);
                        }
                    }
                },
            }
        }
    }
}

/// Waits for the first handshake, nudging it with probes (WireGuard only
/// handshakes when there's something to send). `Ok(Some(rtt))` means a probe
/// already made it through, so the tunnel is verified too.
async fn await_handshake(
    tunnel: &dyn Tunnel,
    target: IpAddr,
    timing: &Timing,
    since_ms: u64,
) -> Result<Option<Duration>, PlatformError> {
    let deadline = Instant::now() + timing.handshake_timeout;
    loop {
        if let Ok(rtt) = tunnel.probe(target, timing.probe_timeout).await {
            return Ok(Some(rtt));
        }
        let stats = tunnel.stats().await?;
        if stats.last_handshake.is_some_and(|h| h + 1_000 >= since_ms) {
            return Ok(None);
        }
        if Instant::now() >= deadline {
            return Err(PlatformError::new(
                ErrorKind::HandshakeTimeout,
                "the server did not answer the handshake (UDP may be blocked, or the key isn't registered)",
            ));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn verify_tunnel(tunnel: &dyn Tunnel, target: IpAddr, timing: &Timing) -> Result<Duration, PlatformError> {
    let deadline = Instant::now() + timing.verify_timeout;
    loop {
        match tunnel.probe(target, timing.probe_timeout).await {
            Ok(rtt) => return Ok(rtt),
            Err(_) if Instant::now() < deadline => tokio::time::sleep(Duration::from_millis(200)).await,
            Err(e) => {
                return Err(PlatformError::new(
                    ErrorKind::TunnelVerificationFailed,
                    format!("handshake completed but nothing came back through the tunnel: {}", e.detail),
                ))
            }
        }
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(d) => tokio::time::sleep_until(d).await,
        None => std::future::pending().await,
    }
}

fn far_future() -> Instant {
    Instant::now() + Duration::from_secs(86_400 * 365)
}

fn primary_id(n: &NetworkSnapshot) -> Option<(&str, Option<&str>)> {
    n.primary.as_ref().map(|p| (p.id.as_str(), p.ssid.as_deref()))
}

fn err(kind: ErrorKind, detail: &str) -> TunnelError {
    TunnelError { kind, detail: Some(detail.into()), at: now_millis() }
}

fn describe_target(t: &ConnectTarget) -> String {
    match t {
        ConnectTarget::Server { id } => format!("server {id}"),
        ConnectTarget::Smart { mode, country, city, features } => {
            let mut s = format!("{mode:?}");
            if let Some(c) = country {
                s.push_str(&format!(" in {c}"));
            }
            if let Some(c) = city {
                s.push_str(&format!("/{c}"));
            }
            if !features.is_empty() {
                s.push_str(&format!(" with {features:?}"));
            }
            s
        }
    }
}
