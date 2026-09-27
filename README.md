# Apexy VPN

A desktop VPN client for Windows (macOS and Linux as typed integration points), its privileged service, and the account backend.

The product rule: **the app never shows a state, a measurement or a protection that the system didn't actually observe.** "Protected" means the service saw a WireGuard handshake *and* a probe through the tunnel. A check that can't be done says "unable to verify" and explains why.

## What's here

| Path | What it is |
|---|---|
| `crates/vpn-types` | Shared types: service protocol, settings, tunnel states, errors. Exports TypeScript via ts-rs. |
| `crates/vpn-core` | Platform-free logic: tunnel state machine, firewall policy, server selection, signed relay list, reconnect, auto-connect. |
| `crates/vpn-platform` | OS integration. Windows: WireGuardNT, WFP kill switch, DNS, routes, network monitor, DPAPI keystore. |
| `crates/vpn-ipc` | JSON-lines IPC over an ACL'd named pipe / Unix socket. |
| `crates/vpn-daemon` | `apexyd`, the privileged service (Windows service; foreground mode for development). |
| `crates/vpn-cli` | `apexy`, a command-line client (status, connect, servers, diagnostics, login). |
| `crates/vpn-node` | `apexy-node`, the agent on each VPN node: keeps kernel WireGuard's peers in step with the API ([deploy/node](deploy/node/README.md)). |
| `apps/desktop` | The desktop app: React UI (`src/`) and its Tauri Rust core (`src-tauri/`). |
| `server/api` | Account backend: Fastify + PostgreSQL (PGlite in development and tests). |
| `docs/` | Architecture, product map, security, setup and operations. |

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The data model, access gating and no-logs guarantees are in [docs/DATABASE.md](docs/DATABASE.md). The feature map with what is real and what is an integration point is [docs/PRODUCT.md](docs/PRODUCT.md).

## Quick start (Windows)

Prerequisites: Rust (stable, MSVC), Visual Studio C++ Build Tools, Node.js 22+, WebView2 (included in Windows 11).

```powershell
npm install
npm run dev:keys -w server/api     # dev signing keys and dev/service.json
npm run dev:seed -w server/api     # the development server list (WireGuard demo server)
npm run api:dev                    # account API on http://127.0.0.1:8787; register in the app
cargo build -p vpn-daemon -p vpn-cli
powershell -ExecutionPolicy Bypass -File scripts\dev-service.ps1   # the service, elevated
npm run tauri dev -w apps/desktop  # the desktop app
```

Only the UI, with no service or admin rights (a simulator with a permanent banner; never part of a production build):

```powershell
npm run dev:sim -w apps/desktop    # http://127.0.0.1:1420
```

The full walkthrough, including a local WireGuard server, is [docs/SETUP.md](docs/SETUP.md).

## Tests

```powershell
cargo test --workspace             # Rust: state machine, firewall policy, selection, IPC, platform (unprivileged)
npm test                           # backend (PGlite) and UI (vitest)
```

## Status

The first pass is one complete, real path: a WireGuard connection on Windows with the kill switch, DNS leak protection, signed server list, account and device enrollment, diagnostics, and the full UI. OpenVPN, IKEv2, split tunnelling enforcement, and the macOS and Linux platforms are typed integration points that report themselves as unavailable. They are never simulated. See [docs/PRODUCT.md](docs/PRODUCT.md).
