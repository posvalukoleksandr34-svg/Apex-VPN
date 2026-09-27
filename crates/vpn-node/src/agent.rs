//! The sync loop: long-poll the peer set, make the interface match it.
//!
//! When the set can't be fetched, the node keeps the last one it had (users
//! stay connected through a short API outage), but only for `max_stale`.
//! After that it can no longer tell who has lost access, so it removes every
//! peer until the API is back. A node whose token is refused removes every
//! peer at once.

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rand::Rng;

use crate::api::{ApiError, Heartbeat, NodeApi};
use crate::peers::{check, diff, Change, PeerMap, PeerSetDto, Pools};
use crate::wg::WgBackend;

/// How long a node waits on the API for a change before asking again. The
/// answer comes at once when something changes; this bounds how stale a
/// node can be without noticing a dead connection.
pub const WAIT_SECS: u32 = 25;
/// Keys with a handshake this recent count as connected.
pub const ACTIVE_SECS: u64 = 180;
const UNAUTHORIZED_RETRY: Duration = Duration::from_secs(30);
const APPLY_RETRY: Duration = Duration::from_secs(2);

/// What the interface should hold, given what the API has (or hasn't) said.
#[derive(Debug)]
pub struct SyncState {
    max_stale: Duration,
    version: Option<String>,
    last_ok: Instant,
    /// `None` until the first peer set: until then the interface is left as it is.
    desired: Option<PeerMap>,
    closed: bool,
}

impl SyncState {
    pub fn new(now: Instant, max_stale: Duration) -> Self {
        Self { max_stale, version: None, last_ok: now, desired: None, closed: false }
    }

    /// The version to wait on: the one the interface holds.
    pub fn since(&self) -> Option<&str> {
        self.version.as_deref()
    }

    pub fn desired(&self) -> Option<&PeerMap> {
        self.desired.as_ref()
    }

    /// Every peer removed because the API refused the node or went quiet
    /// for too long.
    pub fn closed(&self) -> bool {
        self.closed
    }

    pub fn on_fetch(&mut self, fetched: Result<(String, PeerMap), &ApiError>, now: Instant) {
        match fetched {
            Ok((version, peers)) => {
                self.version = Some(version);
                self.last_ok = now;
                self.desired = Some(peers);
                self.closed = false;
            }
            Err(ApiError::Unauthorized) => self.close(),
            Err(ApiError::Unavailable(_)) if now.duration_since(self.last_ok) >= self.max_stale => self.close(),
            Err(ApiError::Unavailable(_)) => {}
        }
    }

    /// Applying the set failed: fetch again without waiting, and apply again.
    pub fn apply_failed(&mut self) {
        self.version = None;
    }

    fn close(&mut self) {
        self.version = None;
        self.desired = Some(PeerMap::new());
        self.closed = true;
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Applied {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
}

impl Applied {
    pub fn changed(&self) -> bool {
        self.added + self.updated + self.removed > 0
    }
}

/// Make the interface hold exactly `desired`. It reads the interface first,
/// so peers added or removed behind the agent's back are put right too.
pub async fn reconcile(wg: &dyn WgBackend, desired: &PeerMap) -> anyhow::Result<Applied> {
    let actual = wg.peers().await?;
    let changes = diff(&actual, desired);
    let mut applied = Applied::default();
    for change in &changes {
        match change {
            Change::Remove(_) => applied.removed += 1,
            Change::Set(key, _) if actual.contains_key(key) => applied.updated += 1,
            Change::Set(..) => applied.added += 1,
        }
    }
    if !changes.is_empty() {
        wg.apply(&changes).await?;
    }
    Ok(applied)
}

struct Backoff(Duration);

impl Backoff {
    const FIRST: Duration = Duration::from_secs(1);
    const MAX: Duration = Duration::from_secs(30);

    fn next(&mut self) -> Duration {
        let d = self.0;
        self.0 = (self.0 * 2).min(Self::MAX);
        d.mul_f64(rand::thread_rng().gen_range(0.8..1.2))
    }

    fn reset(&mut self) {
        self.0 = Self::FIRST;
    }
}

pub struct Syncer {
    api: Arc<dyn NodeApi>,
    wg: Arc<dyn WgBackend>,
    pools: Pools,
    state: SyncState,
    backoff: Backoff,
    wait_secs: u32,
}

impl Syncer {
    pub fn new(api: Arc<dyn NodeApi>, wg: Arc<dyn WgBackend>, pools: Pools, max_stale: Duration) -> Self {
        Self {
            api,
            wg,
            pools,
            state: SyncState::new(Instant::now(), max_stale),
            backoff: Backoff(Backoff::FIRST),
            wait_secs: WAIT_SECS,
        }
    }

    pub fn state(&self) -> &SyncState {
        &self.state
    }

    pub async fn run(mut self) {
        loop {
            if let Some(pause) = self.step().await {
                tokio::time::sleep(pause).await;
            }
        }
    }

    /// One fetch and apply. Returns how long to pause before the next.
    pub async fn step(&mut self) -> Option<Duration> {
        let since = self.state.since().map(str::to_owned);
        let wait = if since.is_some() { self.wait_secs } else { 0 };
        let fetched = self.api.peers(since.as_deref(), wait).await;
        let was_closed = self.state.closed();
        let mut pause = match fetched {
            Ok(set) => {
                let checked = self.checked(set);
                self.state.on_fetch(Ok(checked), Instant::now());
                self.backoff.reset();
                None
            }
            Err(e) => {
                self.state.on_fetch(Err(&e), Instant::now());
                let pause = match e {
                    ApiError::Unauthorized => UNAUTHORIZED_RETRY,
                    ApiError::Unavailable(_) => self.backoff.next(),
                };
                let secs = pause.as_secs();
                match (&e, self.state.closed(), was_closed) {
                    (_, false, _) => tracing::warn!("couldn't fetch the peer set ({e}); keeping the last one, retrying in {secs}s"),
                    (ApiError::Unauthorized, true, false) => tracing::error!("{e}: every peer removed; retrying in {secs}s"),
                    (ApiError::Unavailable(_), true, false) => tracing::error!(
                        "no peer set from the API for {}s ({e}): every peer removed until it answers",
                        self.state.max_stale.as_secs()
                    ),
                    (_, true, true) => tracing::warn!("still no peer set ({e}); retrying in {secs}s"),
                }
                Some(pause)
            }
        };
        if let Some(desired) = self.state.desired() {
            match reconcile(self.wg.as_ref(), desired).await {
                Ok(a) if a.changed() => tracing::info!(added = a.added, updated = a.updated, removed = a.removed, peers = desired.len(), "peers updated"),
                Ok(_) => {}
                Err(e) => {
                    tracing::error!("couldn't update the interface: {e:#}");
                    self.state.apply_failed();
                    pause = Some(pause.unwrap_or(APPLY_RETRY));
                }
            }
        }
        pause
    }

    fn checked(&self, set: PeerSetDto) -> (String, PeerMap) {
        let (peers, rejected) = check(&set.peers, &self.pools);
        if rejected.any() {
            tracing::warn!(
                bad_key = rejected.bad_key,
                bad_address = rejected.bad_address,
                duplicate = rejected.duplicate,
                "the API sent peers this node won't accept; they're left out"
            );
        }
        (set.version, peers)
    }
}

/// What the interface reports about itself. Keys only: never endpoints.
pub async fn heartbeat(wg: &dyn WgBackend, now: SystemTime) -> Heartbeat {
    let now = now.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let public_key = wg.public_key().await;
    let handshakes = wg.handshakes().await;
    let wg_healthy = public_key.is_ok() && handshakes.is_ok();
    let active_keys = handshakes
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, at)| *at > 0 && now.saturating_sub(*at) <= ACTIVE_SECS)
        .map(|(key, _)| key)
        .collect();
    Heartbeat { wg_healthy, active_keys, public_key: public_key.ok().flatten() }
}

pub async fn run_heartbeats(api: Arc<dyn NodeApi>, wg: Arc<dyn WgBackend>, every: Duration) {
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let hb = heartbeat(wg.as_ref(), SystemTime::now()).await;
        if !hb.wg_healthy {
            tracing::warn!("WireGuard interface isn't answering");
        }
        match api.heartbeat(&hb).await {
            Ok(()) => {}
            Err(e) => tracing::warn!("heartbeat failed: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::peers::{parse_net, PeerDto};
    use crate::wg::MemoryBackend;

    const K1: &str = "YCnZlTNpLi8MjNVFCtTbrqZjKOzO3hUt91Z8a6MFTjY=";
    const K2: &str = "kSIE5w8bBDtdd+s5oAovlqcqX5FLQ/Km8/ep5CKSl1g=";
    const STALE: Duration = Duration::from_secs(900);

    fn pools() -> Pools {
        Pools::new(vec!["10.64.0.0/10".parse().unwrap(), "fc00:bbbb:bbbb:bb01::/64".parse().unwrap()])
    }

    fn set(version: &str, peers: &[(&str, &str)]) -> PeerSetDto {
        PeerSetDto {
            version: version.into(),
            peers: peers.iter().map(|(k, ip)| PeerDto { public_key: k.to_string(), allowed_ips: vec![ip.to_string()] }).collect(),
        }
    }

    fn map(peers: &[(&str, &str)]) -> PeerMap {
        peers.iter().map(|(k, ip)| (k.to_string(), [parse_net(ip).unwrap()].into())).collect()
    }

    #[derive(Default)]
    struct FakeApi {
        answers: Mutex<VecDeque<Result<PeerSetDto, ApiError>>>,
        asked: Mutex<Vec<(Option<String>, u32)>>,
        heartbeats: Mutex<Vec<Heartbeat>>,
    }

    impl FakeApi {
        fn answer(&self, a: Result<PeerSetDto, ApiError>) {
            self.answers.lock().unwrap().push_back(a);
        }
    }

    #[async_trait]
    impl NodeApi for FakeApi {
        async fn peers(&self, since: Option<&str>, wait_secs: u32) -> Result<PeerSetDto, ApiError> {
            self.asked.lock().unwrap().push((since.map(str::to_owned), wait_secs));
            self.answers.lock().unwrap().pop_front().expect("an answer was scripted")
        }
        async fn heartbeat(&self, hb: &Heartbeat) -> Result<(), ApiError> {
            self.heartbeats.lock().unwrap().push(hb.clone());
            Ok(())
        }
    }

    fn syncer() -> (Arc<FakeApi>, Arc<MemoryBackend>, Syncer) {
        let api = Arc::new(FakeApi::default());
        let wg = Arc::new(MemoryBackend::default());
        let s = Syncer::new(api.clone(), wg.clone(), pools(), STALE);
        (api, wg, s)
    }

    fn down() -> ApiError {
        ApiError::Unavailable("couldn't connect".into())
    }

    #[tokio::test]
    async fn applies_the_set_and_then_waits_on_its_version() {
        let (api, wg, mut s) = syncer();
        api.answer(Ok(set("v1", &[(K1, "10.64.0.2/32")])));
        assert_eq!(s.step().await, None);
        assert_eq!(wg.snapshot(), map(&[(K1, "10.64.0.2/32")]));

        // A revocation arrives: the peer goes, the new one comes.
        api.answer(Ok(set("v2", &[(K2, "10.64.0.3/32")])));
        s.step().await;
        assert_eq!(wg.snapshot(), map(&[(K2, "10.64.0.3/32")]));
        assert_eq!(*api.asked.lock().unwrap(), [(None, 0), (Some("v1".into()), WAIT_SECS)]);
    }

    #[tokio::test]
    async fn puts_right_changes_made_behind_its_back() {
        let (api, wg, mut s) = syncer();
        api.answer(Ok(set("v1", &[(K1, "10.64.0.2/32")])));
        s.step().await;
        // Someone adds a peer by hand, and the interface loses ours (e.g. restarted).
        wg.apply(&[Change::Remove(K1.into()), Change::Set(K2.into(), [parse_net("10.64.0.9/32").unwrap()].into())]).await.unwrap();
        api.answer(Ok(set("v1", &[(K1, "10.64.0.2/32")]))); // the wait ran out: same version
        s.step().await;
        assert_eq!(wg.snapshot(), map(&[(K1, "10.64.0.2/32")]));
    }

    #[tokio::test]
    async fn keeps_the_last_set_through_a_short_outage() {
        let (api, wg, mut s) = syncer();
        api.answer(Ok(set("v1", &[(K1, "10.64.0.2/32")])));
        s.step().await;
        api.answer(Err(down()));
        let pause = s.step().await.expect("backs off");
        assert!(pause <= Duration::from_millis(1200));
        assert_eq!(wg.snapshot(), map(&[(K1, "10.64.0.2/32")]));
        assert!(!s.state().closed());
        // Nothing before the first set: the interface is left as it is.
        let (api, wg, mut s) = syncer();
        wg.apply(&[Change::Set(K2.into(), [parse_net("10.64.0.3/32").unwrap()].into())]).await.unwrap();
        api.answer(Err(down()));
        s.step().await;
        assert_eq!(wg.snapshot().len(), 1);
    }

    #[test]
    fn fails_closed_once_the_set_is_too_old() {
        let t0 = Instant::now();
        let mut st = SyncState::new(t0, STALE);
        st.on_fetch(Ok(("v1".into(), map(&[(K1, "10.64.0.2/32")]))), t0);
        st.on_fetch(Err(&down()), t0 + STALE - Duration::from_secs(1));
        assert_eq!(st.desired().unwrap().len(), 1);
        assert_eq!(st.since(), Some("v1"));
        st.on_fetch(Err(&down()), t0 + STALE);
        assert!(st.closed());
        assert!(st.desired().unwrap().is_empty());
        assert_eq!(st.since(), None, "asks for the whole set when the API is back");
        // and it's back
        st.on_fetch(Ok(("v2".into(), map(&[(K1, "10.64.0.2/32")]))), t0 + STALE * 2);
        assert!(!st.closed());
        assert_eq!(st.desired().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_refused_token_removes_every_peer_at_once() {
        let (api, wg, mut s) = syncer();
        api.answer(Ok(set("v1", &[(K1, "10.64.0.2/32"), (K2, "10.64.0.3/32")])));
        s.step().await;
        api.answer(Err(ApiError::Unauthorized));
        assert_eq!(s.step().await, Some(UNAUTHORIZED_RETRY));
        assert!(wg.snapshot().is_empty());
        // Still refused, then an outage: stays empty (never back to the old set).
        api.answer(Err(down()));
        s.step().await;
        assert!(wg.snapshot().is_empty());
    }

    #[tokio::test]
    async fn retries_at_once_when_the_interface_refuses_a_change() {
        let (api, wg, mut s) = syncer();
        wg.fail_with(Some("Unable to modify interface"));
        api.answer(Ok(set("v1", &[(K1, "10.64.0.2/32")])));
        assert_eq!(s.step().await, Some(APPLY_RETRY));
        wg.fail_with(None);
        api.answer(Ok(set("v1", &[(K1, "10.64.0.2/32")])));
        s.step().await;
        assert_eq!(wg.snapshot().len(), 1);
        // The retry didn't wait on the version the interface never got.
        assert_eq!(api.asked.lock().unwrap()[1], (None, 0));
    }

    #[tokio::test]
    async fn leaves_out_peers_it_wont_accept() {
        let (api, wg, mut s) = syncer();
        api.answer(Ok(set("v1", &[(K1, "0.0.0.0/0"), (K2, "10.64.0.3/32")])));
        s.step().await;
        assert_eq!(wg.snapshot(), map(&[(K2, "10.64.0.3/32")]));
    }

    #[tokio::test]
    async fn heartbeat_reports_recent_handshakes_only() {
        let wg = MemoryBackend::default();
        let now = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        wg.set_handshakes(vec![(K1.into(), 1_800_000_000 - 30), (K2.into(), 1_800_000_000 - 600), ("k3".into(), 0)]);
        let hb = heartbeat(&wg, now).await;
        assert!(hb.wg_healthy);
        assert_eq!(hb.active_keys, [K1]);
        wg.fail_with(Some("no such device"));
        assert!(!heartbeat(&wg, now).await.wg_healthy);
    }
}
