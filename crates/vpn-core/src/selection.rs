//! Smart Connect: turning a `ConnectTarget` into an ordered list of servers.
//!
//! Inputs are only measured or published facts: this device's own ping
//! results, node-reported load, fleet health, and the approximate location
//! of the last unprotected IP. Where a fact is missing, the ranking uses a
//! neutral value. It never invents a number, and it records what the
//! ranking was based on.

use std::collections::{HashMap, HashSet};
use vpn_types::{
    ConnectTarget, LatencySample, Location, Protocol, ProtocolPreference, RelayList, Server,
    ServerFeature, ServerId, ServerStatus, SmartMode,
};

use crate::geo::{distance_km, GeoPoint};
use crate::protocol::{self, ProtocolChoiceError};

pub struct SelectionInput<'a> {
    pub relays: &'a RelayList,
    pub latencies: &'a HashMap<ServerId, LatencySample>,
    pub location: Option<GeoPoint>,
    pub available_protocols: &'a [Protocol],
    pub preference: ProtocolPreference,
    /// Servers that failed recently in this connect sequence. Skipped
    /// unless nothing else matches.
    pub excluded: &'a HashSet<ServerId>,
    /// Consecutive UDP handshake failures, for protocol fallback.
    pub udp_failures: u32,
    /// Per-device seed spreading equally good choices across servers so
    /// every client doesn't pile onto the same "best" node.
    pub spread_seed: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate<'a> {
    pub server: &'a Server,
    pub location: &'a Location,
    pub protocol: Protocol,
    /// Lower is better. Only meaningful relative to other candidates.
    pub score: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SelectionError {
    #[error("no server matches")]
    NoMatchingServer,
    #[error("server unavailable")]
    ServerUnavailable,
    #[error("protocol unavailable")]
    ProtocolUnavailable,
}

impl From<SelectionError> for vpn_types::ErrorKind {
    fn from(e: SelectionError) -> Self {
        match e {
            SelectionError::NoMatchingServer => Self::NoMatchingServer,
            SelectionError::ServerUnavailable => Self::ServerUnavailable,
            SelectionError::ProtocolUnavailable => Self::ProtocolUnavailable,
        }
    }
}

/// Ordered candidates for `target`, best first.
pub fn candidates<'a>(
    target: &ConnectTarget,
    input: &SelectionInput<'a>,
) -> Result<Vec<Candidate<'a>>, SelectionError> {
    match target {
        ConnectTarget::Server { id } => {
            let server = input.relays.server(id).ok_or(SelectionError::NoMatchingServer)?;
            let location = input.relays.location(&server.location_id).ok_or(SelectionError::NoMatchingServer)?;
            if !server.accepts_connections() {
                return Err(SelectionError::ServerUnavailable);
            }
            let protocol = pick_protocol(server, input).map_err(|_| SelectionError::ProtocolUnavailable)?;
            Ok(vec![Candidate { server, location, protocol, score: 0.0 }])
        }
        ConnectTarget::Smart { mode, country, city, features } => {
            rank(*mode, country.as_deref(), city.as_deref(), features, input)
        }
    }
}

fn pick_protocol(server: &Server, input: &SelectionInput<'_>) -> Result<Protocol, ProtocolChoiceError> {
    protocol::choose(input.preference, server, input.available_protocols, input.udp_failures)
}

fn rank<'a>(
    mode: SmartMode,
    country: Option<&str>,
    city: Option<&str>,
    features: &[ServerFeature],
    input: &SelectionInput<'a>,
) -> Result<Vec<Candidate<'a>>, SelectionError> {
    let mut matched_location = false;
    let mut matched_but_down = false;
    let mut matched_but_no_protocol = false;
    let mut pool: Vec<(Candidate<'a>, bool)> = Vec::new();

    for server in &input.relays.servers {
        let Some(location) = input.relays.location(&server.location_id) else { continue };
        if country.is_some_and(|c| !location.country_code.eq_ignore_ascii_case(c)) {
            continue;
        }
        if city.is_some_and(|c| !location.city.eq_ignore_ascii_case(c)) {
            continue;
        }
        if !features.iter().all(|f| server.features.contains(f)) {
            continue;
        }
        matched_location = true;
        if !server.accepts_connections() {
            matched_but_down = true;
            continue;
        }
        let Ok(protocol) = pick_protocol(server, input) else {
            matched_but_no_protocol = true;
            continue;
        };
        let score = score(mode, server, location, input);
        let excluded = input.excluded.contains(&server.id);
        pool.push((Candidate { server, location, protocol, score }, excluded));
    }

    if pool.is_empty() {
        return Err(if !matched_location {
            SelectionError::NoMatchingServer
        } else if matched_but_no_protocol && !matched_but_down {
            SelectionError::ProtocolUnavailable
        } else {
            SelectionError::ServerUnavailable
        });
    }

    // Recently failed servers go last, not away: if they're all that's left,
    // trying one again beats giving up.
    pool.sort_by(|(a, ax), (b, bx)| {
        ax.cmp(bx)
            .then(a.score.total_cmp(&b.score))
            .then_with(|| a.server.id.cmp(&b.server.id))
    });
    let mut out: Vec<Candidate<'a>> = pool.into_iter().map(|(c, _)| c).collect();
    if mode == SmartMode::BestOverall {
        spread_near_ties(&mut out, input.spread_seed);
    }
    Ok(out)
}

/// Score for one server under `mode`; lower is better.
fn score(mode: SmartMode, server: &Server, location: &Location, input: &SelectionInput<'_>) -> f64 {
    let rtt = input
        .latencies
        .get(&server.id)
        .filter(|s| !s.via_tunnel)
        .and_then(|s| s.rtt_ms);
    let km = input.location.map(|here| {
        distance_km(here, GeoPoint { latitude: location.latitude, longitude: location.longitude })
    });

    let latency_n = match (rtt, km) {
        (Some(ms), _) => norm(ms as f64, 10.0, 300.0),
        // Unmeasured: distance is a reasonable proxy for ranking only.
        (None, Some(km)) => 0.15 + norm(km, 0.0, 12_000.0) * 0.85,
        (None, None) => 0.6,
    };
    let load_n = server.load.map(|l| l as f64 / 100.0).unwrap_or(0.5)
        + if server.status == ServerStatus::Busy { 0.15 } else { 0.0 };
    let distance_n = km.map(|k| norm(k, 0.0, 12_000.0)).unwrap_or(0.5);
    let health_n = server
        .health
        .as_ref()
        .map(|h| {
            h.packet_loss.map(|l| norm(l as f64, 0.0, 10.0)).unwrap_or(0.0)
                + if h.wireguard_healthy == Some(false) { 0.5 } else { 0.0 }
        })
        .unwrap_or(0.1);

    match mode {
        SmartMode::Fastest => match rtt {
            // Measured servers always rank ahead of unmeasured ones.
            Some(ms) => ms as f64,
            None => 100_000.0 + km.unwrap_or(20_000.0),
        },
        SmartMode::Nearest => match km {
            Some(k) => k,
            // No location known: fall back to latency.
            None => rtt.map(|ms| ms as f64 * 100.0).unwrap_or(1e9),
        },
        SmartMode::LowestLoad => load_n * 1000.0 + latency_n,
        SmartMode::BestOverall => 0.45 * latency_n + 0.30 * load_n + 0.15 * distance_n + 0.10 * health_n,
    }
}

fn norm(v: f64, lo: f64, hi: f64) -> f64 {
    ((v - lo) / (hi - lo)).clamp(0.0, 1.0)
}

/// Candidates whose score is within 3% of the best are effectively equal;
/// rotate the front group by a per-device seed so load spreads out.
fn spread_near_ties(out: &mut [Candidate<'_>], seed: u64) {
    let Some(best) = out.first().map(|c| c.score) else { return };
    let group = out.iter().take_while(|c| c.score - best <= 0.03).count();
    if group > 1 {
        out[..group].rotate_left((seed % group as u64) as usize);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::tests::sample_list;

    fn fleet() -> RelayList {
        let mut list = sample_list(1, 10_000);
        let base = list.servers[0].clone();
        list.locations.push(Location {
            id: "us-nyc".into(),
            country_code: "US".into(),
            country: "United States".into(),
            city: "New York".into(),
            latitude: 40.71,
            longitude: -74.0,
        });
        list.locations.push(Location {
            id: "de-ber".into(),
            country_code: "DE".into(),
            country: "Germany".into(),
            city: "Berlin".into(),
            latitude: 52.52,
            longitude: 13.40,
        });
        let mk = |id: &str, loc: &str, load: u8, features: Vec<ServerFeature>| Server {
            id: id.into(),
            hostname: format!("{id}.relays.example.net"),
            location_id: loc.into(),
            load: Some(load),
            features,
            ..base.clone()
        };
        list.servers = vec![
            mk("de-fra-001", "de-fra", 70, vec![ServerFeature::Streaming]),
            mk("de-ber-001", "de-ber", 20, vec![ServerFeature::P2p]),
            mk("us-nyc-001", "us-nyc", 10, vec![ServerFeature::Streaming, ServerFeature::Gaming]),
        ];
        list
    }

    fn lat(pairs: &[(&str, Option<u32>)]) -> HashMap<ServerId, LatencySample> {
        pairs
            .iter()
            .map(|(id, rtt)| {
                (id.to_string(), LatencySample { server_id: id.to_string(), rtt_ms: *rtt, measured_at: 0, via_tunnel: false })
            })
            .collect()
    }

    fn input<'a>(
        relays: &'a RelayList,
        latencies: &'a HashMap<ServerId, LatencySample>,
        excluded: &'a HashSet<ServerId>,
        location: Option<GeoPoint>,
    ) -> SelectionInput<'a> {
        SelectionInput {
            relays,
            latencies,
            location,
            available_protocols: &[Protocol::WireGuard],
            preference: ProtocolPreference::Automatic,
            excluded,
            udp_failures: 0,
            spread_seed: 0,
        }
    }

    const PARIS: GeoPoint = GeoPoint { latitude: 48.85, longitude: 2.35 };

    fn ids(c: &[Candidate<'_>]) -> Vec<String> {
        c.iter().map(|c| c.server.id.clone()).collect()
    }

    #[test]
    fn fastest_uses_measured_latency_first() {
        let relays = fleet();
        let l = lat(&[("de-fra-001", Some(18)), ("us-nyc-001", Some(90))]);
        let ex = HashSet::new();
        let c = candidates(&ConnectTarget::smart(SmartMode::Fastest), &input(&relays, &l, &ex, Some(PARIS))).unwrap();
        assert_eq!(ids(&c), ["de-fra-001", "us-nyc-001", "de-ber-001"]);
    }

    #[test]
    fn nearest_uses_distance() {
        let relays = fleet();
        let l = lat(&[]);
        let ex = HashSet::new();
        let c = candidates(&ConnectTarget::smart(SmartMode::Nearest), &input(&relays, &l, &ex, Some(PARIS))).unwrap();
        assert_eq!(ids(&c), ["de-fra-001", "de-ber-001", "us-nyc-001"]);
    }

    #[test]
    fn lowest_load() {
        let relays = fleet();
        let l = lat(&[]);
        let ex = HashSet::new();
        let c = candidates(&ConnectTarget::smart(SmartMode::LowestLoad), &input(&relays, &l, &ex, None)).unwrap();
        assert_eq!(ids(&c), ["us-nyc-001", "de-ber-001", "de-fra-001"]);
    }

    #[test]
    fn best_overall_balances_latency_and_load() {
        let relays = fleet();
        // Frankfurt is close but loaded; Berlin is close and quiet.
        let l = lat(&[("de-fra-001", Some(15)), ("de-ber-001", Some(22)), ("us-nyc-001", Some(95))]);
        let ex = HashSet::new();
        let c = candidates(&ConnectTarget::smart(SmartMode::BestOverall), &input(&relays, &l, &ex, Some(PARIS))).unwrap();
        assert_eq!(c[0].server.id, "de-ber-001");
        assert_eq!(c.last().unwrap().server.id, "us-nyc-001");
    }

    #[test]
    fn filters_by_country_city_and_features() {
        let relays = fleet();
        let l = lat(&[]);
        let ex = HashSet::new();
        let t = ConnectTarget::Smart {
            mode: SmartMode::BestOverall,
            country: Some("de".into()),
            city: None,
            features: vec![ServerFeature::P2p],
        };
        assert_eq!(ids(&candidates(&t, &input(&relays, &l, &ex, None)).unwrap()), ["de-ber-001"]);

        let t = ConnectTarget::Smart {
            mode: SmartMode::BestOverall,
            country: Some("FR".into()),
            city: None,
            features: vec![],
        };
        assert_eq!(candidates(&t, &input(&relays, &l, &ex, None)), Err(SelectionError::NoMatchingServer));
    }

    #[test]
    fn excluded_servers_go_last_but_are_not_dropped() {
        let relays = fleet();
        let l = lat(&[("de-fra-001", Some(10))]);
        let ex: HashSet<ServerId> = ["de-fra-001".to_string()].into();
        let c = candidates(&ConnectTarget::smart(SmartMode::Fastest), &input(&relays, &l, &ex, None)).unwrap();
        assert_eq!(c.last().unwrap().server.id, "de-fra-001");
        assert_eq!(c.len(), 3);
    }

    #[test]
    fn offline_and_maintenance_are_never_candidates() {
        let mut relays = fleet();
        relays.servers[0].status = ServerStatus::Offline;
        relays.servers[1].status = ServerStatus::Maintenance;
        let l = lat(&[]);
        let ex = HashSet::new();
        let c = candidates(&ConnectTarget::smart(SmartMode::Fastest), &input(&relays, &l, &ex, None)).unwrap();
        assert_eq!(ids(&c), ["us-nyc-001"]);

        let t = ConnectTarget::Server { id: "de-fra-001".into() };
        assert_eq!(candidates(&t, &input(&relays, &l, &ex, None)), Err(SelectionError::ServerUnavailable));
    }

    #[test]
    fn specific_server_without_protocol_is_protocol_unavailable() {
        let relays = fleet();
        let l = lat(&[]);
        let ex = HashSet::new();
        let mut i = input(&relays, &l, &ex, None);
        i.available_protocols = &[];
        let t = ConnectTarget::Server { id: "de-fra-001".into() };
        assert_eq!(candidates(&t, &i), Err(SelectionError::ProtocolUnavailable));
    }

    #[test]
    fn tunnel_measured_latency_is_ignored_for_ranking() {
        let relays = fleet();
        let mut l = lat(&[("us-nyc-001", Some(5))]);
        l.get_mut("us-nyc-001").unwrap().via_tunnel = true;
        let ex = HashSet::new();
        let c = candidates(&ConnectTarget::smart(SmartMode::Fastest), &input(&relays, &l, &ex, Some(PARIS))).unwrap();
        assert_ne!(c[0].server.id, "us-nyc-001");
    }

    #[test]
    fn spread_seed_rotates_only_near_ties() {
        let mut relays = fleet();
        for s in &mut relays.servers {
            s.location_id = "de-fra".into();
            s.load = Some(30);
        }
        let l = lat(&[]);
        let ex = HashSet::new();
        let mut i = input(&relays, &l, &ex, None);
        let a = candidates(&ConnectTarget::smart(SmartMode::BestOverall), &i).unwrap()[0].server.id.clone();
        i.spread_seed = 1;
        let b = candidates(&ConnectTarget::smart(SmartMode::BestOverall), &i).unwrap()[0].server.id.clone();
        assert_ne!(a, b);
    }
}
