//! The one error shape every command returns. `platform/tauri.ts` turns it
//! into `ServiceError` (service), `ApiFailure` (backend) or a plain `Error`.

use serde::Serialize;
use vpn_ipc::ClientError;
use vpn_types::ErrorKind;

pub type CoreResult<T> = Result<T, CoreError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreError {
    kind: Kind,
    code: String,
    message: String,
    /// HTTP status for `api` errors; 0 when the request never got an answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_kind: Option<ErrorKind>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Service,
    Api,
    Internal,
}

impl CoreError {
    /// The backend answered with an error (`code` is its stable error code).
    pub fn api(code: impl Into<String>, status: u16, message: impl Into<String>) -> Self {
        Self { kind: Kind::Api, code: code.into(), message: message.into(), status: Some(status), error_kind: None }
    }

    /// The backend couldn't be reached. The UI shows `apiErrors.network`.
    pub fn network(e: impl std::fmt::Display) -> Self {
        Self::api("network", 0, e.to_string())
    }

    pub fn not_signed_in() -> Self {
        Self::api("session_revoked", 401, "not signed in")
    }

    pub fn service(code: impl Into<String>, message: impl Into<String>, error_kind: Option<ErrorKind>) -> Self {
        Self { kind: Kind::Service, code: code.into(), message: message.into(), status: None, error_kind }
    }

    pub fn service_unavailable() -> Self {
        Self::service("service_unavailable", "the VPN service is not reachable", None)
    }

    /// A request the core refuses on the WebView's behalf.
    pub fn rejected(message: impl Into<String>) -> Self {
        Self { kind: Kind::Internal, code: "rejected".into(), message: message.into(), status: None, error_kind: None }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self { kind: Kind::Internal, code: "internal".into(), message: message.into(), status: None, error_kind: None }
    }

    pub fn bad_reply(e: impl std::fmt::Display) -> Self {
        Self::internal(format!("unexpected reply from the account service: {e}"))
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn is_unauthorized(&self) -> bool {
        self.kind == Kind::Api && self.status == Some(401)
    }

    pub fn is_network(&self) -> bool {
        self.kind == Kind::Api && self.code == "network"
    }
}

impl From<ClientError> for CoreError {
    fn from(e: ClientError) -> Self {
        match e {
            ClientError::Unavailable(_) | ClientError::Disconnected => Self::service("service_unavailable", e.to_string(), None),
            ClientError::Timeout => Self::service("timeout", e.to_string(), Some(ErrorKind::Timeout)),
            ClientError::Service(err) => {
                let code = serde_json::to_value(err.kind).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_else(|| "failed".into());
                Self::service(code, err.message, err.error_kind)
            }
            ClientError::Decode(m) => Self::internal(m),
        }
    }
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use vpn_types::{IpcError, IpcErrorKind};

    #[test]
    fn serializes_as_the_webview_expects() {
        let e = CoreError::api("invalid_credentials", 401, "nope");
        assert_eq!(serde_json::to_value(&e).unwrap(), json!({ "kind": "api", "code": "invalid_credentials", "message": "nope", "status": 401 }));

        let e: CoreError = ClientError::Service(IpcError {
            kind: IpcErrorKind::Failed,
            message: "handshake".into(),
            error_kind: Some(ErrorKind::HandshakeTimeout),
        })
        .into();
        assert_eq!(serde_json::to_value(&e).unwrap(), json!({ "kind": "service", "code": "failed", "message": "handshake", "errorKind": "handshake_timeout" }));
    }

    #[test]
    fn classifies() {
        assert!(CoreError::network("dns").is_network());
        assert!(CoreError::not_signed_in().is_unauthorized());
        assert!(!CoreError::service_unavailable().is_unauthorized());
    }
}
