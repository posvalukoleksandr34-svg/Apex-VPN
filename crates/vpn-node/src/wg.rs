//! The node's WireGuard interface.
//!
//! The agent asks `wg` for allowed IPs, handshake times and the interface's
//! public key, one field at a time. It never asks for peer endpoints (where
//! users connect from) or the private key, so neither ever enters this
//! process.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{bail, Context};
use async_trait::async_trait;
use tokio::process::Command;

use crate::peers::{parse_net, valid_key, wg_set_args, Change, Key, PeerMap};

#[async_trait]
pub trait WgBackend: Send + Sync {
    /// The peers on the interface and their allowed IPs.
    async fn peers(&self) -> anyhow::Result<PeerMap>;
    /// Each peer's latest handshake, in Unix seconds (0: never).
    async fn handshakes(&self) -> anyhow::Result<Vec<(Key, u64)>>;
    /// The interface's public key, when there is a real interface.
    async fn public_key(&self) -> anyhow::Result<Option<Key>>;
    async fn apply(&self, changes: &[Change]) -> anyhow::Result<()>;
}

/// Peers per `wg set` invocation: far below any argument-length limit.
const BATCH: usize = 500;
const WG_TIMEOUT: Duration = Duration::from_secs(20);

/// Kernel WireGuard through the `wg` tool.
pub struct WgCli {
    wg: PathBuf,
    interface: String,
}

impl WgCli {
    pub fn new(wg: PathBuf, interface: String) -> Self {
        Self { wg, interface }
    }

    async fn run(&self, args: &[String]) -> anyhow::Result<String> {
        let what = format!("wg {}", args.iter().take(3).map(String::as_str).collect::<Vec<_>>().join(" "));
        let out = tokio::time::timeout(
            WG_TIMEOUT,
            Command::new(&self.wg).args(args).stdin(Stdio::null()).kill_on_drop(true).output(),
        )
        .await
        .with_context(|| format!("{what}: timed out"))?
        .with_context(|| format!("{what}: couldn't run {}", self.wg.display()))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            bail!("{what}: {}", err.lines().next().unwrap_or("failed").chars().take(200).collect::<String>());
        }
        String::from_utf8(out.stdout).with_context(|| format!("{what}: output isn't text"))
    }

    async fn show(&self, field: &str) -> anyhow::Result<String> {
        self.run(&["show".into(), self.interface.clone(), field.into()]).await
    }
}

#[async_trait]
impl WgBackend for WgCli {
    async fn peers(&self) -> anyhow::Result<PeerMap> {
        parse_allowed_ips(&self.show("allowed-ips").await?)
    }

    async fn handshakes(&self) -> anyhow::Result<Vec<(Key, u64)>> {
        parse_handshakes(&self.show("latest-handshakes").await?)
    }

    async fn public_key(&self) -> anyhow::Result<Option<Key>> {
        let key = self.show("public-key").await?.trim().to_owned();
        if !valid_key(&key) {
            bail!("wg show {} public-key: the interface has no key", self.interface);
        }
        Ok(Some(key))
    }

    async fn apply(&self, changes: &[Change]) -> anyhow::Result<()> {
        for batch in changes.chunks(BATCH) {
            self.run(&wg_set_args(&self.interface, batch)).await?;
        }
        Ok(())
    }
}

/// `wg show <if> allowed-ips`: `<key>\t<net> <net>…` or `<key>\t(none)`.
pub fn parse_allowed_ips(out: &str) -> anyhow::Result<PeerMap> {
    let mut map = PeerMap::new();
    for line in out.lines().filter(|l| !l.trim().is_empty()) {
        let (key, ips) = line.split_once('\t').context("unexpected `wg show allowed-ips` output")?;
        if !valid_key(key) {
            bail!("unexpected `wg show allowed-ips` output");
        }
        let ips = match ips.trim() {
            "(none)" => Default::default(),
            ips => ips
                .split_whitespace()
                .map(|s| parse_net(s).context("unexpected address in `wg show allowed-ips` output"))
                .collect::<anyhow::Result<_>>()?,
        };
        map.insert(key.to_owned(), ips);
    }
    Ok(map)
}

/// `wg show <if> latest-handshakes`: `<key>\t<unix seconds>`.
pub fn parse_handshakes(out: &str) -> anyhow::Result<Vec<(Key, u64)>> {
    out.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let (key, at) = line.split_once('\t').context("unexpected `wg show latest-handshakes` output")?;
            let at = at.trim().parse().context("unexpected `wg show latest-handshakes` output")?;
            Ok((key.to_owned(), at))
        })
        .collect()
}

/// Peers held in memory: `--dry-run`, and tests.
#[derive(Default)]
pub struct MemoryBackend {
    state: Mutex<PeerMap>,
    handshakes: Mutex<Vec<(Key, u64)>>,
    fail: Mutex<Option<String>>,
}

impl MemoryBackend {
    pub fn snapshot(&self) -> PeerMap {
        self.state.lock().unwrap().clone()
    }

    pub fn set_handshakes(&self, handshakes: Vec<(Key, u64)>) {
        *self.handshakes.lock().unwrap() = handshakes;
    }

    /// Make every call fail with `error` (`None` to recover).
    pub fn fail_with(&self, error: Option<&str>) {
        *self.fail.lock().unwrap() = error.map(str::to_owned);
    }

    fn check(&self) -> anyhow::Result<()> {
        match &*self.fail.lock().unwrap() {
            Some(e) => bail!("{e}"),
            None => Ok(()),
        }
    }
}

#[async_trait]
impl WgBackend for MemoryBackend {
    async fn peers(&self) -> anyhow::Result<PeerMap> {
        self.check()?;
        Ok(self.snapshot())
    }

    async fn handshakes(&self) -> anyhow::Result<Vec<(Key, u64)>> {
        self.check()?;
        Ok(self.handshakes.lock().unwrap().clone())
    }

    async fn public_key(&self) -> anyhow::Result<Option<Key>> {
        self.check()?;
        Ok(None)
    }

    async fn apply(&self, changes: &[Change]) -> anyhow::Result<()> {
        self.check()?;
        let mut state = self.state.lock().unwrap();
        for change in changes {
            match change {
                Change::Remove(key) => {
                    state.remove(key);
                }
                Change::Set(key, ips) => {
                    // As in WireGuard, an address belongs to one peer: the last to claim it.
                    for other in state.values_mut() {
                        other.retain(|n| !ips.contains(n));
                    }
                    state.insert(key.clone(), ips.clone());
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const K1: &str = "YCnZlTNpLi8MjNVFCtTbrqZjKOzO3hUt91Z8a6MFTjY=";
    const K2: &str = "kSIE5w8bBDtdd+s5oAovlqcqX5FLQ/Km8/ep5CKSl1g=";

    #[test]
    fn parses_allowed_ips() {
        let out = format!("{K1}\t10.64.0.2/32 fc00:bbbb:bbbb:bb01::2/128\n{K2}\t(none)\n");
        let map = parse_allowed_ips(&out).unwrap();
        assert_eq!(map[K1].len(), 2);
        assert!(map[K2].is_empty());
        assert!(parse_allowed_ips("").unwrap().is_empty());
    }

    #[test]
    fn refuses_output_it_doesnt_understand() {
        // e.g. `wg show all …`, which prefixes the interface name
        assert!(parse_allowed_ips(&format!("wg0\t{K1}\t10.64.0.2/32\n")).is_err());
        assert!(parse_allowed_ips(&format!("{K1} 10.64.0.2/32\n")).is_err());
        assert!(parse_allowed_ips(&format!("{K1}\t10.64.0.2/33\n")).is_err());
        assert!(parse_handshakes(&format!("{K1}\tsoon\n")).is_err());
    }

    #[test]
    fn parses_handshakes() {
        let out = format!("{K1}\t1790000000\n{K2}\t0\n");
        assert_eq!(parse_handshakes(&out).unwrap(), vec![(K1.to_owned(), 1_790_000_000), (K2.to_owned(), 0)]);
    }

    #[test]
    fn asks_wg_for_nothing_but_the_fields_it_needs() {
        // The backend only ever runs `wg show <if> <field>` for these fields
        // (never `dump`, `endpoints` or `private-key`) and `wg set`.
        let src = include_str!("wg.rs");
        let shown: Vec<&str> = src.match_indices("self.show(\"").map(|(i, _)| src[i + 11..].split('"').next().unwrap()).collect();
        assert_eq!(shown, ["allowed-ips", "latest-handshakes", "public-key"]);
    }
}
