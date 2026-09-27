//! Service configuration.
//!
//! Security-relevant settings (which keys may sign the server list, where
//! the API lives) come from the build or from `service.json` in the data
//! directory, which only SYSTEM and Administrators can write. They are
//! never settable over IPC.

use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServiceConfig {
    /// e.g. `https://api.apexyvpn.example`
    pub api_base_url: String,
    /// Relay-list signing keys: `(key id, base64 Ed25519 public key)`.
    pub relay_keys: Vec<RelayKey>,
    /// Development fleets live on private addresses (a WireGuard container
    /// on this machine). Production builds refuse this.
    pub allow_private_relays: bool,
    /// Allow `http://` for the API. Development only.
    pub allow_insecure_api: bool,
    /// Where `wireguard.dll` lives; defaults to the service's directory.
    pub driver_dir: Option<PathBuf>,
    /// Executables allowed to reach the API while the kill switch blocks
    /// everything else (the desktop app). The service itself is always
    /// allowed.
    pub api_client_apps: Vec<PathBuf>,
    /// Name resolved by the DNS test.
    pub dns_test_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayKey {
    pub id: String,
    pub public_key: String,
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
            api_base_url: option_env!("APEXY_API_URL").unwrap_or("https://api.apexyvpn.example").to_string(),
            relay_keys: build_time_relay_keys(),
            allow_private_relays: false,
            allow_insecure_api: false,
            driver_dir: None,
            api_client_apps: Vec::new(),
            dns_test_name: "example.com".into(),
        }
    }
}

/// `APEXY_RELAY_KEYS="fleet-1:BASE64,fleet-2:BASE64"` at build time.
fn build_time_relay_keys() -> Vec<RelayKey> {
    option_env!("APEXY_RELAY_KEYS")
        .unwrap_or("")
        .split(',')
        .filter_map(|pair| {
            let (id, key) = pair.trim().split_once(':')?;
            Some(RelayKey { id: id.to_string(), public_key: key.to_string() })
        })
        .collect()
}

impl ServiceConfig {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let mut cfg = match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice::<ServiceConfig>(&bytes)
                .map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => ServiceConfig::default(),
            Err(e) => return Err(e.into()),
        };
        if cfg.relay_keys.is_empty() {
            cfg.relay_keys = build_time_relay_keys();
        }
        cfg.validate()?;
        Ok(cfg)
    }

    fn validate(&self) -> anyhow::Result<()> {
        let dev_allowed = cfg!(debug_assertions) || cfg!(feature = "dev-fleet");
        if (self.allow_private_relays || self.allow_insecure_api) && !dev_allowed {
            anyhow::bail!("development-only options are not allowed in a release build");
        }
        if !self.api_base_url.starts_with("https://") && !self.allow_insecure_api {
            anyhow::bail!("the API must be reached over https");
        }
        if self.relay_keys.is_empty() {
            tracing::warn!("no relay-list signing keys configured: no server list can be trusted");
        }
        Ok(())
    }

    pub fn driver_dir(&self) -> PathBuf {
        self.driver_dir.clone().unwrap_or_else(|| {
            std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default()
        })
    }
}
