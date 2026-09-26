//! `meridian login`: enrolls this device without the desktop app (headless
//! machines, servers). It signs in, registers the service's public key, hands
//! the registration to the service, and signs out again. The CLI keeps no
//! session or password.

use std::io::{BufRead, IsTerminal, Write};

use anyhow::{bail, Context};
use serde::Deserialize;
use serde_json::json;
use vpn_ipc::IpcClient;
use vpn_types::ipc::Request;
use vpn_types::{Capabilities, DeviceInfo, DeviceRegistration};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    access_token: String,
    refresh_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MfaChallenge {
    mfa_token: String,
}

#[derive(Deserialize)]
struct ApiErrorBody {
    error: ApiErrorInner,
}

#[derive(Deserialize)]
struct ApiErrorInner {
    code: String,
}

pub async fn login(client: &IpcClient, email: &str, password_stdin: bool, device_name: Option<String>) -> anyhow::Result<()> {
    let caps: Capabilities = client.call(Request::GetCapabilities).await?;
    let device: DeviceInfo = client.call(Request::GetDevice).await?;
    let api = caps.api_base_url.trim_end_matches('/').to_string();
    let http = reqwest::Client::builder().https_only(api.starts_with("https://")).build()?;

    let password = if password_stdin {
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line)?;
        line.trim_end_matches(['\r', '\n']).to_string()
    } else {
        rpassword::prompt_password("Password: ")?
    };
    let name = device_name.unwrap_or_else(|| hostname().unwrap_or_else(|| "This computer".into()));
    let platform = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        "linux" => "linux",
        _ => "other",
    };

    let res = http
        .post(format!("{api}/v1/auth/login"))
        .json(&json!({ "email": email, "password": password, "device": { "name": name, "platform": platform } }))
        .send()
        .await
        .context("could not reach the Meridian API")?;
    let body: serde_json::Value = decode(res).await?;
    let tokens: Tokens = if body.get("mfaRequired").is_some() {
        let challenge: MfaChallenge = serde_json::from_value(body)?;
        let code = prompt("Authenticator code: ")?;
        let res = http
            .post(format!("{api}/v1/auth/login/mfa"))
            .json(&json!({ "mfaToken": challenge.mfa_token, "code": code.trim(), "device": { "name": name, "platform": platform } }))
            .send()
            .await?;
        serde_json::from_value(decode(res).await?)?
    } else {
        serde_json::from_value(body)?
    };

    let res = http
        .post(format!("{api}/v1/devices"))
        .bearer_auth(&tokens.access_token)
        .json(&json!({ "name": name, "platform": platform, "appVersion": env!("CARGO_PKG_VERSION"), "publicKey": device.public_key }))
        .send()
        .await?;
    let registered: serde_json::Value = decode(res).await?;
    let registration: DeviceRegistration = serde_json::from_value(registered["registration"].clone())
        .context("unexpected registration response")?;
    client.call::<DeviceInfo>(Request::SetDeviceRegistration { registration: registration.clone() }).await?;

    // Don't leave a session behind.
    let _ = http.post(format!("{api}/v1/auth/logout")).json(&json!({ "refreshToken": tokens.refresh_token })).send().await;

    println!(
        "This device is enrolled as \"{name}\" (tunnel address {}). You can connect with `meridian connect`.",
        registration.ipv4_address
    );
    Ok(())
}

async fn decode(res: reqwest::Response) -> anyhow::Result<serde_json::Value> {
    let status = res.status();
    let text = res.text().await?;
    if status.is_success() {
        return Ok(serde_json::from_str(&text).unwrap_or(serde_json::Value::Null));
    }
    let code = serde_json::from_str::<ApiErrorBody>(&text).map(|e| e.error.code).unwrap_or_else(|_| status.to_string());
    let hint = match code.as_str() {
        "invalid_credentials" => "the email or password is wrong",
        "email_unverified" => "verify your email first (check your inbox)",
        "subscription_inactive" => "your plan has ended",
        "device_limit_reached" => "your plan's device limit is reached; remove a device first",
        "too_many_attempts" | "rate_limited" => "too many attempts; wait a few minutes",
        _ => "",
    };
    if hint.is_empty() { bail!("{code}") } else { bail!("{code}: {hint}") }
}

fn prompt(label: &str) -> anyhow::Result<String> {
    if !std::io::stdin().is_terminal() {
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line)?;
        return Ok(line);
    }
    print!("{label}");
    std::io::stdout().flush()?;
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    Ok(line)
}

fn hostname() -> Option<String> {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).ok().filter(|h| !h.is_empty())
}
