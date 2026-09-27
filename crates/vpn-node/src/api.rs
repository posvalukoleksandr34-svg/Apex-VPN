//! The node side of the API: `/v1/nodes/self/*`, with the node's token.

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Duration;

use anyhow::{bail, Context};
use async_trait::async_trait;
use reqwest::{StatusCode, Url};
use serde::Serialize;

use crate::peers::{Key, PeerSetDto};

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// The API doesn't accept this node's token: the node was retired, or
    /// its token replaced.
    #[error("the API refused this node's token")]
    Unauthorized,
    #[error("{0}")]
    Unavailable(String),
}

/// What a node tells the API about itself. `active_keys` are keys with a
/// recent handshake: the API keeps them in memory for a few minutes to show
/// users which devices are connected, and stores nothing.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    pub wg_healthy: bool,
    pub active_keys: Vec<Key>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_key: Option<Key>,
}

#[async_trait]
pub trait NodeApi: Send + Sync {
    /// The peer set; with `since`, waits up to `wait_secs` for a different one.
    async fn peers(&self, since: Option<&str>, wait_secs: u32) -> Result<PeerSetDto, ApiError>;
    async fn heartbeat(&self, heartbeat: &Heartbeat) -> Result<(), ApiError>;
}

pub struct HttpApi {
    http: reqwest::Client,
    base: Url,
    token_file: PathBuf,
    token: RwLock<String>,
}

impl HttpApi {
    pub fn new(base: &str, token_file: PathBuf, allow_insecure_http: bool) -> anyhow::Result<Self> {
        let mut base = Url::parse(base).context("--api isn't a URL")?;
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        match base.scheme() {
            "https" => {}
            "http" if allow_insecure_http || is_loopback(&base) => {}
            "http" => bail!("--api must be https (the node token would cross the network in the clear); --allow-insecure-http is for development"),
            other => bail!("--api: unsupported scheme {other}"),
        }
        let token = read_token(&token_file)?;
        let http = reqwest::Client::builder()
            .user_agent(concat!("apexy-node/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            // A redirect never carries the token anywhere.
            .redirect(reqwest::redirect::Policy::none())
            .https_only(base.scheme() == "https")
            .build()?;
        Ok(Self { http, base, token_file, token: RwLock::new(token) })
    }

    pub fn host(&self) -> &str {
        self.base.host_str().unwrap_or("?")
    }

    fn token(&self) -> String {
        self.token.read().unwrap().clone()
    }

    /// After a 401: the token may have been replaced on disk.
    fn reload_token(&self) {
        match read_token(&self.token_file) {
            Ok(token) => *self.token.write().unwrap() = token,
            Err(e) => tracing::warn!("couldn't re-read the node token: {e:#}"),
        }
    }

    fn url(&self, path: &str) -> Url {
        self.base.join(path).expect("a relative path joins")
    }

    fn refused(&self, status: StatusCode) -> ApiError {
        if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
            self.reload_token();
            ApiError::Unauthorized
        } else {
            ApiError::Unavailable(format!("the API answered {status}"))
        }
    }
}

#[async_trait]
impl NodeApi for HttpApi {
    async fn peers(&self, since: Option<&str>, wait_secs: u32) -> Result<PeerSetDto, ApiError> {
        let mut url = self.url("v1/nodes/self/peers");
        if let Some(since) = since {
            url.query_pairs_mut().append_pair("since", since).append_pair("wait", &wait_secs.to_string());
        }
        let res = self
            .http
            .get(url)
            .bearer_auth(self.token())
            .timeout(Duration::from_secs(u64::from(wait_secs) + 20))
            .send()
            .await
            .map_err(unavailable)?;
        if !res.status().is_success() {
            return Err(self.refused(res.status()));
        }
        res.json().await.map_err(unavailable)
    }

    async fn heartbeat(&self, heartbeat: &Heartbeat) -> Result<(), ApiError> {
        let res = self
            .http
            .post(self.url("v1/nodes/self/heartbeat"))
            .bearer_auth(self.token())
            .timeout(Duration::from_secs(20))
            .json(heartbeat)
            .send()
            .await
            .map_err(unavailable)?;
        if !res.status().is_success() {
            return Err(self.refused(res.status()));
        }
        Ok(())
    }
}

fn unavailable(e: reqwest::Error) -> ApiError {
    let kind = if e.is_timeout() {
        "timed out"
    } else if e.is_connect() {
        "couldn't connect"
    } else if e.is_decode() {
        "unexpected answer"
    } else {
        "request failed"
    };
    ApiError::Unavailable(format!("{kind}: {}", e.without_url()))
}

fn is_loopback(url: &Url) -> bool {
    match url.host_str() {
        Some("localhost") => true,
        Some(host) => host.trim_matches(['[', ']']).parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback()),
        None => false,
    }
}

fn read_token(path: &Path) -> anyhow::Result<String> {
    let token = std::fs::read_to_string(path).with_context(|| format!("couldn't read the node token from {}", path.display()))?;
    let token = token.trim().to_owned();
    if token.is_empty() || token.contains(char::is_whitespace) {
        bail!("{} doesn't hold a node token", path.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::metadata(path)?.permissions().mode() & 0o077 != 0 {
            tracing::warn!("{} is readable by other users; it should be 0600 (or passed with systemd's LoadCredential)", path.display());
        }
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token_file(content: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("apexy-node-token-{}-{}", std::process::id(), rand::random::<u32>()));
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn requires_https_except_on_loopback() {
        let t = token_file("tok\n");
        assert!(HttpApi::new("https://api.apexy.example", t.clone(), false).is_ok());
        assert!(HttpApi::new("http://127.0.0.1:8787", t.clone(), false).is_ok());
        assert!(HttpApi::new("http://[::1]:8787", t.clone(), false).is_ok());
        assert!(HttpApi::new("http://localhost:8787", t.clone(), false).is_ok());
        assert!(HttpApi::new("http://api.apexy.example", t.clone(), false).is_err());
        assert!(HttpApi::new("http://10.0.0.5:8787", t.clone(), true).is_ok());
        assert!(HttpApi::new("ftp://api.apexy.example", t.clone(), true).is_err());
        let _ = std::fs::remove_file(t);
    }

    #[test]
    fn builds_urls_under_a_base_path() {
        let t = token_file("tok");
        let api = HttpApi::new("https://apexy.example/api", t.clone(), false).unwrap();
        assert_eq!(api.url("v1/nodes/self/peers").as_str(), "https://apexy.example/api/v1/nodes/self/peers");
        let _ = std::fs::remove_file(t);
    }

    #[test]
    fn reads_a_trimmed_token_and_refuses_an_empty_file() {
        let t = token_file("  tok-123\r\n");
        assert_eq!(read_token(&t).unwrap(), "tok-123");
        std::fs::write(&t, "\n").unwrap();
        assert!(read_token(&t).is_err());
        let _ = std::fs::remove_file(t);
    }

    #[test]
    fn heartbeat_json_matches_the_api() {
        let hb = Heartbeat { wg_healthy: true, active_keys: vec!["k".into()], public_key: None };
        assert_eq!(serde_json::to_string(&hb).unwrap(), r#"{"wgHealthy":true,"activeKeys":["k"]}"#);
    }
}
