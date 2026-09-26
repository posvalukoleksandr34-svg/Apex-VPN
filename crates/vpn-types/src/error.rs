//! Every failure the user can see. Each kind has a stable code, and the UI
//! maps the code to i18n keys for title, explanation, likely cause and
//! recommended action (`errors.<code>.*`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::CheckId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, thiserror::Error)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ErrorKind {
    /// The device has no valid registration: sign in again.
    #[error("authentication required")]
    AuthRequired,
    /// The account has no active subscription.
    #[error("subscription inactive")]
    SubscriptionInactive,
    #[error("no internet connection")]
    NoInternet,
    /// The chosen server is offline, in maintenance, or not answering.
    #[error("server unavailable")]
    ServerUnavailable,
    /// No server satisfies the target's constraints.
    #[error("no matching server")]
    NoMatchingServer,
    /// No usable relay list (never fetched, or expired and unrefreshable).
    #[error("server list unavailable")]
    RelayListUnavailable,
    /// The relay list's signature did not verify. Possible tampering.
    #[error("server list signature invalid")]
    RelayListInvalid,
    /// The selected protocol is not available in this build or on this server.
    #[error("protocol unavailable")]
    ProtocolUnavailable,
    /// The service lacks the privileges it needs.
    #[error("permission denied")]
    PermissionDenied,
    /// The tunnel driver is missing or failed its signature check.
    #[error("tunnel driver unavailable")]
    DriverUnavailable,
    /// The handshake did not complete in time. Often UDP is blocked.
    #[error("handshake timed out")]
    HandshakeTimeout,
    /// The tunnel came up but nothing got through it.
    #[error("tunnel verification failed")]
    TunnelVerificationFailed,
    #[error("tunnel failure")]
    TunnelFailure,
    #[error("DNS configuration failed")]
    DnsFailure,
    #[error("routing configuration failed")]
    RoutingFailure,
    /// The kill switch rules could not be applied, so we refused to connect.
    #[error("firewall failure")]
    FirewallFailure,
    #[error("operation timed out")]
    Timeout,
    /// Stored settings were unreadable and were reset (a backup was kept).
    #[error("configuration corrupted")]
    ConfigurationCorrupted,
    #[error("not supported on this platform")]
    UnsupportedPlatform,
    #[error("internal error")]
    Internal,
}

impl ErrorKind {
    pub fn code(self) -> &'static str {
        match self {
            Self::AuthRequired => "auth_required",
            Self::SubscriptionInactive => "subscription_inactive",
            Self::NoInternet => "no_internet",
            Self::ServerUnavailable => "server_unavailable",
            Self::NoMatchingServer => "no_matching_server",
            Self::RelayListUnavailable => "relay_list_unavailable",
            Self::RelayListInvalid => "relay_list_invalid",
            Self::ProtocolUnavailable => "protocol_unavailable",
            Self::PermissionDenied => "permission_denied",
            Self::DriverUnavailable => "driver_unavailable",
            Self::HandshakeTimeout => "handshake_timeout",
            Self::TunnelVerificationFailed => "tunnel_verification_failed",
            Self::TunnelFailure => "tunnel_failure",
            Self::DnsFailure => "dns_failure",
            Self::RoutingFailure => "routing_failure",
            Self::FirewallFailure => "firewall_failure",
            Self::Timeout => "timeout",
            Self::ConfigurationCorrupted => "configuration_corrupted",
            Self::UnsupportedPlatform => "unsupported_platform",
            Self::Internal => "internal",
        }
    }

    /// Whether retrying the same action unchanged can plausibly succeed.
    pub fn retryable(self) -> bool {
        !matches!(
            self,
            Self::AuthRequired
                | Self::SubscriptionInactive
                | Self::RelayListInvalid
                | Self::PermissionDenied
                | Self::DriverUnavailable
                | Self::UnsupportedPlatform
                | Self::ProtocolUnavailable
        )
    }

    /// Whether the reconnect loop should keep trying on its own.
    pub fn auto_recoverable(self) -> bool {
        matches!(
            self,
            Self::NoInternet
                | Self::ServerUnavailable
                | Self::HandshakeTimeout
                | Self::TunnelVerificationFailed
                | Self::TunnelFailure
                | Self::Timeout
        )
    }

    /// The diagnostics check most likely to explain this error.
    pub fn diagnostic(self) -> Option<CheckId> {
        Some(match self {
            Self::AuthRequired | Self::SubscriptionInactive => CheckId::Authentication,
            Self::NoInternet => CheckId::Internet,
            Self::ServerUnavailable | Self::NoMatchingServer | Self::HandshakeTimeout => {
                CheckId::ServerReachability
            }
            Self::RelayListUnavailable | Self::RelayListInvalid => CheckId::ServerReachability,
            Self::DnsFailure => CheckId::Dns,
            Self::RoutingFailure => CheckId::Routing,
            Self::FirewallFailure => CheckId::KillSwitch,
            Self::TunnelFailure | Self::TunnelVerificationFailed | Self::DriverUnavailable => {
                CheckId::Tunnel
            }
            Self::PermissionDenied => CheckId::Service,
            Self::ProtocolUnavailable
            | Self::Timeout
            | Self::ConfigurationCorrupted
            | Self::UnsupportedPlatform
            | Self::Internal => return None,
        })
    }
}

/// Error returned over IPC for a failed request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
#[error("{kind}: {message}")]
pub struct IpcError {
    pub kind: IpcErrorKind,
    pub message: String,
    /// Set when the failure maps to a user-facing error.
    pub error_kind: Option<ErrorKind>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, thiserror::Error)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum IpcErrorKind {
    #[error("invalid request")]
    InvalidRequest,
    #[error("invalid argument")]
    InvalidArgument,
    #[error("not found")]
    NotFound,
    #[error("unsupported")]
    Unsupported,
    #[error("version mismatch")]
    VersionMismatch,
    #[error("operation failed")]
    Failed,
}

impl IpcError {
    pub fn new(kind: IpcErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), error_kind: None }
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(IpcErrorKind::InvalidArgument, message)
    }

    pub fn from_error_kind(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind: IpcErrorKind::Failed, message: message.into(), error_kind: Some(kind) }
    }
}
