//! The account session, kept out of the WebView.
//!
//! * The refresh token (and the last known user, for offline starts) live in
//!   the OS credential store; the short-lived access token only in memory.
//! * Refreshes are serialized: the backend rotates refresh tokens and revokes
//!   the whole family when one is reused, so two concurrent refreshes would
//!   sign the user out.
//! * The WebView gets narrow commands and a checked `/v1/...` passthrough
//!   that can't reach the token endpoints.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use vpn_types::ipc::Request;
use vpn_types::{DeviceInfo, DeviceRegistration};

use crate::desktop::DesktopState;
use crate::error::{CoreError, CoreResult};
use crate::service::ServiceBridge;

pub const SESSION_EVENT: &str = "account://session";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub email: String,
    pub email_verified: bool,
    pub locale: String,
    pub mfa_enabled: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LoginResult {
    SignedIn { user: User },
    MfaRequired,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
    user: User,
}

/// What survives a restart (credential store).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    refresh_token: String,
    user: User,
}

struct Access {
    token: String,
    expires: Instant,
}

#[derive(Default)]
struct Session {
    loaded: bool,
    stored: Option<Stored>,
    access: Option<Access>,
}

pub struct AccountManager {
    app: AppHandle,
    bridge: Arc<ServiceBridge>,
    http: reqwest::Client,
    session: tokio::sync::Mutex<Session>,
    /// Between the password step and the TOTP step of a sign-in.
    mfa_token: Mutex<Option<String>>,
}

impl AccountManager {
    pub fn new(app: AppHandle, bridge: Arc<ServiceBridge>) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(format!("Meridian/{}", app.package_info().version))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .expect("http client");
        Self { app, bridge, http, session: Default::default(), mfa_token: Mutex::new(None) }
    }

    fn base(&self) -> CoreResult<String> {
        self.bridge
            .api_base_url()
            .ok_or_else(|| CoreError::network("the account service address isn't known yet: the VPN service hasn't been reached"))
    }

    fn emit_session(&self, user: Option<&User>) {
        let _ = self.app.emit(SESSION_EVENT, user);
    }

    async fn load(&self, s: &mut Session) {
        if !s.loaded {
            s.stored = keychain::load().await;
            s.loaded = true;
        }
    }

    async fn adopt(&self, s: &mut Session, t: Tokens) {
        s.access = Some(Access { token: t.access_token, expires: Instant::now() + Duration::from_secs(t.expires_in) });
        let stored = Stored { refresh_token: t.refresh_token, user: t.user };
        if let Err(e) = keychain::save(&stored).await {
            // Still signed in for this run; the next start asks to sign in again.
            tracing::warn!("could not save the session to the credential store: {e}");
        }
        s.loaded = true;
        s.stored = Some(stored);
    }

    async fn forget(&self, s: &mut Session) {
        let had = s.stored.is_some();
        s.stored = None;
        s.access = None;
        keychain::clear().await;
        if had {
            self.emit_session(None);
        }
    }

    /// A valid access token, refreshing (once, serialized) when needed.
    async fn access_token(&self) -> CoreResult<String> {
        let mut s = self.session.lock().await;
        self.load(&mut s).await;
        if let Some(a) = &s.access {
            if a.expires > Instant::now() + Duration::from_secs(30) {
                return Ok(a.token.clone());
            }
        }
        let refresh_token = s.stored.as_ref().ok_or_else(CoreError::not_signed_in)?.refresh_token.clone();
        let res = self
            .http
            .post(format!("{}/v1/auth/refresh", self.base()?))
            .json(&json!({ "refreshToken": refresh_token }))
            .send()
            .await
            .map_err(CoreError::network)?;
        match decode(res).await {
            Ok(v) => {
                let tokens: Tokens = serde_json::from_value(v).map_err(CoreError::bad_reply)?;
                let user_changed = s.stored.as_ref().map(|x| &x.user) != Some(&tokens.user);
                let user = tokens.user.clone();
                self.adopt(&mut s, tokens).await;
                if user_changed {
                    self.emit_session(Some(&user));
                }
                Ok(s.access.as_ref().expect("just set").token.clone())
            }
            Err(e) if e.is_unauthorized() => {
                // Expired, revoked, or reused elsewhere: the session is over.
                self.forget(&mut s).await;
                Err(e)
            }
            Err(e) => Err(e),
        }
    }

    /// Sends an authenticated request, refreshing and retrying once on 401.
    async fn authorized(&self, build: impl Fn(&reqwest::Client, &str, &str) -> CoreResult<reqwest::RequestBuilder>) -> CoreResult<Value> {
        let base = self.base()?;
        let mut retried = false;
        loop {
            let token = self.access_token().await?;
            let res = build(&self.http, &base, &token)?.send().await.map_err(CoreError::network)?;
            if res.status() != StatusCode::UNAUTHORIZED {
                return decode(res).await;
            }
            let mut s = self.session.lock().await;
            if retried {
                // A fresh token was refused too: treat the session as gone.
                self.forget(&mut s).await;
                return decode(res).await;
            }
            s.access = None;
            retried = true;
        }
    }

    async fn post_public(&self, path: &str, body: Value) -> CoreResult<Value> {
        let res = self.http.post(format!("{}{path}", self.base()?)).json(&body).send().await.map_err(CoreError::network)?;
        decode(res).await
    }

    async fn sign_in(&self, v: Value) -> CoreResult<User> {
        let tokens: Tokens = serde_json::from_value(v).map_err(CoreError::bad_reply)?;
        let user = tokens.user.clone();
        {
            let mut s = self.session.lock().await;
            self.adopt(&mut s, tokens).await;
        }
        self.emit_session(Some(&user));
        Ok(user)
    }

    pub async fn session(&self) -> CoreResult<Option<User>> {
        let cached = {
            let mut s = self.session.lock().await;
            self.load(&mut s).await;
            s.stored.as_ref().map(|x| x.user.clone())
        };
        let Some(cached) = cached else { return Ok(None) };
        match self.authorized(|http, base, token| Ok(http.get(format!("{base}/v1/users/me")).bearer_auth(token))).await {
            Ok(v) => {
                let user: User = serde_json::from_value(v).map_err(CoreError::bad_reply)?;
                let mut s = self.session.lock().await;
                if let Some(stored) = s.stored.as_mut().filter(|st| st.user != user) {
                    stored.user = user.clone();
                    let _ = keychain::save(stored).await;
                }
                Ok(Some(user))
            }
            Err(e) if e.is_unauthorized() => Ok(None),
            // Offline: still signed in, the UI shows cached account data.
            Err(e) if e.is_network() => Ok(Some(cached)),
            Err(e) => Err(e),
        }
    }

    pub async fn login(&self, email: String, password: String) -> CoreResult<LoginResult> {
        let v = self.post_public("/v1/auth/login", json!({ "email": email, "password": password, "device": device_hint() })).await?;
        if v.get("mfaRequired").and_then(Value::as_bool) == Some(true) {
            let token = v.get("mfaToken").and_then(Value::as_str).ok_or_else(|| CoreError::bad_reply("missing mfaToken"))?;
            *self.mfa_token.lock().expect("mfa") = Some(token.to_owned());
            return Ok(LoginResult::MfaRequired);
        }
        Ok(LoginResult::SignedIn { user: self.sign_in(v).await? })
    }

    pub async fn login_mfa(&self, input: MfaInput) -> CoreResult<User> {
        let token = self.mfa_token.lock().expect("mfa").clone().ok_or_else(|| CoreError::api("mfa_token_invalid", 401, "start signing in again"))?;
        let mut body = json!({ "mfaToken": token, "device": device_hint() });
        match (input.code, input.recovery_code) {
            (Some(code), None) => body["code"] = json!(code.trim()),
            (None, Some(code)) => body["recoveryCode"] = json!(code.trim()),
            _ => return Err(CoreError::api("invalid_request", 400, "send exactly one of code or recoveryCode")),
        }
        match self.post_public("/v1/auth/login/mfa", body).await {
            Ok(v) => {
                *self.mfa_token.lock().expect("mfa") = None;
                self.sign_in(v).await
            }
            Err(e) => {
                if e.code() == "mfa_token_invalid" {
                    *self.mfa_token.lock().expect("mfa") = None;
                }
                Err(e)
            }
        }
    }

    pub async fn logout(&self) {
        let mut s = self.session.lock().await;
        self.load(&mut s).await;
        if let (Some(stored), Ok(base)) = (&s.stored, self.base()) {
            // Best effort: the session ends locally either way.
            let _ = self.http.post(format!("{base}/v1/auth/logout")).json(&json!({ "refreshToken": stored.refresh_token })).send().await;
        }
        self.forget(&mut s).await;
        *self.mfa_token.lock().expect("mfa") = None;
    }

    pub async fn request(&self, method: &str, path: &str, body: Option<Value>) -> CoreResult<Value> {
        let method = match method {
            "GET" => Method::GET,
            "POST" => Method::POST,
            "PUT" => Method::PUT,
            "PATCH" => Method::PATCH,
            "DELETE" => Method::DELETE,
            other => return Err(CoreError::rejected(format!("method not allowed: {other}"))),
        };
        check_path(path)?;
        let deleting_account = method == Method::DELETE && path == "/v1/users/me";
        let v = self
            .authorized(|http, base, token| {
                let mut rb = http.request(method.clone(), format!("{base}{path}")).bearer_auth(token);
                if let Some(b) = &body {
                    rb = rb.json(b);
                }
                Ok(rb)
            })
            .await?;
        if deleting_account {
            let mut s = self.session.lock().await;
            self.forget(&mut s).await;
        }
        Ok(v)
    }

    /// Registers the service's public key with the account and hands the
    /// resulting registration to the service. Idempotent per key.
    pub async fn enroll_device(&self) -> CoreResult<DeviceRegistration> {
        let client = self.bridge.client().ok_or_else(CoreError::service_unavailable)?;
        let device: DeviceInfo = client.call(Request::GetDevice).await?;
        let (name, platform) = device_name_and_platform();
        let body = json!({ "name": name, "platform": platform, "appVersion": self.app.package_info().version.to_string(), "publicKey": device.public_key });
        let v = self.authorized(|http, base, token| Ok(http.post(format!("{base}/v1/devices")).bearer_auth(token).json(&body))).await?;
        let registration: DeviceRegistration =
            serde_json::from_value(v.get("registration").cloned().unwrap_or(Value::Null)).map_err(CoreError::bad_reply)?;
        client.call::<DeviceInfo>(Request::SetDeviceRegistration { registration: registration.clone() }).await?;
        Ok(registration)
    }

    pub async fn create_ticket(&self, input: TicketInput) -> CoreResult<Value> {
        let desktop = self.app.state::<DesktopState>();
        let mut files = Vec::with_capacity(input.attachment_paths.len());
        if input.attachment_paths.len() > MAX_ATTACHMENTS {
            return Err(CoreError::rejected("too many attachments"));
        }
        for path in &input.attachment_paths {
            let path = PathBuf::from(path);
            // Only files the user picked in the file dialog; page script
            // can't name arbitrary files to upload.
            if !desktop.was_picked(&path) {
                return Err(CoreError::rejected("attachments must be chosen with the file picker"));
            }
            let mime = attachment_type(&path).ok_or_else(|| CoreError::api("attachment_type_not_allowed", 400, "unsupported file type"))?;
            let data = tokio::fs::read(&path).await.map_err(|e| CoreError::internal(format!("could not read {}: {e}", path.display())))?;
            if data.len() > MAX_ATTACHMENT_BYTES {
                return Err(CoreError::api("attachment_too_large", 400, "attachments are limited to 10 MB"));
            }
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("attachment").to_owned();
            files.push((name, mime, data));
        }

        let report_id = match input.diagnostic_report {
            Some(report) if report.is_object() => {
                let os = vpn_platform::os::info();
                let body = json!({
                    "appVersion": self.app.package_info().version.to_string(),
                    "os": format!("{:?} {} {}", os.family, os.version, os.arch),
                    "report": report,
                });
                let v = self
                    .authorized(|http, base, token| Ok(http.post(format!("{base}/v1/diagnostics/reports")).bearer_auth(token).json(&body)))
                    .await?;
                Some(v.get("id").and_then(Value::as_str).ok_or_else(|| CoreError::bad_reply("missing report id"))?.to_owned())
            }
            Some(_) => return Err(CoreError::rejected("the diagnostic report must be an object")),
            None => None,
        };

        self.authorized(|http, base, token| {
            let mut form = reqwest::multipart::Form::new()
                .text("subject", input.subject.clone())
                .text("category", input.category.clone())
                .text("description", input.description.clone());
            if let Some(id) = &report_id {
                form = form.text("diagnosticReportId", id.clone());
            }
            for (name, mime, data) in &files {
                let part = reqwest::multipart::Part::bytes(data.clone()).file_name(name.clone()).mime_str(mime).map_err(|e| CoreError::internal(e.to_string()))?;
                form = form.part("attachments", part);
            }
            Ok(http.post(format!("{base}/v1/support/tickets")).bearer_auth(token).multipart(form))
        })
        .await
    }
}

const MAX_ATTACHMENTS: usize = 5;
const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MfaInput {
    code: Option<String>,
    recovery_code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketInput {
    subject: String,
    category: String,
    description: String,
    #[serde(default)]
    attachment_paths: Vec<String>,
    diagnostic_report: Option<Value>,
}

/// Paths the WebView may call through `account_request`.
fn check_path(path: &str) -> CoreResult<()> {
    let ok = path.starts_with("/v1/")
        // Token endpoints answer with tokens; they only go through the commands above.
        && !path.starts_with("/v1/auth/")
        && !path.contains("..")
        && !path.contains("//")
        && !path.contains('#')
        && path.bytes().all(|b| b.is_ascii_graphic());
    if ok {
        Ok(())
    } else {
        Err(CoreError::rejected(format!("path not allowed: {path}")))
    }
}

fn attachment_type(path: &std::path::Path) -> Option<&'static str> {
    Some(match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "txt" | "log" => "text/plain",
        "json" => "application/json",
        "zip" => "application/zip",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

fn device_name_and_platform() -> (String, &'static str) {
    let name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|n| n.chars().take(64).collect::<String>())
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "This computer".into());
    let platform = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        "linux" => "linux",
        _ => "other",
    };
    (name, platform)
}

fn device_hint() -> Value {
    let (name, platform) = device_name_and_platform();
    json!({ "name": name, "platform": platform })
}

#[derive(Deserialize)]
struct ApiErrorBody {
    error: ApiErrorInner,
}

#[derive(Deserialize)]
struct ApiErrorInner {
    code: String,
    #[serde(default)]
    message: String,
}

async fn decode(res: reqwest::Response) -> CoreResult<Value> {
    let status = res.status();
    let text = res.text().await.map_err(CoreError::network)?;
    if status.is_success() {
        return Ok(if text.is_empty() { Value::Null } else { serde_json::from_str(&text).map_err(CoreError::bad_reply)? });
    }
    Err(match serde_json::from_str::<ApiErrorBody>(&text) {
        Ok(body) => CoreError::api(body.error.code, status.as_u16(), body.error.message),
        Err(_) => CoreError::api(if status.as_u16() == 401 { "session_revoked" } else { "generic" }, status.as_u16(), status.to_string()),
    })
}

mod keychain {
    //! One credential-store entry holds the refresh token and the cached user.
    use super::Stored;

    const SERVICE: &str = "Meridian";
    const ENTRY: &str = "account-session";

    fn entry() -> keyring::Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, ENTRY)
    }

    pub async fn load() -> Option<Stored> {
        tokio::task::spawn_blocking(|| match entry().and_then(|e| e.get_password()) {
            Ok(raw) => serde_json::from_str(&raw).ok(),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => {
                tracing::warn!("could not read the saved session: {e}");
                None
            }
        })
        .await
        .ok()
        .flatten()
    }

    pub async fn save(stored: &Stored) -> Result<(), String> {
        let raw = serde_json::to_string(stored).map_err(|e| e.to_string())?;
        tokio::task::spawn_blocking(move || entry().and_then(|e| e.set_password(&raw)).map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())?
    }

    pub async fn clear() {
        let _ = tokio::task::spawn_blocking(|| match entry().and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => tracing::warn!("could not remove the saved session: {e}"),
        })
        .await;
    }
}

type Account<'a> = State<'a, Arc<AccountManager>>;

#[tauri::command]
pub async fn account_session(account: Account<'_>) -> CoreResult<Option<User>> {
    account.session().await
}

#[tauri::command]
pub async fn account_register(account: Account<'_>, email: String, password: String, locale: String) -> CoreResult<()> {
    account.post_public("/v1/auth/register", json!({ "email": email, "password": password, "locale": locale })).await.map(drop)
}

#[tauri::command]
pub async fn account_verify_email(account: Account<'_>, email: String, code: String) -> CoreResult<()> {
    account.post_public("/v1/auth/verify-email", json!({ "email": email, "code": code.trim() })).await.map(drop)
}

#[tauri::command]
pub async fn account_resend_verification(account: Account<'_>, email: String) -> CoreResult<()> {
    account.post_public("/v1/auth/resend-verification", json!({ "email": email })).await.map(drop)
}

#[tauri::command]
pub async fn account_login(account: Account<'_>, email: String, password: String) -> CoreResult<LoginResult> {
    account.login(email, password).await
}

#[tauri::command]
pub async fn account_login_mfa(account: Account<'_>, input: MfaInput) -> CoreResult<User> {
    account.login_mfa(input).await
}

#[tauri::command]
pub async fn account_logout(account: Account<'_>) -> CoreResult<()> {
    account.logout().await;
    Ok(())
}

#[tauri::command]
pub async fn account_forgot_password(account: Account<'_>, email: String) -> CoreResult<()> {
    account.post_public("/v1/auth/password/forgot", json!({ "email": email })).await.map(drop)
}

#[tauri::command]
pub async fn account_reset_password(account: Account<'_>, email: String, code: String, new_password: String) -> CoreResult<()> {
    account
        .post_public("/v1/auth/password/reset", json!({ "email": email, "code": code.trim(), "newPassword": new_password }))
        .await
        .map(drop)
}

#[tauri::command]
pub async fn account_request(account: Account<'_>, method: String, path: String, body: Option<Value>) -> CoreResult<Value> {
    account.request(&method, &path, body).await
}

#[tauri::command]
pub async fn account_enroll_device(account: Account<'_>) -> CoreResult<DeviceRegistration> {
    account.enroll_device().await
}

#[tauri::command]
pub async fn support_create_ticket(account: Account<'_>, input: TicketInput) -> CoreResult<Value> {
    account.create_ticket(input).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_paths() {
        assert!(check_path("/v1/devices").is_ok());
        assert!(check_path("/v1/users/me/sessions/abc").is_ok());
        assert!(check_path("/v1/servers?country=DE").is_ok());
        for bad in ["/v1/auth/refresh", "/v1/auth/login", "v1/devices", "/v2/x", "/v1/../admin", "/v1//x", "/v1/x#y", "/v1/a b", "https://evil/v1/x"] {
            assert!(check_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn attachment_types() {
        assert_eq!(attachment_type(std::path::Path::new("C:/x/Shot.PNG")), Some("image/png"));
        assert_eq!(attachment_type(std::path::Path::new("meridian.log")), Some("text/plain"));
        assert_eq!(attachment_type(std::path::Path::new("run.exe")), None);
        assert_eq!(attachment_type(std::path::Path::new("noext")), None);
    }

    #[test]
    fn login_result_shape() {
        assert_eq!(serde_json::to_value(LoginResult::MfaRequired).unwrap(), json!({ "kind": "mfa_required" }));
    }

    #[test]
    fn mfa_input_accepts_either_code() {
        let a: MfaInput = serde_json::from_value(json!({ "code": "123456" })).unwrap();
        assert_eq!(a.code.as_deref(), Some("123456"));
        let b: MfaInput = serde_json::from_value(json!({ "recoveryCode": "abcd-efgh" })).unwrap();
        assert_eq!(b.recovery_code.as_deref(), Some("abcd-efgh"));
    }
}
