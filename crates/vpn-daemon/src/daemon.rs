//! The service: owns the platform, the tunnel state machine and persisted
//! state, runs the background tasks, and implements every IPC operation.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use vpn_core::autoconnect::{self, AutoAction};
use vpn_core::firewall::AppException;
use vpn_core::geo::GeoPoint;
use vpn_core::keys::PrivateKey;
use vpn_core::relay::{RelayError, RelayVerifier, TrustedKey};
use vpn_core::tunnel::{self, Command, ConnectionLog, DeviceCredentials, PolicyStatus};
use vpn_core::PlatformEvent;
use vpn_platform::{InitOptions, Platform};
use vpn_types::ipc::{ConnectionReport, DnsTestResult, Event, IpObservations, RelayListReply};
use vpn_types::time::now_millis;
use vpn_types::*;

use crate::api::ApiClient;
use crate::config::ServiceConfig;
use crate::logbook::LogBook;
use crate::store::{CachedRelays, Intent, NetworkCache, Store};

pub struct Options {
    pub data_dir: PathBuf,
    pub config_path: PathBuf,
}

pub struct DeviceState {
    pub key: PrivateKey,
    pub created_at: UnixMillis,
    pub registration: Option<DeviceRegistration>,
}

#[derive(Default)]
pub struct RelayState {
    pub list: Option<Arc<RelayList>>,
    pub fetched_at: Option<UnixMillis>,
    pub last_error: Option<ErrorKind>,
}

pub struct Daemon {
    pub cfg: ServiceConfig,
    pub platform: Platform,
    pub store: Store,
    pub log: Arc<LogBook>,
    pub events: broadcast::Sender<Event>,
    pub api: ApiClient,
    pub verifier: RelayVerifier,
    pub machine: mpsc::UnboundedSender<Command>,
    pub state: watch::Receiver<TunnelState>,
    pub stats: watch::Receiver<Option<TunnelStats>>,
    pub policy: watch::Receiver<PolicyStatus>,
    pub settings: RwLock<Settings>,
    pub device: RwLock<DeviceState>,
    pub relays: RwLock<RelayState>,
    pub latencies: RwLock<HashMap<ServerId, LatencySample>>,
    pub network_cache: RwLock<NetworkCache>,
    pub started: Instant,
    settings_lock: tokio::sync::Mutex<()>,
    relay_refresh: tokio::sync::Mutex<()>,
}

impl Daemon {
    pub async fn start(opts: &Options) -> anyhow::Result<Arc<Self>> {
        let cfg = ServiceConfig::load(&opts.config_path)?;
        let (events, _) = broadcast::channel(512);
        let log = Arc::new(LogBook::new(opts.data_dir.join("logs"), events.clone()));
        log.record(LogLevel::Info, LogCategory::Service, "service.start", format!("Apexy VPN service {} starting", env!("CARGO_PKG_VERSION")));

        let platform = vpn_platform::init(InitOptions { driver_dir: cfg.driver_dir(), require_signed_driver: true })
            .map_err(|e| anyhow::anyhow!("platform init failed: {e}"))?;
        for d in &platform.drivers {
            let c = d.capability();
            if let Availability::Unavailable(reason) = &c.availability {
                log.record(LogLevel::Info, LogCategory::Protocol, "protocol.unavailable", format!("{:?} unavailable: {reason:?}", c.protocol));
            }
        }
        if let Availability::Unavailable(reason) = &platform.kill_switch {
            log.record(LogLevel::Error, LogCategory::Firewall, "firewall.unavailable", format!(
                "Kill switch unavailable ({reason:?}); connections that need it will be refused"
            ));
        }

        let store = Store::new(&opts.data_dir);
        let loaded = store.load_settings();
        if let Some(backup) = &loaded.recovered_from {
            log.record(LogLevel::Error, LogCategory::Service, "settings.recovered", format!(
                "Settings were corrupted and have been reset to defaults. The damaged file was kept as {}",
                backup.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()
            ));
        }
        let settings = loaded.settings;
        log.configure(settings.logging.level, settings.logging.diagnostic_mode);

        let (key, created) = store.device_key(&*platform.secrets)?;
        if created {
            log.record(LogLevel::Info, LogCategory::Auth, "device.key_created", "Generated a new device key".into());
        }
        let public = key.key.public_key().to_base64();
        let registration = store.load_registration().filter(|r| r.public_key == public);

        let mut keys = Vec::new();
        for k in &cfg.relay_keys {
            match TrustedKey::from_base64(k.id.clone(), &k.public_key) {
                Ok(t) => keys.push(t),
                Err(e) => tracing::error!("ignoring relay key {}: {e}", k.id),
            }
        }
        let mut verifier = RelayVerifier::new(keys);
        if cfg.allow_private_relays {
            verifier = verifier.allowing_private_endpoints();
        }

        let mut relay_state = RelayState::default();
        if let Some(cached) = store.load_relays() {
            match verifier.verify_cached(&cached.signed) {
                Ok(list) => {
                    relay_state.list = Some(Arc::new(list));
                    relay_state.fetched_at = Some(cached.fetched_at);
                }
                Err(e) => tracing::warn!("discarding cached relay list: {e}"),
            }
        }

        let mut network_cache = store.load_network();
        network_cache.drop_non_public_observations();
        let api = ApiClient::new(&cfg.api_base_url)?;
        if !network_cache.api_addrs.is_empty() {
            api.pin_addresses(&network_cache.api_addrs);
        }
        let exceptions = exceptions(&cfg, &network_cache.api_addrs);

        let intent = store.load_intent();
        let resume = intent
            .wanted
            .clone()
            .or_else(|| settings.auto_connect.on_system_start.then(|| settings.default_target.clone()));

        let spread_seed = u64::from_le_bytes(Sha256::digest(public.as_bytes())[..8].try_into().expect("8 bytes"));
        let credentials = registration.clone().map(|r| DeviceCredentials { private_key: key.key.clone(), registration: r });
        let (handle, _task) = tunnel::spawn(
            tunnel::Dependencies {
                drivers: platform.drivers.clone(),
                firewall: platform.firewall.clone(),
                dns: platform.dns.clone(),
                log: log.clone(),
            },
            tunnel::Inputs {
                settings: settings.clone(),
                relays: relay_state.list.clone(),
                device: credentials,
                network: Some(platform.network.current()),
                exceptions,
                spread_seed,
                split_tunnel_supported: platform.split_tunnel.is_available(),
                resume,
            },
            tunnel::Timing::default(),
        );
        if let Some(location) = geo_of(network_cache.observations.as_ref().and_then(|o| o.unprotected.as_ref())) {
            let _ = handle.commands.send(Command::Location(Some(location)));
        }

        let daemon = Arc::new(Self {
            cfg,
            platform,
            store,
            log,
            events,
            api,
            verifier,
            machine: handle.commands,
            state: handle.state,
            stats: handle.stats,
            policy: handle.policy,
            settings: RwLock::new(settings),
            device: RwLock::new(DeviceState { key: key.key, created_at: key.created_at, registration }),
            relays: RwLock::new(relay_state),
            latencies: RwLock::new(HashMap::new()),
            network_cache: RwLock::new(network_cache),
            started: Instant::now(),
            settings_lock: tokio::sync::Mutex::new(()),
            relay_refresh: tokio::sync::Mutex::new(()),
        });
        daemon.clone().spawn_tasks();
        Ok(daemon)
    }

    /// Stops the state machine. With a wanted tunnel and a kill switch, the
    /// firewall keeps blocking after we exit.
    pub async fn shutdown(&self) {
        let (tx, rx) = oneshot::channel();
        if self.machine.send(Command::Shutdown(tx)).is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(10), rx).await;
        }
    }

    pub fn power_event(&self, ev: PlatformEvent) {
        let _ = self.machine.send(Command::Platform(ev));
    }

    // ── background tasks ────────────────────────────────────────────────

    fn spawn_tasks(self: Arc<Self>) {
        // Tunnel state → subscribers, plus follow-ups on transitions.
        let d = self.clone();
        tokio::spawn(async move {
            let mut rx = d.state.clone();
            loop {
                let state = rx.borrow_and_update().clone();
                let _ = d.events.send(Event::TunnelState(state.clone()));
                match &state {
                    TunnelState::Connected { details } => {
                        d.remember_last_server(&details.relay.server_id).await;
                        let d2 = d.clone();
                        // Confirm the exit address through the tunnel.
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_secs(1)).await;
                            let _ = d2.check_ip().await;
                        });
                    }
                    TunnelState::Disconnected { locked_down: false } => {
                        let d2 = d.clone();
                        tokio::spawn(async move { d2.refresh_unprotected_ip().await });
                    }
                    _ => {}
                }
                if rx.changed().await.is_err() {
                    break;
                }
            }
        });

        // Counters → subscribers.
        let d = self.clone();
        tokio::spawn(async move {
            let mut rx = d.stats.clone();
            while rx.changed().await.is_ok() {
                if let Some(stats) = *rx.borrow_and_update() {
                    let _ = d.events.send(Event::Stats(stats));
                }
            }
        });

        // Physical network changes → state machine, auto-connect, subscribers.
        let d = self.clone();
        tokio::spawn(async move {
            let mut rx = d.platform.network.subscribe();
            let mut previous = rx.borrow_and_update().clone();
            d.apply_auto_connect(None, &previous).await;
            while rx.changed().await.is_ok() {
                let snap = rx.borrow_and_update().clone();
                let _ = d.machine.send(Command::Platform(PlatformEvent::Network(snap.clone())));
                let _ = d.events.send(Event::Network(snap.clone()));
                d.apply_auto_connect(Some(&previous), &snap).await;
                previous = snap;
            }
        });

        // Relay list refresh.
        let d = self.clone();
        tokio::spawn(async move {
            loop {
                let ok = d.refresh_relays().await.is_ok();
                let wait = if ok {
                    let jitter = rand::random::<u64>() % 300;
                    let until_expiry = d
                        .relays
                        .read()
                        .expect("relays")
                        .list
                        .as_ref()
                        .map(|l| l.expires_at.saturating_sub(now_millis()) / 2)
                        .unwrap_or(u64::MAX);
                    Duration::from_secs((30 * 60 + jitter).min(until_expiry / 1000).max(60))
                } else {
                    Duration::from_secs(60)
                };
                tokio::time::sleep(wait).await;
            }
        });

        // Latency measurement while not connected (tunnel-inclusive numbers
        // aren't comparable and would mislead "Fastest").
        let d = self;
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            loop {
                let connected = d.state.borrow().is_connected();
                let have_list = d.relays.read().expect("relays").list.is_some();
                if !connected && have_list {
                    d.measure_latencies(None).await;
                }
                tokio::time::sleep(Duration::from_secs(10 * 60)).await;
            }
        });
    }

    async fn apply_auto_connect(&self, previous: Option<&NetworkSnapshot>, next: &NetworkSnapshot) {
        let settings = self.settings.read().expect("settings").clone();
        let wants = self.state.borrow().wants_tunnel();
        let (action, reason) = autoconnect::on_network_change(previous, next, &settings, wants);
        match action {
            AutoAction::Connect => {
                self.log.record(LogLevel::Info, LogCategory::Connection, "autoconnect.connect", format!("Auto-connect: {reason:?}"));
                let _ = self.connect(None).await;
            }
            AutoAction::Disconnect => {
                self.log.record(LogLevel::Info, LogCategory::Connection, "autoconnect.disconnect", format!("Trusted network: {reason:?}"));
                self.disconnect().await;
            }
            AutoAction::Nothing => {}
        }
    }

    // ── connection ──────────────────────────────────────────────────────

    pub async fn connect(&self, target: Option<ConnectTarget>) -> Result<(), IpcError> {
        if let Some(ConnectTarget::Server { id }) = &target {
            let known = self.relays.read().expect("relays").list.as_ref().is_some_and(|l| l.server(id).is_some());
            if !known {
                return Err(IpcError::new(IpcErrorKind::NotFound, format!("unknown server {id}")));
            }
        }
        let wanted = target.clone().or_else(|| Some(self.settings.read().expect("settings").default_target.clone()));
        if let Err(e) = self.store.save_intent(&Intent { wanted }) {
            tracing::warn!("could not persist intent: {e}");
        }
        self.machine
            .send(Command::Connect(target))
            .map_err(|_| IpcError::new(IpcErrorKind::Failed, "state machine stopped"))
    }

    pub async fn disconnect(&self) {
        if let Err(e) = self.store.save_intent(&Intent { wanted: None }) {
            tracing::warn!("could not persist intent: {e}");
        }
        let _ = self.machine.send(Command::Disconnect);
    }

    pub fn reconnect(&self) {
        let _ = self.machine.send(Command::Reconnect);
    }

    async fn remember_last_server(&self, server_id: &str) {
        let _g = self.settings_lock.lock().await;
        let mut s = self.settings.write().expect("settings");
        let target = ConnectTarget::Server { id: server_id.to_string() };
        if s.last_target.as_ref() != Some(&target) {
            s.last_target = Some(target);
            let _ = self.store.save_settings(&s);
            let _ = self.events.send(Event::Settings(Box::new(s.clone())));
        }
    }

    // ── settings ────────────────────────────────────────────────────────

    pub async fn update_settings(&self, patch: SettingsPatch) -> Result<Settings, IpcError> {
        let _g = self.settings_lock.lock().await;
        let current = self.settings.read().expect("settings").clone();
        let next = vpn_core::settings::apply_patch(&current, patch).map_err(|e| IpcError::invalid_argument(e.to_string()))?;
        self.commit_settings(next.clone())?;
        Ok(next)
    }

    pub async fn reset_settings(&self) -> Result<Settings, IpcError> {
        let _g = self.settings_lock.lock().await;
        let next = Settings::default();
        self.commit_settings(next.clone())?;
        Ok(next)
    }

    fn commit_settings(&self, next: Settings) -> Result<(), IpcError> {
        self.store.save_settings(&next).map_err(|e| IpcError::new(IpcErrorKind::Failed, format!("saving settings failed: {e}")))?;
        self.log.configure(next.logging.level, next.logging.diagnostic_mode);
        *self.settings.write().expect("settings") = next.clone();
        let _ = self.machine.send(Command::Settings(Box::new(next.clone())));
        let _ = self.events.send(Event::Settings(Box::new(next)));
        Ok(())
    }

    pub fn capabilities(&self) -> Capabilities {
        Capabilities {
            service_version: env!("CARGO_PKG_VERSION").to_string(),
            api_base_url: self.cfg.api_base_url.clone(),
            os: vpn_platform::os::info(),
            protocols: self.platform.drivers.iter().map(|d| d.capability()).collect(),
            kill_switch: self.platform.kill_switch.clone(),
            split_tunnel: self.platform.split_tunnel.clone(),
            wifi_detection: self.platform.wifi_detection.clone(),
            ipv6: Availability::Available,
            simulated: false,
        }
    }

    // ── relays ──────────────────────────────────────────────────────────

    pub fn relay_status(&self) -> RelayListStatus {
        let r = self.relays.read().expect("relays");
        RelayListStatus {
            version: r.list.as_ref().map(|l| l.version),
            fetched_at: r.fetched_at,
            expires_at: r.list.as_ref().map(|l| l.expires_at),
            stale: r.list.as_ref().is_none_or(|l| l.expires_at <= now_millis()),
            last_error: r.last_error,
        }
    }

    pub fn relay_reply(&self) -> RelayListReply {
        let list = self.relays.read().expect("relays").list.as_deref().cloned();
        RelayListReply { status: self.relay_status(), list }
    }

    pub async fn refresh_relays(&self) -> Result<RelayListStatus, ErrorKind> {
        let _g = self.relay_refresh.lock().await;
        self.refresh_api_addresses().await;
        let fetched = self.api.relays().await;
        let current_version = self.relays.read().expect("relays").list.as_ref().map(|l| l.version);
        let result = match fetched {
            Err(e) => {
                self.log.record(LogLevel::Warn, LogCategory::Server, "relay.fetch_failed", e.to_string());
                Err(ErrorKind::RelayListUnavailable)
            }
            Ok(signed) => match self.verifier.verify(&signed, now_millis(), current_version) {
                Ok(list) => {
                    let changed = current_version != Some(list.version);
                    let list = Arc::new(list);
                    let _ = self.store.save_relays(&CachedRelays { signed, fetched_at: now_millis() });
                    {
                        let mut r = self.relays.write().expect("relays");
                        r.list = Some(list.clone());
                        r.fetched_at = Some(now_millis());
                        r.last_error = None;
                    }
                    if changed {
                        self.log.record(LogLevel::Info, LogCategory::Server, "relay.updated", format!(
                            "Server list v{} ({} servers in {} locations)",
                            list.version,
                            list.servers.len(),
                            list.locations.len()
                        ));
                        let _ = self.machine.send(Command::Relays(list));
                    }
                    Ok(())
                }
                Err(RelayError::Rollback { have, got }) => {
                    self.log.record(LogLevel::Warn, LogCategory::Server, "relay.rollback", format!(
                        "Ignored an older server list (v{got}, have v{have})"
                    ));
                    Ok(())
                }
                Err(e) => {
                    self.log.record(LogLevel::Error, LogCategory::Server, "relay.rejected", format!("Server list rejected: {e}"));
                    Err(ErrorKind::RelayListInvalid)
                }
            },
        };
        if let Err(kind) = result {
            self.relays.write().expect("relays").last_error = Some(kind);
        }
        let status = self.relay_status();
        let _ = self.events.send(Event::RelayList(status.clone()));
        result.map(|_| status)
    }

    /// Keeps the kill-switch exception pointed at the API's current
    /// addresses (resolved while DNS still works).
    async fn refresh_api_addresses(&self) {
        let addrs = self.api.resolve().await;
        if addrs.is_empty() {
            return;
        }
        let changed = {
            let mut cache = self.network_cache.write().expect("network cache");
            let changed = cache.api_addrs != addrs;
            if changed {
                cache.api_addrs = addrs.clone();
                let _ = self.store.save_network(&cache);
            }
            changed
        };
        if changed {
            self.api.pin_addresses(&addrs);
            let _ = self.machine.send(Command::Exceptions(exceptions(&self.cfg, &addrs)));
        }
    }

    // ── latency ─────────────────────────────────────────────────────────

    pub async fn measure_latencies(&self, ids: Option<Vec<ServerId>>) -> Vec<LatencySample> {
        let targets: Vec<(ServerId, IpAddr)> = {
            let r = self.relays.read().expect("relays");
            let Some(list) = &r.list else { return Vec::new() };
            list.servers
                .iter()
                .filter(|s| s.accepts_connections())
                .filter(|s| ids.as_ref().is_none_or(|ids| ids.contains(&s.id)))
                .take(400)
                .map(|s| (s.id.clone(), IpAddr::V4(s.ipv4)))
                .collect()
        };
        let via_tunnel = self.state.borrow().is_connected();
        let semaphore = Arc::new(tokio::sync::Semaphore::new(16));
        let mut set = tokio::task::JoinSet::new();
        for (id, ip) in targets {
            let pinger = self.platform.pinger.clone();
            let permit = semaphore.clone();
            set.spawn(async move {
                let _p = permit.acquire().await;
                let mut best: Option<Duration> = None;
                for _ in 0..2 {
                    if let Some(rtt) = pinger.ping(ip, Duration::from_millis(1500)).await {
                        best = Some(best.map_or(rtt, |b| b.min(rtt)));
                    }
                }
                LatencySample {
                    server_id: id,
                    rtt_ms: best.map(|d| d.as_millis().max(1) as u32),
                    measured_at: now_millis(),
                    via_tunnel,
                }
            });
        }
        let mut samples = Vec::new();
        while let Some(Ok(s)) = set.join_next().await {
            samples.push(s);
        }
        let snapshot = {
            let mut map = self.latencies.write().expect("latencies");
            for s in &samples {
                map.insert(s.server_id.clone(), s.clone());
            }
            Arc::new(map.clone())
        };
        let _ = self.machine.send(Command::Latencies(snapshot));
        let _ = self.events.send(Event::Latencies(samples.clone()));
        samples
    }

    pub fn latencies(&self) -> Vec<LatencySample> {
        self.latencies.read().expect("latencies").values().cloned().collect()
    }

    // ── device ──────────────────────────────────────────────────────────

    pub fn device_info(&self) -> DeviceInfo {
        let d = self.device.read().expect("device");
        DeviceInfo { public_key: d.key.public_key().to_base64(), key_created_at: d.created_at, registration: d.registration.clone() }
    }

    pub fn set_registration(&self, reg: DeviceRegistration) -> Result<DeviceInfo, IpcError> {
        let creds = {
            let mut d = self.device.write().expect("device");
            if reg.public_key != d.key.public_key().to_base64() {
                return Err(IpcError::invalid_argument("the registration is for a different device key"));
            }
            self.store
                .save_registration(Some(&reg))
                .map_err(|e| IpcError::new(IpcErrorKind::Failed, e.to_string()))?;
            d.registration = Some(reg.clone());
            DeviceCredentials { private_key: d.key.clone(), registration: reg }
        };
        self.log.record(LogLevel::Info, LogCategory::Auth, "device.registered", "Device registration updated".into());
        let _ = self.machine.send(Command::Device(Some(creds)));
        let info = self.device_info();
        let _ = self.events.send(Event::Device(info.clone()));
        Ok(info)
    }

    pub fn clear_registration(&self) -> DeviceInfo {
        self.device.write().expect("device").registration = None;
        let _ = self.store.save_registration(None);
        self.log.record(LogLevel::Info, LogCategory::Auth, "device.unregistered", "Device registration removed (signed out)".into());
        let _ = self.machine.send(Command::Device(None));
        let info = self.device_info();
        let _ = self.events.send(Event::Device(info.clone()));
        info
    }

    pub fn rotate_key(&self) -> Result<DeviceInfo, IpcError> {
        let key = self
            .store
            .rotate_device_key(&*self.platform.secrets)
            .map_err(|e| IpcError::new(IpcErrorKind::Failed, e.to_string()))?;
        {
            let mut d = self.device.write().expect("device");
            d.key = key.key;
            d.created_at = key.created_at;
            d.registration = None;
        }
        let _ = self.store.save_registration(None);
        self.log.record(LogLevel::Info, LogCategory::Auth, "device.key_rotated", "Device key rotated; registration required".into());
        let _ = self.machine.send(Command::Device(None));
        let info = self.device_info();
        let _ = self.events.send(Event::Device(info.clone()));
        Ok(info)
    }

    // ── network checks ──────────────────────────────────────────────────

    pub async fn check_ip(&self) -> Result<IpObservation, IpcError> {
        let via_tunnel = self.state.borrow().is_connected();
        let obs = self
            .api
            .check_ip(via_tunnel)
            .await
            .map_err(|e| match e {
                crate::api::ApiError::NotPublic(_) => IpcError::new(IpcErrorKind::Unsupported, e.to_string()),
                _ => IpcError::from_error_kind(ErrorKind::NoInternet, e.to_string()),
            })?;
        let unprotected = {
            let mut cache = self.network_cache.write().expect("network cache");
            let mut o = cache.observations.clone().unwrap_or(IpObservations { unprotected: None, protected: None });
            if via_tunnel {
                o.protected = Some(obs.clone());
            } else {
                o.unprotected = Some(obs.clone());
            }
            cache.observations = Some(o);
            let _ = self.store.save_network(&cache);
            !via_tunnel
        };
        if unprotected {
            let _ = self.machine.send(Command::Location(geo_of(Some(&obs))));
        }
        Ok(obs)
    }

    async fn refresh_unprotected_ip(&self) {
        let stale = self
            .network_cache
            .read()
            .expect("network cache")
            .observations
            .as_ref()
            .and_then(|o| o.unprotected.as_ref())
            .is_none_or(|o| now_millis().saturating_sub(o.observed_at) > 10 * 60 * 1000);
        if stale {
            let _ = self.check_ip().await;
        }
    }

    pub fn ip_observations(&self) -> IpObservations {
        self.network_cache
            .read()
            .expect("network cache")
            .observations
            .clone()
            .unwrap_or(IpObservations { unprotected: None, protected: None })
    }

    pub async fn connection_report(&self) -> ConnectionReport {
        let state = self.state.borrow().clone();
        let stats = *self.stats.borrow();
        let firewall = self.platform.firewall.summary().await;
        let (effective_dns, routes) = match &state {
            TunnelState::Connected { details } => (
                self.platform.dns.effective(&details.interface).await,
                details.interface.luid.map(vpn_platform::routing::routes_on).unwrap_or_default(),
            ),
            _ => (Vec::new(), Vec::new()),
        };
        ConnectionReport { state, stats, firewall, effective_dns, routes }
    }

    /// Resolvers in use right now: the tunnel's when connected, otherwise
    /// the primary network's.
    pub fn active_resolvers(&self) -> Vec<IpAddr> {
        match &*self.state.borrow() {
            TunnelState::Connected { details } => details.dns_servers.clone(),
            _ => self.platform.network.current().primary.map(|p| p.dns_servers).unwrap_or_default(),
        }
    }

    pub async fn test_dns(&self, servers: Option<Vec<IpAddr>>) -> Vec<DnsTestResult> {
        let servers = servers.unwrap_or_else(|| self.active_resolvers());
        let mut out = Vec::new();
        for s in servers.into_iter().take(8) {
            out.push(vpn_platform::dns_probe::query_a(s, &self.cfg.dns_test_name, Duration::from_secs(3)).await);
        }
        out
    }
}

fn geo_of(obs: Option<&IpObservation>) -> Option<GeoPoint> {
    let o = obs?;
    Some(GeoPoint { latitude: o.latitude?, longitude: o.longitude? })
}

/// Executables allowed to reach the API while the kill switch blocks.
/// The desktop app's executable name in the installed layout.
const DESKTOP_APP_EXE: &str = "apexy-app.exe";

fn exceptions(cfg: &ServiceConfig, api_addrs: &[SocketAddr]) -> Vec<AppException> {
    let service_exe = std::env::current_exe().ok();
    let mut apps = allowed_api_clients(service_exe.as_deref(), cfg);
    apps.dedup();
    let mut out = Vec::new();
    for app in &apps {
        for addr in api_addrs.iter().filter(|a| !a.ip().is_loopback()) {
            out.push(AppException { app: app.clone(), remote: *addr });
        }
    }
    out
}

/// Executables that may reach the account API while the kill switch blocks
/// everything else: the service, the desktop app installed next to it (so
/// the user can sign in or renew under "Always on"), and any configured
/// extras. The install directory is writable by administrators only, so a
/// file there can't be planted by the user session.
fn allowed_api_clients(service_exe: Option<&std::path::Path>, cfg: &ServiceConfig) -> Vec<PathBuf> {
    let mut apps: Vec<PathBuf> = service_exe.map(std::path::Path::to_path_buf).into_iter().collect();
    if let Some(app) = service_exe.and_then(std::path::Path::parent).map(|dir| dir.join(DESKTOP_APP_EXE)).filter(|p| p.is_file()) {
        apps.push(app);
    }
    apps.extend(cfg.api_client_apps.iter().cloned());
    apps
}

#[cfg(test)]
mod api_client_tests {
    use super::*;

    #[test]
    fn the_installed_desktop_app_may_reach_the_api_while_blocking() {
        let dir = std::env::temp_dir().join(format!("apexy-install-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let service = dir.join("apexyd.exe");
        assert_eq!(allowed_api_clients(Some(&service), &ServiceConfig::default()), vec![service.clone()], "no app installed next to it");
        std::fs::write(dir.join(DESKTOP_APP_EXE), b"").unwrap();
        assert_eq!(allowed_api_clients(Some(&service), &ServiceConfig::default()), vec![service.clone(), dir.join(DESKTOP_APP_EXE)]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
