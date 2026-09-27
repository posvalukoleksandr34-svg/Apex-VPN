//! The peer set a node must hold: checked on arrival, then turned into the
//! changes that get the interface there.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::net::IpAddr;

use base64::Engine;
use ipnet::IpNet;
use serde::Deserialize;

/// A WireGuard public key, base64 as `wg` prints it.
pub type Key = String;
/// Public key → the tunnel addresses it may use.
pub type PeerMap = BTreeMap<Key, BTreeSet<IpNet>>;

/// `GET /v1/nodes/self/peers`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerSetDto {
    pub version: String,
    pub peers: Vec<PeerDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerDto {
    pub public_key: String,
    pub allowed_ips: Vec<String>,
}

/// The tunnel address pools devices are numbered from. A peer may only
/// claim single addresses inside them: an entry like `0.0.0.0/0` would route
/// every client's return traffic to one peer, so the node refuses it
/// whatever the API says.
#[derive(Debug, Clone)]
pub struct Pools(Vec<IpNet>);

impl Pools {
    pub fn new(pools: Vec<IpNet>) -> Self {
        Self(pools.into_iter().map(|p| p.trunc()).collect())
    }

    pub fn admits(&self, net: &IpNet) -> bool {
        if net.prefix_len() != net.max_prefix_len() {
            return false;
        }
        let addr = net.addr();
        self.0.iter().any(|pool| {
            pool.contains(&addr)
                // the pool's network address and first host (the node's gateway) are never a device's
                && addr != pool.network()
                && Some(addr) != first_host(pool)
                && !matches!(pool, IpNet::V4(p) if IpAddr::V4(p.broadcast()) == addr)
        })
    }
}

fn first_host(pool: &IpNet) -> Option<IpAddr> {
    match pool.network() {
        IpAddr::V4(a) => u32::from(a).checked_add(1).map(|n| IpAddr::V4(n.into())),
        IpAddr::V6(a) => u128::from(a).checked_add(1).map(|n| IpAddr::V6(n.into())),
    }
}

/// Entries the node refused, by reason. Counts only: keys aren't logged.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Rejected {
    pub bad_key: usize,
    pub bad_address: usize,
    pub duplicate: usize,
}

impl Rejected {
    pub fn any(&self) -> bool {
        self.bad_key + self.bad_address + self.duplicate > 0
    }
}

pub fn valid_key(key: &str) -> bool {
    key.len() == 44
        && base64::engine::general_purpose::STANDARD
            .decode(key)
            .is_ok_and(|k| k.len() == 32)
}

/// The peers from the API that this node will accept. A peer with any
/// address it can't accept is left out whole; a key or address that appears
/// twice is kept the first time only.
pub fn check(peers: &[PeerDto], pools: &Pools) -> (PeerMap, Rejected) {
    let mut out = PeerMap::new();
    let mut rejected = Rejected::default();
    let mut taken: HashSet<IpAddr> = HashSet::new();
    for peer in peers {
        if !valid_key(&peer.public_key) {
            rejected.bad_key += 1;
            continue;
        }
        let ips: Option<BTreeSet<IpNet>> = peer.allowed_ips.iter().map(|s| parse_net(s).filter(|n| pools.admits(n))).collect();
        let Some(ips) = ips.filter(|ips| !ips.is_empty()) else {
            rejected.bad_address += 1;
            continue;
        };
        if out.contains_key(&peer.public_key) || ips.iter().any(|n| taken.contains(&n.addr())) {
            rejected.duplicate += 1;
            continue;
        }
        taken.extend(ips.iter().map(|n| n.addr()));
        out.insert(peer.public_key.clone(), ips);
    }
    (out, rejected)
}

/// `10.64.0.2/32`, or a bare address as a single host.
pub fn parse_net(s: &str) -> Option<IpNet> {
    s.parse::<IpNet>().ok().or_else(|| s.parse::<IpAddr>().ok().map(IpNet::from)).map(|n| n.trunc())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    /// Drop the peer: its sessions end at once.
    Remove(Key),
    /// Add the peer, or replace its allowed IPs.
    Set(Key, BTreeSet<IpNet>),
}

/// The changes that turn `actual` into `desired`, removals first, so that an
/// address moving to a new key (a key rotation) is released before it's
/// claimed again.
pub fn diff(actual: &PeerMap, desired: &PeerMap) -> Vec<Change> {
    let removals = actual.keys().filter(|k| !desired.contains_key(*k)).map(|k| Change::Remove(k.clone()));
    let sets = desired
        .iter()
        .filter(|(k, ips)| actual.get(*k) != Some(ips))
        .map(|(k, ips)| Change::Set(k.clone(), ips.clone()));
    removals.chain(sets).collect()
}

/// `wg set` arguments for a batch of changes (one invocation takes many
/// `peer` clauses).
pub fn wg_set_args(interface: &str, changes: &[Change]) -> Vec<String> {
    let mut args = vec!["set".to_owned(), interface.to_owned()];
    for change in changes {
        match change {
            Change::Remove(key) => args.extend(["peer".to_owned(), key.clone(), "remove".to_owned()]),
            Change::Set(key, ips) => {
                let ips = ips.iter().map(ToString::to_string).collect::<Vec<_>>().join(",");
                args.extend(["peer".to_owned(), key.clone(), "allowed-ips".to_owned(), ips]);
            }
        }
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    const K1: &str = "YCnZlTNpLi8MjNVFCtTbrqZjKOzO3hUt91Z8a6MFTjY=";
    const K2: &str = "kSIE5w8bBDtdd+s5oAovlqcqX5FLQ/Km8/ep5CKSl1g=";
    const K3: &str = "HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=";

    fn pools() -> Pools {
        Pools::new(vec!["10.64.0.0/10".parse().unwrap(), "fc00:bbbb:bbbb:bb01::/64".parse().unwrap()])
    }

    fn peer(key: &str, ips: &[&str]) -> PeerDto {
        PeerDto { public_key: key.into(), allowed_ips: ips.iter().map(|s| s.to_string()).collect() }
    }

    fn map(entries: &[(&str, &[&str])]) -> PeerMap {
        entries.iter().map(|(k, ips)| (k.to_string(), ips.iter().map(|s| parse_net(s).unwrap()).collect())).collect()
    }

    #[test]
    fn accepts_single_addresses_inside_the_pools() {
        let (m, r) = check(&[peer(K1, &["10.64.0.2/32", "fc00:bbbb:bbbb:bb01::2/128"]), peer(K2, &["10.127.255.254"])], &pools());
        assert_eq!(r, Rejected::default());
        assert_eq!(m.len(), 2);
    }

    #[test]
    fn refuses_routes_and_addresses_outside_the_pools() {
        for ips in [
            &["0.0.0.0/0"][..],
            &["10.64.0.0/24"],
            &["::/0"],
            &["192.168.1.5/32"],
            &["10.128.0.2/32"],
            &["10.64.0.1/32"], // the gateway
            &["10.64.0.0/32"],
            &["10.127.255.255/32"],
            &["fc00:bbbb:bbbb:bb01::1/128"],
            &["10.64.0.2/32", "0.0.0.0/0"], // one bad entry sinks the peer
            &[],
            &["not an address"],
        ] {
            let (m, r) = check(&[peer(K1, ips)], &pools());
            assert!(m.is_empty(), "{ips:?} was accepted");
            assert_eq!(r.bad_address, 1);
        }
    }

    #[test]
    fn refuses_malformed_keys_and_duplicates() {
        let (m, r) = check(
            &[
                peer("short", &["10.64.0.2/32"]),
                peer("YCnZlTNpLi8MjNVFCtTbrqZjKOzO3hUt91Z8a6MFTj==", &["10.64.0.2/32"]),
                peer(K1, &["10.64.0.2/32"]),
                peer(K1, &["10.64.0.3/32"]),
                peer(K2, &["10.64.0.2/32"]),
            ],
            &pools(),
        );
        assert_eq!(r, Rejected { bad_key: 2, bad_address: 0, duplicate: 2 });
        assert_eq!(m, map(&[(K1, &["10.64.0.2/32"])]));
    }

    #[test]
    fn normalises_ipv6_spelling() {
        // The API may spell an address differently from `wg`; both mean the same host.
        let (m, _) = check(&[peer(K1, &["fc00:bbbb:bbbb:bb01:0:0:0:2/128"])], &pools());
        let actual = map(&[(K1, &["fc00:bbbb:bbbb:bb01::2/128"])]);
        assert!(diff(&actual, &m).is_empty());
    }

    #[test]
    fn diff_removes_first_and_skips_unchanged_peers() {
        let actual = map(&[(K1, &["10.64.0.2/32"]), (K2, &["10.64.0.3/32"]), (K3, &[])]);
        let desired = map(&[(K1, &["10.64.0.2/32"]), (K3, &["10.64.0.3/32"])]);
        assert_eq!(
            diff(&actual, &desired),
            vec![Change::Remove(K2.into()), Change::Set(K3.into(), desired[K3].clone())]
        );
        assert!(diff(&desired, &desired).is_empty());
        assert_eq!(diff(&actual, &PeerMap::new()).len(), 3);
    }

    #[test]
    fn set_args_batch_several_peers() {
        let changes = vec![
            Change::Remove(K2.into()),
            Change::Set(K1.into(), map(&[(K1, &["10.64.0.2/32", "fc00:bbbb:bbbb:bb01::2/128"])])[K1].clone()),
        ];
        assert_eq!(
            wg_set_args("wg0", &changes),
            ["set", "wg0", "peer", K2, "remove", "peer", K1, "allowed-ips", "10.64.0.2/32,fc00:bbbb:bbbb:bb01::2/128"]
        );
    }
}
