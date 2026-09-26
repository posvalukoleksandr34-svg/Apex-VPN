# Meridian VPN — Architecture

Meridian is a desktop VPN client (Windows, macOS, Linux) plus the backend that
issues accounts, devices and the server list. This document is the blueprint;
every other doc drills into one box on this page.

> Working name: **Meridian**. Binaries: `meridian-desktop` (UI), `meridiand`
> (privileged service), `meridian` (CLI). Brand strings live in one place
> (`crates/vpn-types/src/brand.rs`, `apps/desktop/src/brand.ts`).

## 1. The one rule everything follows

**The privileged service (`meridiand`) is the single source of truth for the
tunnel.** The UI, the tray icon and the CLI are views of the service state.
They never infer, predict, or optimistically render a connection. "Connected"
is only emitted by the service after the WireGuard handshake has completed
*and* a probe through the tunnel succeeded.

## 2. Process model

```
┌──────────────────────────── user session (unprivileged) ─────────────────────────────┐
│                                                                                        │
│  meridian-desktop (Tauri)                                  meridian (CLI)              │
│  ┌──────────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐   │
│  │ WebView: React UI        │◄─►│ Tauri core (Rust)    │   │ clap commands        │   │
│  │  - renders state only    │ ① │  - daemon bridge     │   │  (same IPC client)   │   │
│  │  - no secrets, no tokens │   │  - account + tokens  │   └──────────┬───────────┘   │
│  └──────────────────────────┘   │    (OS keychain)     │              │               │
│                                 │  - tray, shortcuts,  │              │               │
│                                 │    notifications,    │              │               │
│                                 │    updater           │              │               │
│                                 └───┬──────────────┬───┘              │               │
└─────────────────────────────────────┼──────────────┼──────────────────┼───────────────┘
                              HTTPS ③ │              │ ② local IPC      │
                                      ▼              ▼ (named pipe /    ▼
                              ┌──────────────┐  ┌──────────────────────────────────────┐
                              │ Backend API  │  │ meridiand  (SYSTEM / root)           │
                              │ (Fastify/PG) │◄─┤  TunnelStateMachine  ← single truth  │
                              └──────┬───────┘ ④│  ProtocolManager → WireGuard-NT/...  │
                                     │          │  Firewall (kill switch, leak block)  │
                          node API ⑤ │          │  DNS, Routes, NetworkMonitor         │
                                     ▼          │  RelayList (signature-verified)      │
                              ┌──────────────┐  │  Device key (DPAPI / keychain)       │
                              │ VPN nodes    │◄═╡  WireGuard UDP tunnel                │
                              │ node-agent + │  └──────────────────────────────────────┘
                              │ WireGuard    │
                              └──────────────┘
```

| Link | Transport | Authentication | Carries |
|---|---|---|---|
| ① | Tauri IPC (in-process) | Tauri capability allow-list | commands, state events |
| ② | Named pipe `\\.\pipe\meridian` (Win) / Unix socket `/var/run/meridian.sock` (0660, group `meridian`) | OS ACL: SYSTEM, Administrators, interactive users | JSON-lines RPC + event stream |
| ③ | HTTPS (rustls, TLS 1.2+, cert validation, optional SPKI pin) | email+password → access JWT (15 min) + rotating refresh token in OS keychain | account, devices, billing |
| ④ | HTTPS | none (public, **signed** data) | relay list; the service verifies the Ed25519 signature before use |
| ⑤ | HTTPS + per-node bearer token | node token (hashed at rest) | peer set sync, health reports |

### Why a separate privileged service
Creating adapters, routes, DNS and firewall rules needs admin/root. Putting
that in a small service and keeping the UI unprivileged means a compromised
renderer cannot touch the network stack, and a crashed UI never tears down
the tunnel or the kill switch. It is the same split used by the WireGuard,
Mullvad and Tailscale clients.

### Why the service never holds account credentials
The service only needs (a) the device WireGuard private key, which it generates
and never exports, and (b) the signed relay list. Account tokens stay in the
user's keychain, owned by the desktop process. Local malware that talks to the
pipe can toggle the tunnel, but cannot redirect traffic to a server that isn't
in the signed list, and cannot steal the private key or account session.

## 3. Technology choices

| Area | Choice | Why |
|---|---|---|
| Privileged service, VPN core, CLI | **Rust** (tokio) | memory safety in a process running as SYSTEM/root; direct FFI to WFP / IP Helper / netlink without a runtime |
| Windows tunnel | **WireGuardNT** (`wireguard.dll`, signed by WireGuard LLC, loaded with `LOAD_LIBRARY_SEARCH_APPLICATION_DIR`) | in-kernel, fastest option on Windows; avoids a userspace packet loop |
| Windows kill switch | **Windows Filtering Platform** via `windows-sys` | the only supported way to block traffic system-wide below applications |
| Linux (integration point) | kernel WireGuard over netlink, nftables, systemd-resolved | stubs return `Unsupported`, never fake success |
| macOS (integration point) | NetworkExtension packet tunnel + boringtun, pf | same |
| Desktop shell | **Tauri 2** | small binary, Rust core shares crates with the service, OS WebView |
| UI | **React 18 + TypeScript + Vite**, Zustand, react-router, i18next, Radix primitives, CSS Modules + design tokens, lucide icons | Radix gives accessible dialogs/menus/tabs; CSS variables make themes and density switchable at runtime |
| Backend | **TypeScript, Node 22, Fastify, PostgreSQL, Kysely**, zod | typed end to end; Fastify is fast and schema-first; PG gives schemas for domain separation. PGlite (Postgres compiled to WASM) runs tests and local dev without Docker |
| Password hashing | argon2id (`@node-rs/argon2`) | memory-hard, OWASP recommended |
| Relay list integrity | Ed25519 detached signature over raw bytes | the service pins the public key; no canonicalisation ambiguity |
| Updates | Tauri updater (minisign signatures, pinned pubkey) | refuses unsigned or mismatched packages |

## 4. Rust workspace

```
crates/
  vpn-types/     serde types shared by service, app, CLI (+ TS export via ts-rs)
                 TunnelState, ErrorKind, Settings, RelayList, IPC messages
  vpn-core/      platform-independent logic, no I/O:
                 TunnelStateMachine (driven by traits), ReconnectPolicy,
                 FirewallPolicy computation, SmartConnect scoring,
                 RelayList verification, Settings validation/migration,
                 protocol selection ("Automatic")
  vpn-platform/  trait impls per OS: TunnelDriver, Firewall, DnsManager,
                 RouteManager, NetworkMonitor, PowerMonitor, KeyStore, Pinger,
                 InstalledApps. windows/ is real; linux/ and macos/ are marked
                 integration points
  vpn-ipc/       JSON-lines protocol, framing, client + server
  vpn-daemon/    meridiand: service host, IPC server, persistence, logging
  vpn-cli/       meridian: CLI over vpn-ipc (same core, no second implementation)
apps/desktop/src-tauri/   Tauri core: daemon bridge, account, tray, updater
```

The layering the brief asks for maps onto real types:

```
VPNProvider         = vpn-daemon::Service           (owns everything below)
 → ProtocolManager  = vpn-core::protocol::ProtocolManager (Automatic/WG/OpenVPN/IKEv2)
 → ConnectionManager= vpn-core::tunnel::TunnelStateMachine
 → NetworkManager   = vpn-platform::NetworkMonitor + offline detection
 → DNSManager       = vpn-platform::DnsManager      (+ firewall DNS rules)
 → KillSwitchManager= vpn-core::firewall::policy  → vpn-platform::Firewall
 → RoutingManager   = vpn-platform::RouteManager
```

### Tunnel state machine
States (`vpn-types::TunnelState`), mapped 1:1 to what the UI may show:

| State | Meaning | Traffic |
|---|---|---|
| `Disconnected { locked_down }` | no tunnel | open, or blocked if kill switch = Always On |
| `Connecting { target, attempt, phase }` | building a tunnel. Phases: resolving, creating interface, handshaking, verifying | blocked except the relay endpoint (kill switch ≠ Off) |
| `Connected { details }` | handshake done **and** probe through the tunnel succeeded | tunnel only; DNS only to the tunnel DNS |
| `Reconnecting { target, attempt, cause }` | lost the tunnel (network changed, handshake stale, woke from sleep, server down) and rebuilding | blocked except the relay endpoint |
| `WaitingForNetwork { … }` | no usable physical route ("No Internet") | blocked if the kill switch is on |
| `Disconnecting { then }` | tearing down | blocked until torn down, then policy for the next state |
| `Error { kind, blocking }` | could not reach the target state; `blocking` says whether the kill switch is holding traffic | blocked if `blocking` |

The app adds two states it derives itself, because the service cannot report
them: `ServiceStarting` (pipe exists, no hello yet) and `ServiceUnavailable`
(no pipe). "Authentication Required" is `Error{kind: AuthRequired}`,
"Server Unavailable" is `Error{kind: ServerUnavailable}`, "Network Changed" is
`Reconnecting{cause: NetworkChanged}`, "No Internet" is `WaitingForNetwork`.

Transitions are driven by commands (`Connect`, `Disconnect`, `Reconnect`) and
platform events (`NetworkChanged`, `Offline`, `Online`, `Suspend`, `Resume`,
`HandshakeStale`, `TunnelDriverFailed`). The machine is pure and is unit-tested
with fake drivers, including the scenarios the brief lists (Wi-Fi → hotspot,
sleep/wake, lid close, server failure, DNS failure, IPv6, restart).

### Kill switch, precisely
`vpn-core::firewall::policy(state, settings) -> FirewallPolicy` is a pure
function. The Windows implementation applies a policy **inside one WFP
transaction**: old filters and new filters swap atomically, so there is no
instant where neither set exists. Filters live in our own provider/sublayer and
are added from a non-dynamic session, so they survive a crash of the service.
The service reapplies the correct policy on start, and filters are removed only
by an explicit transition to a non-blocking state. In "Always On", filters are
also marked persistent, so they hold from boot until the service is up.

| Kill switch | Disconnected (by user) | Connecting / Reconnecting / Waiting | Connected | Error |
|---|---|---|---|---|
| Off | open | open (**may leak**) | tunnel + leak rules | open |
| On while connected (default) | open | blocked, except relay endpoint, DHCP, optional LAN | tunnel only | blocked |
| Always On | blocked | blocked, except relay endpoint | tunnel only | blocked |

"Blocked" allows loopback, DHCP/NDP, optional LAN, and the backend API for the
service and app executables only. That's what lets you sign in and fetch the
server list while the kill switch holds.

### DNS and leak protection
When connected, the service sets the tunnel DNS on the tunnel interface, gives
the tunnel the lowest interface metric, flushes the resolver cache, and adds
firewall rules that drop port 53 (UDP/TCP) to any address except the chosen
tunnel DNS over the tunnel interface. DNS-over-HTTPS in browsers can't be told
apart from HTTPS, so it can't be blocked by port. The DNS page states this
rather than claiming otherwise.
"VPN DNS" is the node's resolver: the relay list's `dnsIpv4` if the node names
one, otherwise its tunnel gateway (every Meridian node runs a resolver there).
Third-party nodes that only route, like the WireGuard demo server used in
development, name a public resolver, which is then reached through the tunnel
like all other traffic.
IPv6: if the tunnel has no IPv6, IPv6 is blocked outside the tunnel while
connected (setting on by default).

### Split tunnelling (honest status)
Re-routing one app outside the tunnel needs a platform component: a WFP callout
**kernel driver** on Windows, cgroups + fwmark on Linux, and a NetworkExtension
on macOS. The rules model, UI, installed-apps list and persistence are built.
The Windows driver is not part of this repo, so the platform reports
`SplitTunnel: Unavailable(DriverMissing)`, the UI says "not active", and no
rule is ever shown as enforced when it isn't.

### Protocols
`ProtocolManager` holds a registry of `TunnelDriver`s with capability
reports. WireGuard (WireGuardNT) is implemented. OpenVPN and IKEv2 are
integration points: their drivers report `Unavailable(NotBundled)`, the UI
shows them as "not available in this build", and "Automatic" only chooses
among available drivers. Its policy: WireGuard first; on repeated UDP handshake
timeouts, fall back to the next available TCP-capable protocol.

## 5. Desktop app

* **Two halves.** A React UI in a WebView, and a Rust core
  (`apps/desktop/src-tauri`) that is the only part talking to the outside
  world:
  * `service.rs` keeps one IPC connection to `meridiand`, reconnecting with
    backoff. It forwards service events to the UI (`service://event`) and
    passes the UI's requests on, after decoding them into the typed protocol.
    Requests that manage the connection or set the device registration are
    refused from page script.
  * `account.rs` owns the account session. The refresh token and last-known
    profile live in the OS credential store; the access token only in memory.
    Refreshes are serialized, because the backend revokes the whole token
    family on reuse. The UI gets narrow commands plus a `/v1/...` passthrough
    that can't reach `/v1/auth/*`. Support attachments must be files the user
    picked in the native dialog.
  * `desktop.rs` / `tray.rs`: window, tray (coloured only while protected),
    notifications, autostart, file dialogs and the global shortcut. External
    links are limited to `https:` and `mailto:`.
  * Every command is listed in `build.rs`, so `capabilities/main-window.json`
    is the complete surface the WebView can reach. No plugin is exposed to
    page script directly.
* **Transport boundary.** The UI talks to one interface, `ClientTransport`
  (`apps/desktop/src/platform/transport.ts`), which has three implementations:
  `TauriTransport` (production, the Rust core above), `SimulatorTransport`
  (development only) and `UnavailableTransport` (a plain browser: honestly
  "service unavailable"). The simulator is compiled in only when the build-time
  constant `__SIMULATOR__` is set (`vite --mode simulator`), so production
  bundles don't contain it. When active it shows a permanent "Development
  simulator — not a real VPN" banner.
* **State.** A Zustand store holds the latest `TunnelState` exactly as the
  service sent it. `features/connection/status.ts` (`describe()`) maps each
  state to tone, label, description and available actions. The dashboard,
  title bar, tray and notifications all use it, so two surfaces can never
  disagree. Tests enumerate every state and assert that "Protected" appears
  only for `connected`.
* **Enrollment.** After sign-in, and once per app start, the app enrolls the
  service's public key (idempotent per key). The refresh picks up a renewed
  plan's validity and lets providers re-announce the key to nodes that
  forget idle peers. An active tunnel is left as it is.
* **i18n.** Every user-facing string is an i18next key. Locales: en, ru, de, it.
  Tests fail when any locale misses a key or a `{{placeholder}}`, and when
  code references a key that doesn't exist.

## 6. Backend

Fastify app with modules: `auth`, `users`, `devices`, `servers`, `profiles`,
`connections`, `subscription`, `notifications`, `diagnostics`, `support`,
`nodes` (node-agent API) and `admin`. PostgreSQL with one **schema per domain**
(`identity`, `ops`, `billing`, `fleet`, `diag`, `support`, `notify`),
forward-only SQL migrations, and Kysely for typed queries.

* Access token: EdDSA JWT, 15 min, carries `sub`, `sid` (session id), `amr`.
* Refresh token: 256-bit random, stored as SHA-256, rotated on every use.
  Reuse of a rotated token revokes the whole session family (theft detection).
* 2FA: TOTP (RFC 6238), secret encrypted at rest (AES-256-GCM, key from env),
  plus one-time recovery codes stored hashed.
* Relay list: `GET /servers/relays` returns `{payload, signature, keyId}`.
  `payload` is the exact signed bytes. It has an expiry and a monotonically
  increasing version, and the service rejects rollbacks.
* Billing: `BillingProvider` interface. The `stripe` adapter is an integration
  point; the `manual` adapter is used for dev and for staff-granted plans.
* Health monitor: probes each node for reachability, latency and packet loss,
  and takes node self-reports for load and WireGuard status. The API only
  publishes values backed by a recent measurement; stale values become `null`.

## 7. Data the product keeps — and doesn't

| Kept | Where | Why |
|---|---|---|
| email, password hash, 2FA secret (encrypted) | `identity` | sign-in |
| devices: name, OS, WG public key, tunnel IPs, last seen (day granularity) | `ops` | peer provisioning, device limit |
| subscription, invoices (provider refs only, no card data) | `billing` | entitlement |
| server metadata, health samples (7 days) | `fleet` | server list, smart connect |
| diagnostic reports (only when the user sends one) | `diag` | support |
| tickets + attachments | `support` | support |

**Not kept anywhere:** traffic content, visited domains, DNS queries,
connection timestamps per user, source IPs of tunnel sessions. Local logs are
redacted (IPs masked unless diagnostic mode is on) and never leave the machine
unless the user exports or attaches them.

## 8. Error handling

Every failure is a typed `ErrorKind` (`vpn-types::error`) with a stable code,
an i18n key for title/explanation/likely cause/recommended action, whether a
retry makes sense, and which diagnostic check to run. The UI renders all
errors with one `ErrorState` component, so no error is a bare string.

## 9. Logging and telemetry

* Service: `tracing` to a rotating file under `%ProgramData%\Meridian\logs`
  (7 files × 5 MB). The levels are error/warn/info/debug, set in Advanced. A
  redaction layer masks IPv4/IPv6 addresses and WireGuard keys unless
  diagnostic mode is on.
* Telemetry is **off by default** and consists of anonymous product events
  (app started, connect success/failure by error code, no server id). The
  privacy center shows every category's state, contents, purpose, storage and
  off-switch. "Local-only logging" disables every upload path, including crash
  reports.

## 10. Deployment

* Desktop: Tauri bundles MSI/NSIS (Windows), DMG (macOS), deb/AppImage (Linux).
  The installer registers `meridiand` as a service (Windows: `LocalSystem`,
  auto-start; Linux: systemd unit; macOS: launchd daemon plus the system
  extension). Updates ship as signed Tauri update packages. The service binary
  and `wireguard.dll` are Authenticode-signed; the service verifies
  `wireguard.dll`'s signature before loading it.
* Backend: a container image, PostgreSQL (managed), migrations at deploy, and
  secrets from the platform's secret store. Nodes run WireGuard + `node-agent`
  (systemd).

See `docs/DEPLOYMENT.md`.
