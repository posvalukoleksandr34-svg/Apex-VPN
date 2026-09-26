//! On-disk state in the service's private directory. Every write is atomic
//! (write a temp file, then rename over the old one), so a crash or power
//! loss leaves either the old or the new file, never half of one.

use std::path::{Path, PathBuf};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use vpn_core::keys::PrivateKey;
use vpn_platform::SecretStore;
use vpn_types::ipc::IpObservations;
use vpn_types::time::now_millis;
use vpn_types::{ConnectTarget, DeviceRegistration, Settings, SignedRelayList, UnixMillis};

pub struct Store {
    dir: PathBuf,
}

/// The user's intent, so a restarted service picks up where it was.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Intent {
    pub wanted: Option<ConnectTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedRelays {
    pub signed: SignedRelayList,
    pub fetched_at: UnixMillis,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NetworkCache {
    pub observations: Option<IpObservations>,
    /// Last resolved API addresses, for the kill switch exception (DNS is
    /// blocked while the kill switch holds).
    pub api_addrs: Vec<std::net::SocketAddr>,
}

impl NetworkCache {
    /// Older builds stored whatever the IP check answered, including the
    /// loopback address a local development API sees. Never show those as
    /// "your IP".
    pub fn drop_non_public_observations(&mut self) {
        if let Some(o) = &mut self.observations {
            o.unprotected = o.unprotected.take().filter(|x| vpn_core::relay::is_global(x.ip));
            o.protected = o.protected.take().filter(|x| vpn_core::relay::is_global(x.ip));
        }
    }
}

#[derive(Serialize, Deserialize)]
struct SealedKey {
    sealed: String,
    created_at: UnixMillis,
}

pub struct DeviceKey {
    pub key: PrivateKey,
    pub created_at: UnixMillis,
}

/// Settings plus whether they had to be recovered from a corrupt file.
pub struct LoadedSettings {
    pub settings: Settings,
    pub recovered_from: Option<PathBuf>,
}

impl Store {
    pub fn new(dir: &Path) -> Self {
        Self { dir: dir.to_path_buf() }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    pub fn load_settings(&self) -> LoadedSettings {
        let path = self.path("settings.json");
        match std::fs::read(&path) {
            Err(_) => LoadedSettings { settings: Settings::default(), recovered_from: None },
            Ok(bytes) => match vpn_core::settings::load(&bytes) {
                Ok(settings) => LoadedSettings { settings, recovered_from: None },
                Err(e) => {
                    // Keep the broken file for support, start from defaults.
                    let backup = self.path(&format!("settings.corrupt-{}.json", now_millis()));
                    let _ = std::fs::rename(&path, &backup);
                    tracing::error!("settings were unreadable ({e}); reset to defaults, kept {}", backup.display());
                    LoadedSettings { settings: Settings::default(), recovered_from: Some(backup) }
                }
            },
        }
    }

    pub fn save_settings(&self, s: &Settings) -> std::io::Result<()> {
        self.write_json("settings.json", s)
    }

    pub fn load_intent(&self) -> Intent {
        self.read_json("intent.json").unwrap_or_default()
    }

    pub fn save_intent(&self, intent: &Intent) -> std::io::Result<()> {
        self.write_json("intent.json", intent)
    }

    pub fn load_registration(&self) -> Option<DeviceRegistration> {
        self.read_json("device.json")
    }

    pub fn save_registration(&self, r: Option<&DeviceRegistration>) -> std::io::Result<()> {
        match r {
            Some(r) => self.write_json("device.json", r),
            None => remove_if_exists(&self.path("device.json")),
        }
    }

    pub fn load_relays(&self) -> Option<CachedRelays> {
        self.read_json("relays.json")
    }

    pub fn save_relays(&self, r: &CachedRelays) -> std::io::Result<()> {
        self.write_json("relays.json", r)
    }

    pub fn load_network(&self) -> NetworkCache {
        self.read_json("network.json").unwrap_or_default()
    }

    pub fn save_network(&self, n: &NetworkCache) -> std::io::Result<()> {
        self.write_json("network.json", n)
    }

    /// Loads the device key, creating (and sealing) one on first run.
    pub fn device_key(&self, secrets: &dyn SecretStore) -> anyhow::Result<(DeviceKey, bool)> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        if let Some(stored) = self.read_json::<SealedKey>("device.key") {
            let sealed = STANDARD.decode(&stored.sealed)?;
            let plain = secrets.open(&sealed)?;
            let bytes: [u8; 32] = plain[..].try_into().map_err(|_| anyhow::anyhow!("device key has the wrong length"))?;
            return Ok((DeviceKey { key: PrivateKey::from_bytes(bytes), created_at: stored.created_at }, false));
        }
        Ok((self.rotate_device_key(secrets)?, true))
    }

    pub fn rotate_device_key(&self, secrets: &dyn SecretStore) -> anyhow::Result<DeviceKey> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let key = PrivateKey::generate();
        let sealed = secrets.seal(key.as_bytes())?;
        let created_at = now_millis();
        self.write_json("device.key", &SealedKey { sealed: STANDARD.encode(sealed), created_at })?;
        Ok(DeviceKey { key, created_at })
    }

    fn read_json<T: DeserializeOwned>(&self, name: &str) -> Option<T> {
        let bytes = std::fs::read(self.path(name)).ok()?;
        match serde_json::from_slice(&bytes) {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::warn!("ignoring unreadable {name}: {e}");
                None
            }
        }
    }

    fn write_json<T: Serialize>(&self, name: &str, value: &T) -> std::io::Result<()> {
        let path = self.path(name);
        let tmp = self.path(&format!("{name}.tmp"));
        let bytes = serde_json::to_vec_pretty(value).expect("state serializes");
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(&bytes)?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, &path)
    }
}

fn remove_if_exists(p: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vpn_types::KillSwitchMode;

    #[test]
    fn loopback_ip_observations_are_not_kept() {
        let obs = |ip: &str, via_tunnel| vpn_types::IpObservation {
            ip: ip.parse().unwrap(),
            country_code: None,
            country: None,
            city: None,
            timezone: None,
            asn: None,
            organization: None,
            latitude: None,
            longitude: None,
            observed_at: 1,
            via_tunnel,
        };
        let mut cache = NetworkCache {
            observations: Some(IpObservations { unprotected: Some(obs("127.0.0.1", false)), protected: Some(obs("163.172.161.0", true)) }),
            api_addrs: vec![],
        };
        cache.drop_non_public_observations();
        let o = cache.observations.unwrap();
        assert!(o.unprotected.is_none());
        assert_eq!(o.protected.unwrap().ip.to_string(), "163.172.161.0");
    }

    #[test]
    fn settings_roundtrip_and_corruption_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        assert_eq!(store.load_settings().settings, Settings::default());

        let s = Settings { kill_switch: KillSwitchMode::AlwaysOn, ..Settings::default() };
        store.save_settings(&s).unwrap();
        assert_eq!(store.load_settings().settings, s);

        std::fs::write(dir.path().join("settings.json"), b"{ half a file").unwrap();
        let loaded = store.load_settings();
        assert_eq!(loaded.settings, Settings::default());
        let backup = loaded.recovered_from.expect("recovered");
        assert!(backup.exists(), "the corrupt file is kept for support");
        assert!(!dir.path().join("settings.json").exists());
    }

    #[test]
    fn intent_and_registration() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        assert!(store.load_intent().wanted.is_none());
        store.save_intent(&Intent { wanted: Some(ConnectTarget::Server { id: "x".into() }) }).unwrap();
        assert!(store.load_intent().wanted.is_some());
        store.save_registration(None).unwrap();
        assert!(store.load_registration().is_none());
    }
}
