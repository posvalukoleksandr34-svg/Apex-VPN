//! State machine scenarios with a fake platform: a fake WireGuard driver
//! whose servers can be made dead, silent or slow; a firewall that records
//! every policy; and a DNS configurator that can fail. Time is paused, so
//! back-offs and timeouts run instantly and deterministically.

use super::*;
use crate::firewall::FirewallPolicy;
use crate::keys::PrivateKey;
use crate::platform::*;
use async_trait::async_trait;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;
use vpn_types::time::now_millis;
use vpn_types::*;
use vpn_types::ipc::FirewallSummary;

// ── fake platform ───────────────────────────────────────────────────────

#[derive(Default)]
struct World {
    /// Endpoints that never answer the handshake.
    dead: HashSet<IpAddr>,
    /// Endpoints that handshake but pass no traffic.
    silent: HashSet<IpAddr>,
    /// Every tunnel stops passing traffic (server died mid-session).
    all_silent: bool,
    open_delay: Duration,
    open_error: Option<ErrorKind>,
    opened: u32,
    closed: u32,
    configs: Vec<TunnelConfig>,
}

type Shared = Arc<Mutex<World>>;

struct FakeDriver(Shared);

#[async_trait]
impl TunnelDriver for FakeDriver {
    fn protocol(&self) -> Protocol {
        Protocol::WireGuard
    }

    fn capability(&self) -> ProtocolCapability {
        ProtocolCapability { protocol: Protocol::WireGuard, availability: Availability::Available, implementation: Some("fake".into()) }
    }

    async fn open(&self, config: TunnelConfig) -> PlatformResult<Box<dyn Tunnel>> {
        let (delay, error) = {
            let w = self.0.lock().unwrap();
            (w.open_delay, w.open_error)
        };
        tokio::time::sleep(delay).await;
        if let Some(kind) = error {
            return Err(PlatformError::new(kind, "fake open failure"));
        }
        let mut w = self.0.lock().unwrap();
        w.opened += 1;
        w.configs.push(config.clone());
        Ok(Box::new(FakeTunnel {
            world: self.0.clone(),
            endpoint: config.peer.endpoint.ip(),
            rx: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            index: w.opened,
        }))
    }
}

struct FakeTunnel {
    world: Shared,
    endpoint: IpAddr,
    rx: AtomicU64,
    closed: AtomicBool,
    index: u32,
}

impl FakeTunnel {
    fn passes_traffic(&self) -> bool {
        let w = self.world.lock().unwrap();
        !(w.dead.contains(&self.endpoint) || w.silent.contains(&self.endpoint) || w.all_silent)
    }

    fn mark_closed(&self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            self.world.lock().unwrap().closed += 1;
        }
    }
}

#[async_trait]
impl Tunnel for FakeTunnel {
    fn interface(&self) -> InterfaceInfo {
        InterfaceInfo { name: "Apexy VPN".into(), index: Some(40 + self.index), luid: Some(1000 + self.index as u64) }
    }

    async fn stats(&self) -> PlatformResult<TunnelStats> {
        let handshake = !self.world.lock().unwrap().dead.contains(&self.endpoint);
        Ok(TunnelStats {
            rx_bytes: self.rx.load(Ordering::SeqCst),
            tx_bytes: 0,
            last_handshake: handshake.then(now_millis),
            sampled_at: now_millis(),
        })
    }

    async fn probe(&self, _target: IpAddr, timeout: Duration) -> PlatformResult<Duration> {
        if self.passes_traffic() {
            self.rx.fetch_add(84, Ordering::SeqCst);
            Ok(Duration::from_millis(12))
        } else {
            tokio::time::sleep(timeout).await;
            Err(PlatformError::new(ErrorKind::Timeout, "probe timed out"))
        }
    }

    async fn close(self: Box<Self>) {
        self.mark_closed();
    }
}

impl Drop for FakeTunnel {
    // Like the real driver: dropping without close still removes the adapter.
    fn drop(&mut self) {
        self.mark_closed();
    }
}

#[derive(Default)]
struct FakeFirewall {
    policies: Mutex<Vec<FirewallPolicy>>,
    fail: AtomicBool,
}

#[async_trait]
impl Firewall for FakeFirewall {
    async fn apply(&self, policy: &FirewallPolicy) -> PlatformResult<()> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(PlatformError::new(ErrorKind::FirewallFailure, "fake WFP failure"));
        }
        self.policies.lock().unwrap().push(policy.clone());
        Ok(())
    }

    async fn summary(&self) -> FirewallSummary {
        FirewallSummary { policy: "fake".into(), verified: true, filter_count: 0 }
    }
}

impl FakeFirewall {
    fn last(&self) -> FirewallPolicy {
        self.policies.lock().unwrap().last().cloned().expect("a policy was applied")
    }

    fn all(&self) -> Vec<FirewallPolicy> {
        self.policies.lock().unwrap().clone()
    }
}

#[derive(Default)]
struct FakeDns {
    applied: Mutex<Vec<Vec<IpAddr>>>,
    resets: AtomicU64,
    fail: AtomicBool,
}

#[async_trait]
impl DnsConfigurator for FakeDns {
    async fn apply(&self, _tunnel: &InterfaceInfo, servers: &[IpAddr]) -> PlatformResult<()> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(PlatformError::new(ErrorKind::DnsFailure, "fake DNS failure"));
        }
        self.applied.lock().unwrap().push(servers.to_vec());
        Ok(())
    }

    async fn reset(&self) -> PlatformResult<()> {
        self.resets.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn effective(&self, _tunnel: &InterfaceInfo) -> Vec<IpAddr> {
        self.applied.lock().unwrap().last().cloned().unwrap_or_default()
    }
}

#[derive(Default)]
struct FakeLog(Mutex<Vec<(&'static str, String)>>);

impl ConnectionLog for FakeLog {
    fn record(&self, _level: LogLevel, _category: LogCategory, event: &'static str, message: String) {
        self.0.lock().unwrap().push((event, message));
    }
}

impl FakeLog {
    fn count(&self, event: &str) -> usize {
        self.0.lock().unwrap().iter().filter(|(e, _)| *e == event).count()
    }
}

// ── fixtures ────────────────────────────────────────────────────────────

const FRA: &str = "185.65.134.10";
const BER: &str = "185.65.134.20";

fn relays() -> RelayList {
    let mut list = crate::relay::tests::sample_list(1, now_millis() + 86_400_000);
    list.locations.push(Location {
        id: "de-ber".into(),
        country_code: "DE".into(),
        country: "Germany".into(),
        city: "Berlin".into(),
        latitude: 52.52,
        longitude: 13.40,
    });
    let mut ber = list.servers[0].clone();
    ber.id = "de-ber-001".into();
    ber.hostname = "de-ber-001.relays.example.net".into();
    ber.location_id = "de-ber".into();
    ber.ipv4 = BER.parse().unwrap();
    ber.load = Some(60);
    list.servers[0].load = Some(10); // Frankfurt ranks first
    list.servers.push(ber);
    list
}

fn device() -> DeviceCredentials {
    DeviceCredentials {
        private_key: PrivateKey::generate(),
        registration: DeviceRegistration {
            device_id: "dev-1".into(),
            public_key: String::new(),
            ipv4_address: Ipv4Addr::new(10, 64, 1, 2),
            ipv6_address: Some("fc00:bbbb::2".parse().unwrap()),
            valid_until: None,
        },
    }
}

fn network(online: bool, id: &str) -> NetworkSnapshot {
    NetworkSnapshot {
        online,
        primary: online.then(|| PhysicalNetwork {
            id: id.into(),
            interface_name: id.into(),
            medium: NetworkMedium::Wifi,
            ssid: Some(id.into()),
            wifi_security: Some(WifiSecurity::Protected),
            has_ipv4: true,
            has_ipv6: false,
            dns_servers: vec!["192.168.1.1".parse().unwrap()],
            gateway: None,
        }),
        networks: vec![],
        observed_at: now_millis(),
    }
}

struct Harness {
    handle: MachineHandle,
    world: Shared,
    fw: Arc<FakeFirewall>,
    dns: Arc<FakeDns>,
    log: Arc<FakeLog>,
}

struct Setup {
    settings: Settings,
    resume: Option<ConnectTarget>,
    device: Option<DeviceCredentials>,
    world: World,
    firewall_fails: bool,
}

impl Default for Setup {
    fn default() -> Self {
        Self { settings: Settings::default(), resume: None, device: Some(device()), world: World::default(), firewall_fails: false }
    }
}

fn start(setup: Setup) -> Harness {
    let world: Shared = Arc::new(Mutex::new(setup.world));
    let fw = Arc::new(FakeFirewall::default());
    fw.fail.store(setup.firewall_fails, Ordering::SeqCst);
    let dns = Arc::new(FakeDns::default());
    let log = Arc::new(FakeLog::default());
    let (handle, _task) = spawn(
        Dependencies {
            drivers: vec![Arc::new(FakeDriver(world.clone()))],
            firewall: fw.clone(),
            dns: dns.clone(),
            log: log.clone(),
        },
        Inputs {
            settings: setup.settings,
            relays: Some(Arc::new(relays())),
            device: setup.device,
            network: Some(network(true, "home-wifi")),
            exceptions: vec![],
            spread_seed: 0,
            split_tunnel_supported: false,
            resume: setup.resume,
        },
        Timing::default(),
    );
    Harness { handle, world, fw, dns, log }
}

impl Harness {
    fn send(&self, c: Command) {
        self.handle.commands.send(c).unwrap();
    }

    async fn until(&mut self, what: &str, pred: impl Fn(&TunnelState) -> bool) -> TunnelState {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
        loop {
            {
                let s = self.handle.state.borrow_and_update();
                if pred(&s) {
                    return s.clone();
                }
            }
            match tokio::time::timeout_at(deadline, self.handle.state.changed()).await {
                Ok(Ok(())) => {}
                _ => panic!("timed out waiting for {what}; last state: {:?}", *self.handle.state.borrow()),
            }
        }
    }

    async fn connected(&mut self) -> Box<ConnectedDetails> {
        match self.until("connected", |s| s.is_connected()).await {
            TunnelState::Connected { details } => details,
            _ => unreachable!(),
        }
    }

    fn world(&self) -> std::sync::MutexGuard<'_, World> {
        self.world.lock().unwrap()
    }
}

fn connect(target: Option<ConnectTarget>) -> Command {
    Command::Connect(target)
}

// ── scenarios ───────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn connects_and_applies_rules_in_a_leak_free_order() {
    let mut h = start(Setup::default());
    h.send(connect(None));
    let details = h.connected().await;

    assert_eq!(details.relay.server_id, "de-fra-001");
    assert_eq!(details.cipher, CipherSuite::wireguard());
    assert!(details.protections.kill_switch);
    assert!(details.protections.dns_leak_blocking);
    assert_eq!(details.dns_servers, vec!["10.64.0.1".parse::<IpAddr>().unwrap()]);

    let policies = h.fw.all();
    // Idle (open) → peer only → peer + tunnel → established.
    let block_start = policies.iter().position(|p| p.block_by_default).unwrap();
    let establishing = &policies[block_start];
    assert!(establishing.peer.is_some() && establishing.tunnel.is_none(), "peer allowed before the interface exists");
    let with_tunnel = &policies[block_start + 1];
    assert!(with_tunnel.tunnel.is_some() && with_tunnel.dns_only_via_tunnel.is_none());
    let established = h.fw.last();
    assert!(established.block_by_default && established.dns_only_via_tunnel.is_some());
    assert!(established.block_ipv6_outside_tunnel, "server has no IPv6: block it outside the tunnel");
    assert_eq!(h.dns.applied.lock().unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn never_reports_connected_without_a_handshake() {
    let mut world = World::default();
    world.dead.insert(FRA.parse().unwrap());
    world.dead.insert(BER.parse().unwrap());
    let mut h = start(Setup { world, ..Setup::default() });
    h.send(connect(None));

    let s = h
        .until("a retry after handshake timeout", |s| {
            matches!(s, TunnelState::Connecting { phase: ConnectPhase::WaitingToRetry, last_error: Some(ErrorKind::HandshakeTimeout), .. })
        })
        .await;
    assert!(s.is_blocking(), "kill switch holds traffic while retrying");
    // Let it churn through several attempts on both servers.
    tokio::time::sleep(Duration::from_secs(120)).await;
    assert!(!h.handle.state.borrow().is_connected());
    assert_eq!(h.log.count("connect.succeeded"), 0);
    assert!(h.fw.last().block_by_default);
    let w = h.world();
    assert_eq!(w.opened, w.closed, "every failed tunnel was torn down");
}

#[tokio::test(start_paused = true)]
async fn handshake_without_traffic_is_a_verification_failure() {
    let mut world = World::default();
    world.silent.insert(FRA.parse().unwrap());
    let mut settings = Settings::default();
    settings.default_target = ConnectTarget::Server { id: "de-fra-001".into() };
    let mut h = start(Setup { world, settings, ..Setup::default() });
    h.send(connect(None));
    h.until("verification failure", |s| {
        matches!(s, TunnelState::Connecting { last_error: Some(ErrorKind::TunnelVerificationFailed), .. })
    })
    .await;
    assert_eq!(h.log.count("connect.succeeded"), 0);
}

#[tokio::test(start_paused = true)]
async fn smart_connect_moves_to_the_next_server_after_repeated_failures() {
    let mut world = World::default();
    world.dead.insert(FRA.parse().unwrap());
    let mut h = start(Setup { world, ..Setup::default() });
    h.send(connect(None));
    let details = h.connected().await;
    assert_eq!(details.relay.server_id, "de-ber-001");
    let w = h.world();
    // Three tries on Frankfurt (switch_server_after = 3), then Berlin.
    assert_eq!(w.configs.len(), 4);
    assert!(w.configs[..3].iter().all(|c| c.peer.endpoint.ip() == FRA.parse::<IpAddr>().unwrap()));
}

#[tokio::test(start_paused = true)]
async fn disconnect_cancels_an_attempt_and_cleans_up() {
    let world = World { open_delay: Duration::from_secs(10), ..World::default() };
    let mut h = start(Setup { world, ..Setup::default() });
    h.send(connect(None));
    h.until("creating interface", |s| matches!(s, TunnelState::Connecting { phase: ConnectPhase::CreatingInterface, .. })).await;
    h.send(Command::Disconnect);
    let s = h.until("disconnected", |s| matches!(s, TunnelState::Disconnected { .. })).await;
    assert_eq!(s, TunnelState::Disconnected { locked_down: false });
    assert!(h.fw.last().is_open());
    tokio::time::sleep(Duration::from_secs(30)).await;
    assert!(matches!(*h.handle.state.borrow(), TunnelState::Disconnected { .. }), "no zombie attempt");
    let w = h.world();
    assert_eq!(w.opened, w.closed);
}

#[tokio::test(start_paused = true)]
async fn wifi_to_hotspot_keeps_a_tunnel_that_still_works() {
    let mut h = start(Setup::default());
    h.send(connect(None));
    let before = h.connected().await;

    h.send(Command::Platform(PlatformEvent::Network(network(true, "phone-hotspot"))));
    h.until("checking", |s| matches!(s, TunnelState::Reconnecting { cause: ReconnectCause::NetworkChanged, phase: ConnectPhase::CheckingTunnel, .. })).await;
    let after = h.connected().await;
    assert_eq!(after.connected_at, before.connected_at, "same session");
    assert_eq!(h.world().opened, 1, "no rebuild needed");
    assert!(h.fw.last().block_by_default);
}

#[tokio::test(start_paused = true)]
async fn network_change_rebuilds_a_tunnel_that_stopped_working() {
    let mut h = start(Setup::default());
    h.send(connect(None));
    h.connected().await;

    h.world().all_silent = true;
    h.send(Command::Platform(PlatformEvent::Network(network(true, "phone-hotspot"))));
    h.until("rebuilding", |s| matches!(s, TunnelState::Reconnecting { cause: ReconnectCause::NetworkChanged, phase: ConnectPhase::SelectingServer | ConnectPhase::CreatingInterface | ConnectPhase::Handshaking | ConnectPhase::WaitingToRetry, .. })).await;
    h.world().all_silent = false;
    h.connected().await;
    assert!(h.world().opened >= 2);
}

#[tokio::test(start_paused = true)]
async fn losing_the_network_waits_blocked_and_resumes() {
    let mut h = start(Setup::default());
    h.send(connect(None));
    h.connected().await;

    h.send(Command::Platform(PlatformEvent::Network(network(false, ""))));
    let s = h.until("waiting", |s| matches!(s, TunnelState::WaitingForNetwork { .. })).await;
    assert!(s.is_blocking(), "no traffic escapes while offline");
    assert_eq!(h.world().closed, 1);

    h.send(Command::Platform(PlatformEvent::Network(network(true, "phone-hotspot"))));
    h.connected().await;
    assert_eq!(h.log.count("network.online"), 1);
}

#[tokio::test(start_paused = true)]
async fn sleep_and_wake_verifies_the_tunnel() {
    let mut h = start(Setup::default());
    h.send(connect(None));
    h.connected().await;
    h.send(Command::Platform(PlatformEvent::Suspending));
    h.send(Command::Platform(PlatformEvent::Resumed));
    h.until("checking after wake", |s| matches!(s, TunnelState::Reconnecting { cause: ReconnectCause::WokeFromSleep, .. })).await;
    h.connected().await;
}

#[tokio::test(start_paused = true)]
async fn lid_closed_with_network_gone_then_wake_on_new_network() {
    let mut h = start(Setup::default());
    h.send(connect(None));
    h.connected().await;
    h.send(Command::Platform(PlatformEvent::Suspending));
    h.send(Command::Platform(PlatformEvent::Network(network(false, ""))));
    h.until("waiting", |s| matches!(s, TunnelState::WaitingForNetwork { .. })).await;
    h.send(Command::Platform(PlatformEvent::Resumed));
    h.send(Command::Platform(PlatformEvent::Network(network(true, "office-wifi"))));
    h.connected().await;
}

#[tokio::test(start_paused = true)]
async fn server_dying_mid_session_is_detected_and_replaced() {
    let mut h = start(Setup::default());
    h.send(connect(None));
    let first = h.connected().await;
    assert_eq!(first.relay.server_id, "de-fra-001");

    h.world().dead.insert(FRA.parse().unwrap());
    h.until("reconnecting", |s| matches!(s, TunnelState::Reconnecting { .. })).await;
    let second = h.connected().await;
    assert_eq!(second.relay.server_id, "de-ber-001");
}

#[tokio::test(start_paused = true)]
async fn server_put_in_maintenance_migrates_the_session() {
    let mut h = start(Setup::default());
    h.send(connect(None));
    h.connected().await;
    let mut list = relays();
    list.version = 2;
    list.servers[0].status = ServerStatus::Maintenance;
    h.send(Command::Relays(Arc::new(list)));
    // The intermediate Reconnecting state can be coalesced by the watch
    // channel; assert on the outcome and the logged cause instead.
    h.until("migrated", |s| matches!(s, TunnelState::Connected { details } if details.relay.server_id == "de-ber-001")).await;
    assert_eq!(h.log.count("server.unavailable"), 1);
    assert!(h.log.0.lock().unwrap().iter().any(|(e, m)| *e == "reconnect" && m.contains("ServerUnavailable")));
}

#[tokio::test(start_paused = true)]
async fn kill_switch_modes() {
    // Off: nothing is ever blocked, even while connecting.
    let mut s = Settings::default();
    s.kill_switch = KillSwitchMode::Off;
    let mut h = start(Setup { settings: s, ..Setup::default() });
    h.send(connect(None));
    let d = h.connected().await;
    assert!(!d.protections.kill_switch);
    assert!(h.fw.all().iter().all(|p| !p.block_by_default));

    // Always on: blocked while idle, and again after disconnecting.
    let mut s = Settings::default();
    s.kill_switch = KillSwitchMode::AlwaysOn;
    let mut h = start(Setup { settings: s, ..Setup::default() });
    let st = h.until("locked down", |s| matches!(s, TunnelState::Disconnected { locked_down: true })).await;
    assert!(st.is_blocking());
    h.send(connect(None));
    h.connected().await;
    h.send(Command::Disconnect);
    h.until("locked down again", |s| matches!(s, TunnelState::Disconnected { locked_down: true })).await;
    assert!(h.fw.last().block_by_default);
}

#[tokio::test(start_paused = true)]
async fn firewall_failure_refuses_to_connect() {
    let mut h = start(Setup { firewall_fails: true, ..Setup::default() });
    h.send(connect(None));
    let s = h.until("error", |s| matches!(s, TunnelState::Error { .. })).await;
    match s {
        TunnelState::Error { error, blocking } => {
            assert_eq!(error.kind, ErrorKind::FirewallFailure);
            assert!(!blocking, "never claim blocking when the rules could not be installed");
        }
        _ => unreachable!(),
    }
    assert_eq!(h.world().opened, 0, "no tunnel without the requested protection");
}

#[tokio::test(start_paused = true)]
async fn dns_failure_is_an_error_that_keeps_traffic_blocked() {
    let mut h = start(Setup::default());
    h.dns.fail.store(true, Ordering::SeqCst);
    h.send(connect(None));
    let s = h.until("error", |s| matches!(s, TunnelState::Error { .. })).await;
    assert!(matches!(s, TunnelState::Error { ref error, blocking: true } if error.kind == ErrorKind::DnsFailure));
    {
        let w = h.world();
        assert_eq!(w.opened, w.closed);
    }

    // Retry after the problem is fixed.
    h.dns.fail.store(false, Ordering::SeqCst);
    h.send(Command::Reconnect);
    h.connected().await;
}

#[tokio::test(start_paused = true)]
async fn missing_device_key_requires_authentication() {
    let mut h = start(Setup { device: None, ..Setup::default() });
    h.send(connect(None));
    let s = h.until("error", |s| matches!(s, TunnelState::Error { .. })).await;
    assert!(matches!(s, TunnelState::Error { error, .. } if error.kind == ErrorKind::AuthRequired));
}

#[tokio::test(start_paused = true)]
async fn service_restart_resumes_blocked_before_anything_else() {
    // "Application restart" / service crash: the service comes back with
    // the user's intent and must block before building the tunnel.
    let mut h = start(Setup { resume: Some(ConnectTarget::smart(SmartMode::BestOverall)), ..Setup::default() });
    h.connected().await;
    let first = h.fw.all().into_iter().next().unwrap();
    assert!(first.block_by_default && first.peer.is_none(), "first rule set blocks everything");
}

#[tokio::test(start_paused = true)]
async fn shutdown_keeps_blocking_while_the_tunnel_is_wanted() {
    let mut h = start(Setup::default());
    h.send(connect(None));
    h.connected().await;
    let (tx, rx) = oneshot::channel();
    h.send(Command::Shutdown(tx));
    rx.await.unwrap();
    assert!(h.fw.last().block_by_default);
    let w = h.world();
    assert_eq!(w.opened, w.closed);
}

#[tokio::test(start_paused = true)]
async fn settings_changes_reconnect_only_when_needed() {
    let mut h = start(Setup::default());
    h.send(connect(None));
    h.connected().await;

    let mut s = Settings::default();
    s.allow_lan = false;
    h.send(Command::Settings(Box::new(s.clone())));
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(h.world().opened, 1);
    assert!(!h.fw.last().allow_lan);

    s.network.mtu = Some(1380);
    h.send(Command::Settings(Box::new(s)));
    h.until("reconnected with new MTU", |s| matches!(s, TunnelState::Connected { details } if details.mtu == 1380)).await;
    assert_eq!(h.world().opened, 2);
    assert!(h.log.0.lock().unwrap().iter().any(|(e, m)| *e == "reconnect" && m.contains("SettingsChanged")));
}

#[tokio::test(start_paused = true)]
async fn ipv6_is_tunneled_when_the_server_supports_it() {
    let mut h = start(Setup::default());
    let mut list = relays();
    list.version = 2;
    for s in &mut list.servers {
        s.wireguard.as_mut().unwrap().gateway_ipv6 = Some("fc00:bbbb::1".parse().unwrap());
    }
    h.send(Command::Relays(Arc::new(list)));
    h.send(connect(None));
    let d = h.connected().await;
    assert!(d.protections.ipv6_tunneled);
    assert!(d.tunnel_ipv6.is_some());
    let cfg = h.world().configs.last().unwrap().clone();
    assert!(cfg.peer.allowed_ips.iter().any(|n| n.to_string() == "::/0"));
    assert!(!h.fw.last().block_ipv6_outside_tunnel);
    assert_eq!(d.dns_servers.len(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_node_can_name_its_resolver_instead_of_the_gateway() {
    // Third-party nodes (the WireGuard demo server) route but don't resolve.
    let mut h = start(Setup::default());
    let mut list = relays();
    list.version = 2;
    for s in &mut list.servers {
        s.wireguard.as_mut().unwrap().dns_ipv4 = Some("1.1.1.1".parse().unwrap());
    }
    h.send(Command::Relays(Arc::new(list)));
    h.send(connect(None));
    let d = h.connected().await;
    let resolver: IpAddr = "1.1.1.1".parse().unwrap();
    assert_eq!(d.dns_servers, vec![resolver]);
    // The kill switch lets DNS reach exactly that resolver, via the tunnel.
    assert_eq!(h.fw.last().dns_only_via_tunnel, Some(vec![resolver]));
}

#[tokio::test(start_paused = true)]
async fn specific_server_that_is_down_is_reported_not_substituted() {
    let mut list = relays();
    list.servers[0].status = ServerStatus::Offline;
    let mut h = start(Setup::default());
    h.send(Command::Relays(Arc::new(list)));
    h.send(connect(Some(ConnectTarget::Server { id: "de-fra-001".into() })));
    let s = h.until("error", |s| matches!(s, TunnelState::Error { .. } | TunnelState::Connecting { phase: ConnectPhase::WaitingToRetry, .. })).await;
    // Server-unavailable is worth waiting out, but it never silently
    // connects somewhere the user didn't pick.
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert!(!h.handle.state.borrow().is_connected(), "{s:?}");
    assert_eq!(h.world().opened, 0);
}

#[tokio::test(start_paused = true)]
async fn latencies_steer_fastest() {
    let mut h = start(Setup::default());
    let mut lat = HashMap::new();
    lat.insert("de-fra-001".to_string(), LatencySample { server_id: "de-fra-001".into(), rtt_ms: Some(80), measured_at: 0, via_tunnel: false });
    lat.insert("de-ber-001".to_string(), LatencySample { server_id: "de-ber-001".into(), rtt_ms: Some(9), measured_at: 0, via_tunnel: false });
    h.send(Command::Latencies(Arc::new(lat)));
    h.send(connect(Some(ConnectTarget::smart(SmartMode::Fastest))));
    assert_eq!(h.connected().await.relay.server_id, "de-ber-001");
}

fn device_valid_until(until_ms: u64) -> DeviceCredentials {
    let mut d = device();
    d.registration.valid_until = Some(until_ms);
    d
}

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

#[tokio::test(start_paused = true)]
async fn an_expired_plan_is_refused_without_engaging_the_kill_switch() {
    // Default kill switch: on while connected. Nothing is protected yet, so
    // refusing must not take the user's internet away.
    let mut h = start(Setup { device: Some(device_valid_until(now_millis() - DAY_MS)), ..Setup::default() });
    h.send(connect(None));
    let s = h.until("refused", |s| matches!(s, TunnelState::Error { .. })).await;
    assert!(matches!(s, TunnelState::Error { ref error, blocking: false } if error.kind == ErrorKind::SubscriptionInactive));
    assert!(!h.fw.last().block_by_default);
    assert_eq!(h.world().opened, 0, "no tunnel is created for a plan that has ended");

    // Pressing Connect again is still a refusal, not a blocking failure.
    h.send(connect(None));
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(!h.fw.last().block_by_default);
    assert_eq!(h.world().opened, 0);
}

#[tokio::test(start_paused = true)]
async fn a_plan_that_ends_mid_session_keeps_traffic_held() {
    let mut h = start(Setup { device: Some(device_valid_until(now_millis() + 30 * DAY_MS)), ..Setup::default() });
    h.send(connect(None));
    h.connected().await;
    // The plan ends (the app refreshes the registration); the next attempt
    // can't proceed, and the user expects no traffic outside the tunnel.
    h.send(Command::Device(Some(device_valid_until(now_millis() - DAY_MS))));
    h.send(Command::Reconnect);
    let s = h.until("error", |s| matches!(s, TunnelState::Error { .. })).await;
    assert!(matches!(s, TunnelState::Error { ref error, blocking: true } if error.kind == ErrorKind::SubscriptionInactive));
    assert!(h.fw.last().block_by_default);
}

#[tokio::test(start_paused = true)]
async fn renewing_lets_the_next_connect_through() {
    let mut h = start(Setup { device: Some(device_valid_until(now_millis() - DAY_MS)), ..Setup::default() });
    h.send(connect(None));
    h.until("refused", |s| matches!(s, TunnelState::Error { .. })).await;
    h.send(Command::Device(Some(device_valid_until(now_millis() + 30 * DAY_MS))));
    h.send(connect(None));
    h.connected().await;
}

#[tokio::test(start_paused = true)]
async fn a_slightly_fast_device_clock_is_tolerated() {
    // The registration ended two minutes ago by this device's clock: within
    // the skew allowance, so the node (which enforces the real deadline)
    // decides.
    let mut h = start(Setup { device: Some(device_valid_until(now_millis() - 2 * 60 * 1000)), ..Setup::default() });
    h.send(connect(None));
    h.connected().await;
}
