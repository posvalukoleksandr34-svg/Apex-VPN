# Apexy VPN — Product Definition

Covers the feature map, navigation tree, and every page, modal and state.
Status of each feature in this build: **✅ implemented**, **🔌 integration
point** (abstraction + UI built, platform/provider piece not in this repo;
reports itself as unavailable, never fakes success), **🗺 planned**.

## 1. Feature map

| Area | Feature | Status |
|---|---|---|
| Connection | Connect / disconnect, real handshake + tunnel probe | ✅ Windows (WireGuardNT) · 🔌 macOS / Linux |
| | Reconnect on network change, sleep/wake, stale handshake | ✅ |
| | Smart Connect (Fastest, Nearest, Lowest load, Best overall) | ✅ |
| | Quick connect: fastest, nearest, last used, favourite, secure (privacy-tagged) | ✅ |
| Protocols | Automatic, WireGuard | ✅ |
| | OpenVPN, IKEv2/IPsec | 🔌 shown as "not available in this build" |
| Kill switch | Off / On while connected / Always On, WFP, atomic swaps, persistent filters while blocking | ✅ Windows (live-tested "on while connected"; see [TESTING.md](TESTING.md)) |
| DNS | VPN DNS, custom DNS, automatic, leak blocking, live status, DNS test | ✅ |
| Split tunnelling | Rules model, installed apps list, per-app modes | ✅ UI + model · 🔌 enforcement driver |
| Network | IPv4/IPv6, MTU, LAN access, reconnect behaviour | ✅ |
| Auto connect | On app start, on system start, untrusted Wi-Fi, reconnect when internet returns | ✅ logic · Wi-Fi SSID on Windows ✅ |
| Trusted networks | per-network rule: VPN required / optional / bypass | ✅ |
| Profiles | Gaming, Streaming, Work, Privacy, Travel, Custom | ✅ |
| Security | Security dashboard (verified facts only) | ✅ |
| | IP & network check, leak test (IPv4, IPv6, DNS, WebRTC) | ✅ (IPv4 needs a public IP-check endpoint; a local development API reports "unable to verify") |
| | Connection details + advanced | ✅ |
| Diagnostics | Diagnostics center (9 checks), logs, export, local-only mode | ✅ |
| Account | Sign in/up, verify email, reset password, TOTP 2FA, sessions, devices; session in the OS credential store | ✅ |
| | App lock (Windows Hello / password) | 🔌 setting shown as unavailable |
| Billing | Plans, renewal, invoices, upgrade/downgrade/cancel via `BillingProvider` | ✅ Stripe (Checkout, Customer Portal, verified webhooks; tested against a fake Stripe API, not yet a live account) · ✅ manual provider |
| | Connect requires a valid plan; renew prompt | ✅ service refuses past `validUntil` (kill switch not engaged), app prompts to renew, nodes enforce |
| Notifications | In-app center + OS notifications + preferences | ✅ |
| Settings | 15 categories, keyboard shortcuts list, global search | ✅ |
| Support | Help center, FAQ, troubleshooting, ticket with attachments + diagnostics | ✅ |
| Onboarding | 6 steps, skippable | ✅ |
| Desktop shell | Tray with live status, close to tray, start with Windows (minimized), global show/hide shortcut, OS notifications, single instance | ✅ Windows |
| Installer | Per-machine NSIS `.exe` and MSI that install, upgrade and remove the service (auto-restart on failure) | ✅ built and inspected; signing via environment ([DEPLOYMENT.md](DEPLOYMENT.md)); not yet run on a clean machine |
| Updates | Signed updates, rollback | 🔌 not configured: needs the updater plugin, a signing key and a release feed |
| CLI | `apexy connect|disconnect|status|servers|diagnostics|logs|login` | ✅ |
| Dev mode | Simulator transport: states, errors, slow network, reconnects, subscription states | ✅ dev builds only |
| i18n | en, ru, de, it | ✅ |

## 2. Navigation tree

```
Title bar: [status pill] ·········· [⌘K search] [🔔 notifications] [👤 account]
Sidebar (primary)                 Sub-navigation
├─ Dashboard           /
├─ Servers             /servers         tabs: Recommended · Favorites · Recent · All
│                                        filters: Streaming · Gaming · Privacy · P2P · Low latency
│                                        sort: Best · Latency · Load · A–Z
├─ Profiles            /profiles        /profiles/:id
├─ Security            /security        tabs: Overview · IP & Network · Leak Test · Connection Details
├─ Diagnostics         /diagnostics     tabs: Checks · Logs
├─ Settings            /settings/:section
│    General · Appearance · Connection · Protocols · Security · Privacy · DNS ·
│    Kill Switch · Split Tunneling · Network · Auto Connect & Trusted Networks ·
│    Notifications · Shortcuts · Advanced · About
└─ (footer) Support    /support         Help · FAQ · Troubleshooting · Contact
Account (from title bar) /account       Profile · Security (2FA, sessions) · Devices · Subscription
Notifications (panel)                   list + link to preferences
Onboarding (first run, full-screen)     /welcome
Auth (full-screen when signed out)      /signin · /register · /reset · /verify
```

Anything is at most two levels deep. The sidebar collapses to icons below
960 px, and there's a narrow layout from 720 px.

## 3. Pages, modals, dialogs, states

### Dashboard
Hero card: status ring + headline ("Unprotected" / "Connecting…" /
"Protected" / …), the one primary button, the current location
(flag · country · city · server), and the quick server switch.
Tiles: IP (original → VPN IP, *"verified"* only after an IP check through the
tunnel), Server quality (measured latency + load, "—" when unmeasured),
Session (duration, live ↓/↑ speed from driver byte counters), Protocol, and
Security (a short list of verified facts, not a score). Plus Quick actions and
Recent locations.
States: each `TunnelState` below, plus `ServiceUnavailable`, `ServiceStarting`,
`Offline (app)`, signed out, and subscription expired.

### Connection state → UI contract

| State | Tone | Headline | Primary action | Secondary |
|---|---|---|---|---|
| ServiceUnavailable | error | "VPN service isn't running" | Start service (Windows: opens elevated helper) | Diagnostics |
| ServiceStarting | pending | "Starting VPN service…" | — (spinner) | — |
| Disconnected | neutral | "Unprotected" | **Connect** | choose server |
| Disconnected (locked down) | warning | "Blocked — Always-on kill switch" | **Connect** | Kill switch settings |
| Connecting | pending | "Connecting…" + phase | **Cancel** | — |
| Connected | success | "Protected" | **Disconnect** | switch server |
| Reconnecting | pending | "Reconnecting…" + cause | **Cancel** | — |
| WaitingForNetwork | warning | "No internet connection" | **Cancel** | Diagnostics |
| Disconnecting | pending | "Disconnecting…" | — | — |
| Error (blocking) | error | error title + "Traffic is blocked to protect you" | **Retry** | Disconnect (unblock), Diagnostics |
| Error (non-blocking) | error | error title | **Retry** | Diagnostics |

### Servers
List grouped by country (expand to cities → servers). Each row shows flag,
name, city, latency (measured, else "—"), load bar, status badge, protocol
chips, feature chips, a favourite star and connect. Search, filters, sort,
Smart Connect menu. There's no map: at desktop widths it costs a third of the
screen and doesn't help choose between servers. We can revisit it.
Empty states: no favourites, no recent servers, no search results, relay list
unavailable (offline, showing the cached list with its age).
Modals: Server info (details, features, protocol support).

### Profiles
Grid of profiles with an "Active" badge. Editor sheet sections: target
(server / smart mode), protocol, DNS, kill switch, split tunnelling, network,
auto-connect. Dialogs: delete confirm, "apply while connected → reconnect".
Empty: "No profiles yet".

### Security
Overview: a verified facts list (VPN status, IP protection, DNS protection,
IPv6, kill switch, protocol, encryption, server, duration). Each fact is
*Verified*, *Not protected* or *Unable to verify* (with the reason).
IP & Network: current IP, VPN IP, ISP, country, city, timezone, ASN, DNS
servers, IPv6, WebRTC. There's a "Run security check" button.
Leak test: IPv4, IPv6, DNS and WebRTC checks, each Protected / Potential leak /
Unable to verify, with the evidence shown.
Connection details: protocol, cipher suite, last handshake, server, endpoint,
local interface, VPN IPs, DNS, MTU, bytes ↑/↓, uptime. "Advanced" disclosure:
public key fingerprints, interface LUID/index, routes, firewall policy summary.

### Diagnostics
Checks: internet, DNS, VPN service, authentication, server reachability,
tunnel, routing, kill switch, IPv6. Each shows ✓ Working / ⚠ Warning / ✕
Failed, and failures expand to what went wrong, likely causes and recommended
actions. Buttons: Run all, Copy report, Send to support.
Logs: level filter, search, live tail, Export (zip, redacted), Clear.
Empty: "No log entries yet".

### Settings
Two-pane layout: a section list and the section content. Advanced controls sit
behind "Show advanced" disclosures and carry inline explanations. Dangerous
changes (MTU outside 1280–1500, disabling leak protection, kill switch off)
open a confirm dialog that states the consequence.

### Account
Profile (email, verified badge), Security (password change, 2FA enrol with QR
and recovery codes, active sessions with revoke), Devices (name, OS, last
active, this-device badge, revoke), Subscription (plan, renewal, period,
payment method summary, invoices, change plan, cancel with a clear effective
date — no dark patterns).
Auth screens: sign in, 2FA challenge, register, verify email (code),
forgot/reset password. Errors: invalid credentials (generic), rate limited,
network offline, email unverified.

### Notifications
Panel from the bell icon, with unread dot and per-item actions. Types:
connected, disconnected, failed, kill switch engaged, new sign-in,
subscription, security warning, update available. Empty: "You're all caught
up".

### Support
Articles (bundled markdown, searchable offline), FAQ accordion,
troubleshooting flows that deep-link into Diagnostics, and a contact form
(subject, category, description, attachments ≤ 5 × 10 MB, "attach diagnostics
report" toggle with a preview of exactly what's sent).

### Onboarding (first run)
1 Welcome → 2 Privacy (what we collect, with toggles off by default) →
3 How it works + the permission the service needs → 4 Protection defaults
(kill switch, auto-connect) → 5 Sign in → 6 Connect (Smart Connect preselected).
Every step can be skipped except sign-in, which is skippable to "browse
servers".

### Global
* Command palette (Ctrl K): servers, settings, profiles, help articles, actions.
* Toasts for transient outcomes. Banners for persistent conditions (offline,
  service unavailable, subscription expiring, dev simulator).
* Error surface: title, explanation, likely cause, recommended action, Retry,
  Open diagnostics.
* Offline: the app keeps working with cached relays, profiles, settings, logs
  and help articles. Account pages show cached data with a "last updated" time.

## 4. Keyboard shortcuts (defaults, editable in Settings → Shortcuts)

| Action | Windows / Linux | macOS | Scope |
|---|---|---|---|
| Connect / disconnect (toggle) | Ctrl Shift C | ⌘ ⇧ C | app |
| Disconnect | Ctrl Shift D | ⌘ ⇧ D | app |
| Open server selector | Ctrl L | ⌘ L | app |
| Search | Ctrl K | ⌘ K | app |
| Settings | Ctrl , | ⌘ , | app |
| Show / hide window | Ctrl Alt M | ⌘ ⌥ M | global |
