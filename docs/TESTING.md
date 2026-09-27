# Testing

## Automated

```powershell
cargo test --workspace   # Rust, unprivileged
npm test                 # backend (PGlite, in-process) and UI (vitest + jsdom)
```

| Suite | What it proves |
|---|---|
| `vpn-core` tunnel tests (fake platform, paused clock) | Every state transition: retries and backoff, protocol fallback, network loss and return, sleep/wake, stale handshakes, settings changes. "Connected" only after handshake + probe. The kill switch stays engaged through failures. A node's named resolver is used and permitted. |
| `vpn-core` firewall / selection / relay / settings | The firewall policy per phase and setting. Smart Connect scoring. Signature, rollback, expiry and metadata checks on the relay list. Settings validation. |
| `vpn-core` `api_contract` | The Rust verifier accepts a relay list exactly as the backend signs it (fixture regenerated with `UPDATE_FIXTURES=1 npm test -w server/api`). |
| `vpn-platform` (Windows, unprivileged) | Driver signature check and DLL load, network snapshot and primary-network choice, ICMP, DPAPI round-trip, installed apps, DNS probe. |
| `vpn-ipc` | Framing, request/response, event subscription, pipe ACL behaviour. |
| `vpn-daemon` | Store round-trips and corruption recovery, redacted log book, IP observations that aren't public are dropped. |
| `apexy-app` (app core) | The error shape the WebView receives. Which service requests page script may send. Account passthrough path rules. Attachment types. External link rules. Accepted API addresses. Tray icon rendering. |
| Backend: billing | Stripe against a fake Stripe API with real `Stripe-Signature`s: one customer per user; checkout vs portal; access only after the first payment; state read from Stripe, not the payload; user found via customer; bad or stale signatures refused; each event applied once; invoices recorded once; grace on failed payment; cancellation ends access; an older read never overwrites a newer one; 500 then retry; cancel at period end; account deletion cancels billing first (and refuses if it can't); the return page. |
| Backend | Auth flows (lockout, MFA, recovery codes, refresh rotation and reuse revocation), devices (idempotent and concurrent enrollment, limits, key ownership), relay list signing, subscriptions, support. |
| UI | `describe()` over every tunnel state: "Protected" only when connected, every key exists, blocking states always offer a way out. Locale parity (keys, placeholders, no copies of English) and that every key the code uses exists. Formatting never invents a value. The dashboard hero renders every state in English and Russian. |

## Live test (elevated, real network)

This path can't run in CI: it needs the service elevated and a real server. The procedure:

1. Start the backend and seed it (SETUP.md §3), then the service elevated (§4) and the app (§5).
2. Before connecting, arm a watchdog, because a failed tunnel with the kill switch on blocks the network:
   `Start-Sleep 300; target\debug\apexy.exe disconnect` (it uses the local pipe, which the kill switch never blocks).
3. Sign in; the app enrolls the device.
4. Press Connect. Then check:
   * the state goes connecting → connected;
   * an outside service sees the server's address as your exit IP;
   * web requests work;
   * the Security page's leak tests pass;
   * Diagnostics shows all green.
5. Disconnect from the app and confirm the internet is back.

**Last run (2026-09-26, Windows 11, demo.wireguard.com):**
* Connected in 1.05 s.
* Exit IP seen by api.ipify.org: 172.245.26.38, the demo server.
* HTTPS request: 204 in 0.9 s.
* Diagnostics: 8/8 working (DNS resolving via 1.1.1.1 through the tunnel, default route via tunnel, kill switch active, fresh handshake).
* Leak tests: DNS protected, IPv6 protected. IPv4 unable to verify, because the development API is local and can't see a public address (by design, see below).
* Disconnect from the app: clean; connectivity restored.

That run found and fixed three bugs:

| Symptom | Cause | Fix |
|---|---|---|
| Tunnel up, names don't resolve | The demo server runs no resolver at its gateway | Relay list field `dnsIpv4`; the demo entry names 1.1.1.1 |
| Handshake timeouts after hours idle | The demo server expires idle peers; nothing re-registered the key | Enrollment refreshes once per app start; the demo provisioner re-registers |
| Enrollment failed with HTTP 500 | The app enrolled twice at once, and the demo server reused an address still held by a stale device | Single-flight enrollment; concurrent same-key enrollment returns the winner; the demo provisioner retires the stale holder |

It also caught the app presenting the local API's view (127.0.0.1) as "your IP". The service now refuses non-public IP-check answers and says why.

## Packaging and startup (checked on the release build)

* **Installers** (`npm run release -w apps/desktop`): the NSIS and MSI files build.
  * The MSI tables contain `apexyd.exe`, `apexy.exe` and `wireguard.dll` next to the app. The sequence is StopServices → uninstall action → RemoveFiles → InstallFiles → install action, both actions deferred as LocalSystem, and `ALLUSERS=1`.
  * The NSIS script requests admin and includes the service hooks.
* **Signing coverage:** a recording `signtool` showed every file passing through `scripts/sign.ps1` and being verified. That covers the service, CLI, app, NSIS plugins and uninstaller, and both installers.
* **Launch to tray:**
  * The release app started with `--minimized` showed no window during 5 seconds of sampling every 50 ms. The only "visible" windows were two 16×16 layered tool windows owned by the framework, which aren't drawn and have no taskbar button.
  * A second launch exited and brought the first instance forward.
  * Enabling autostart wrote `HKCU\…\Run\Apexy VPN = …\apexy-app.exe --minimized`.

## Kill switch under service termination

`scripts/validate-killswitch.ps1` (elevated):
1. connects;
2. hard-kills `apexyd`;
3. probes for 10 seconds: HTTPS exit IP, DNS to 8.8.8.8, TCP to 1.1.1.1:443;
4. checks the persistent WFP filters survived;
5. lets the service come back (Windows recovery, or a restart in development) and checks it reconnects;
6. disconnects and checks the internet returns.

The report goes to `dev/killswitch-report.json`.

**Last run (2026-09-26, development build, "on while connected"):**
* Killed while connected; **42 Apexy VPN WFP filters were still present** after the crash.
* **0 of 10 probes leaked** over about 105 s with the service down: HTTPS exit IP, DNS to 8.8.8.8 and TCP to 1.1.1.1:443 were all blocked.
* The restarted service **resumed the connection by itself**; the exit IP was the VPN server's (172.245.26.38).
* After disconnect the real exit IP (194.230.145.48) was back.
* The script marked two steps as failed because its first exit-IP probe after connecting timed out. The script now retries that probe and bounds the probing to 12 s.

## Not yet covered

* "Always on" across a reboot.
* Running the installers on a clean machine (install, upgrade over a running service, uninstall).
* Stripe in test mode and live mode end to end (only the fake API so far).
* macOS and Linux (integration points).
* Stripe billing (adapter not built).
