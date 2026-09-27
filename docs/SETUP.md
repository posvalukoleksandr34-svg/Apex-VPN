# Setup

How to get every part running on a Windows development machine. macOS and Linux can build and test the portable crates, the backend and the UI; the service reports the platform as unsupported there.

## 1. Prerequisites

| Tool | Why | Check |
|---|---|---|
| Rust stable (MSVC toolchain) | service, CLI, app core | `cargo --version` |
| Visual Studio 2022 Build Tools, "Desktop development with C++" | MSVC linker, Windows SDK | `link.exe` on PATH in a Developer prompt |
| Node.js 22+ | backend, UI, Tauri CLI | `node --version` |
| WebView2 Runtime | the app's UI engine (included in Windows 11) | — |
| Administrator rights | only to run the service (tunnel, firewall, DNS) | — |

The WireGuardNT driver ships as `wireguard.dll` in `vendor/wireguard-nt/` (the signed SDK, unpacked). The service loads it only by full path and only after WinVerifyTrust confirms the signer is WireGuard LLC.

## 2. Install and generate development secrets

```powershell
npm install
npm run dev:keys -w server/api
```

`dev:keys` writes, both gitignored:

* `server/api/.env.local`: token signing seed, relay-list signing seed, data encryption key, `NODE_PROVISIONING=wireguard-demo`.
* `dev/service.json`: the service's development configuration. It holds the API address, the relay-list public key (pinned), and `allowPrivateRelays` / `allowInsecureApi`. The last two exist only in development.

Nothing secret is committed or hardcoded. `-- --force` rotates the keys (sign in again afterwards).

## 3. Backend

```powershell
npm run dev:seed -w server/api   # first: PGlite allows one process, so not while the API runs
npm run api:dev                  # http://127.0.0.1:8787, PGlite database in server/api/.data
```

The seed adds the development fleet: the public WireGuard demo server (`demo.wireguard.com`). The demo server registers each device key on request and assigns an address in 192.168.4.0/24. It runs no DNS resolver, so its relay-list entry names one (`dnsIpv4: 1.1.1.1`, reached through the tunnel). It also expires idle peers; the app re-registers the device each time it starts. That lets the whole path (sign-in → enrollment → tunnel) work without running a VPN server of your own. It is development-only: the API refuses to start in production with `NODE_PROVISIONING=wireguard-demo`.

Accounts are never seeded. Register in the app; the development mailer prints the email verification code in the API's console. Registration starts the trial; a device can enroll once the email is verified.

OpenAPI: `npm run openapi -w server/api` regenerates `docs/openapi.json`.

## 4. The service

```powershell
cargo build -p vpn-daemon -p vpn-cli
powershell -ExecutionPolicy Bypass -File scripts\dev-service.ps1
```

The script asks for elevation and runs `apexyd foreground --config dev\service.json` in a window you can watch. Stop it with Ctrl+C, after disconnecting so the kill switch releases.

Check it from an ordinary (unelevated) prompt:

```powershell
target\debug\apexy.exe status
target\debug\apexy.exe login you@example.com   # enrolls this device without the app
target\debug\apexy.exe connect
target\debug\apexy.exe diagnostics
```

**If the network is ever left blocked** (a crash while the kill switch held traffic), run as administrator:

```powershell
target\debug\apexyd.exe reset-firewall
```

It removes every Apexy VPN filter, including the persistent ones.

To install it as a real Windows service (starts at boot; needed for "Always on"):

```powershell
target\debug\apexyd.exe install      # elevated
target\debug\apexyd.exe uninstall    # elevated; also removes firewall filters
```

## 5. The desktop app

```powershell
npm run tauri dev -w apps/desktop
```

This starts Vite on 127.0.0.1:1420 and the Tauri shell. The app finds the service over `\\.\pipe\apexy`. It shows "VPN service isn't running" with a retry button until the service is up.

The app learns the account API's address from the service. To sign in before the service has ever run, build the app with a fallback: `$env:APEXY_API_URL = "http://127.0.0.1:8787"` before `npm run tauri dev`. Plain `http` is accepted only for loopback addresses.

Where things live:

* Account session: Windows Credential Manager, entry `Apexy VPN / account-session`. It holds the refresh token and cached profile; the access token is kept only in memory.
* UI preferences: the WebView's local storage.
* Service settings, device key, logs: `%ProgramData%\Apexy VPN`, readable by SYSTEM and Administrators only. The device key is DPAPI-sealed.

### UI without the service

```powershell
npm run dev:sim -w apps/desktop
```

This opens `http://127.0.0.1:1420` in any browser, backed by a simulator: a permanent banner, fake servers, and a panel to inject failures (handshake errors, network loss, sleep/wake, service stop). The simulator is compiled in only in `--mode simulator`; production bundles don't contain it.

## 6. Building an installer

```powershell
cargo build --release -p vpn-daemon
npm run tauri build -w apps/desktop
```

The NSIS installer (per-machine) runs `apexyd.exe install` after copying files and `uninstall` before removing them (`apps/desktop/src-tauri/windows/installer-hooks.nsh`). Before a real release, bundle `apexyd.exe` and `wireguard.dll` as resources and sign every binary; see [DEPLOYMENT.md](DEPLOYMENT.md).

## 7. Tests

```powershell
cargo test --workspace
npm test
```

Rust tests run unprivileged. They cover the state machine against a fake platform, firewall policy, server selection, the signed relay list, IPC round-trips, and the Windows APIs that don't need elevation (signature check, DLL load, network snapshot, ICMP, DPAPI, installed apps). What needs a live elevated run is listed in [TESTING.md](TESTING.md).
