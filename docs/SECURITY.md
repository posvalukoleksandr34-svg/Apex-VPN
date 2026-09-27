# Security and threat model

What Apexy VPN protects, from whom, how, and what it deliberately does not claim.

## 1. What the product promises

While the tunnel is up and verified:

* Traffic leaves the device only through the WireGuard tunnel. Local-network traffic also goes direct if the user allows LAN access.
* DNS queries go only to the tunnel resolver. Every other resolver is blocked on port 53.
* IPv6 is tunnelled, or blocked outside the tunnel.
* With the kill switch on, none of this lapses during connecting, reconnecting, network changes, sleep/wake or failures. With "Always on" it holds even when disconnected and from boot.

It does **not** promise anonymity from the VPN operator, protection from a compromised device, blocking of DNS-over-HTTPS by port, or split-tunnel enforcement (not built; see PRODUCT.md). The UI says each of these where relevant.

## 2. Assets

| Asset | Where | Protection |
|---|---|---|
| Device WireGuard private key | Service data dir (`%ProgramData%\Apexy VPN`) | DPAPI machine scope; directory ACL SYSTEM + Administrators; never leaves the service, never logged |
| Account refresh token | OS credential store (user) | Only the app's Rust core reads it; the WebView never sees any token |
| Access token (15 min) | App core memory | Never persisted |
| Relay list integrity | Fetched from the API | Ed25519 signature over the exact payload bytes, pinned keys, version rollback and expiry checks |
| Kill switch integrity | Windows Filtering Platform | Own provider/sublayer at max weight; blocking filters persistent across service crashes |
| Passwords | Backend | argon2id; never logged; rate-limited sign-in with lockout |
| TOTP secrets | Backend | AES-256-GCM with a key from configuration (a KMS in production) |
| Traffic, sites, DNS queries | — | Never collected or logged, on the device or the server |

## 3. Adversaries and mitigations

**Network attacker (hotel Wi-Fi, ISP, captive portal).**
* Can't read or alter tunnel traffic (WireGuard: Noise IK, ChaCha20-Poly1305).
* Can't substitute servers: the relay list is signed and verified against pinned keys. A tampered list is refused and the UI says so (`relay_list_invalid`).
* Can't downgrade to an older list: version rollback is refused.
* Can block UDP. The app reports `handshake_timeout` and never reports success. TCP-based fallback protocols are integration points.
* DNS leaks are blocked by firewall, not just configuration. This was verified live: `dns_only_via_tunnel`.

**Local unprivileged process (other software, another user's session).**
* The IPC pipe allows SYSTEM, Administrators and interactive users only, rejects remote clients, and is created first-instance-only (no squatting).
* The service validates every request against the typed protocol.
* A local user *can* control the VPN (connect, disconnect, settings), by design: the same is true of the app they could open.
* A local user can't read the device key (ACL + DPAPI) or the service's data directory.
* Tokens are in the signed-in user's credential store, not readable by other users.

**Compromised page script in the WebView** (e.g. an XSS in UI code).
* The CSP allows only the app's own scripts; there is no remote content.
* The capability file grants exactly the app's commands; no plugin is directly reachable.
* The core refuses what page script shouldn't do:
  * setting the device registration (it must come from the account API);
  * managing the IPC connection;
  * calling `/v1/auth/*` through the passthrough (those responses carry tokens);
  * uploading files the user didn't pick in the native dialog;
  * opening non-`https`/`mailto` links.
* Page script can still act as the signed-in user within the account API. This is the residual risk of any client UI.

**Malicious or buggy server data.**
* The relay list is validated beyond its signature: endpoints must be public unless development allows private ones, gateways must be private, a named resolver can't be loopback/link-local/multicast, keys and ports must be well formed, and metadata is bounded.
* An IP-check answer that isn't a public address is refused rather than shown as "your IP".

**The service dying (crash, killed, update gone wrong).**
* WFP filters don't belong to the process: the engine session isn't dynamic, and while blocking the filters are persistent. When `apexyd` dies, the tunnel adapter disappears with it, and the block-all filters remain, so nothing leaves the device outside the tunnel.
* Windows restarts the installed service (recovery actions: 1 s, 5 s, 30 s). The new instance removes every filter under Apexy VPN's provider, including the crashed instance's, applies its own atomically, and resumes the connection the user asked for.
* `scripts/validate-killswitch.ps1` checks this end to end: hard kill, leak probes, filters present, recovery, release.

**Expired or unpaid plans.**
* **Nodes:** they drop peers whose plan ended. This is the real enforcement.
* **Device enrollment:** it requires a valid plan.
* **The service:** it refuses to start a connection past the registration's `validUntil`, with 10 minutes of allowance for a fast device clock. It doesn't engage the kill switch for a connection that can't start, so an expired plan never takes the user's internet away. If the plan ends mid-session, traffic stays held, as for any lapse the user didn't ask for.

**Stolen or reused refresh token.**
* Refresh tokens rotate on use.
* Reuse outside a 15-second grace period revokes the whole family (every session descended from that sign-in).
* Changing the password signs out all other sessions.

**Supply chain.**
* `wireguard.dll` is loaded by full path, only after WinVerifyTrust confirms a valid Authenticode signature by WireGuard LLC.
* Release binaries must be code-signed (DEPLOYMENT.md). Updates are not configured in this build.

## 4. Privileged surface

`apexyd` runs as SYSTEM because creating adapters, routes, DNS settings and WFP filters requires it. To keep that surface small:

* It accepts only the typed protocol over the ACL'd pipe, with bounded frame sizes.
* It performs no parsing of untrusted formats beyond JSON from the signed relay list and the account API.
* It never executes files and loads only the verified driver DLL.
* The app, CLI and UI run unprivileged.

## 5. Logging and privacy

* The connection log records events: attempts, network changes, errors.
* IP addresses are redacted unless the user turns on diagnostic mode, which is time-limited in intent and labelled.
* The backend keeps no connection history. Nodes know a peer only while it is connected.
* Diagnostic reports are sent only when the user chooses, after a preview.

## 6. Known gaps (tracked, not hidden)

* **Split tunnelling** isn't enforced: the driver doesn't exist yet, and the UI says so.
* **App lock** (Windows Hello) isn't built; the setting shows as unavailable.
* **Updates, installer bundling and code signing** need release infrastructure (DEPLOYMENT.md).
* **Always on before first sign-in** blocks all traffic, except to the account API for the service and the desktop app installed next to it (`apexy-app.exe` in the admin-only install directory), until the device is enrolled. This is by design, and the confirmation dialog explains it.
* **The development configuration** (`allowPrivateRelays`, `allowInsecureApi`, the WireGuard demo provisioner) must never ship. The API refuses to start in production with the demo provisioner; the service config is generated for development only.
