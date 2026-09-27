# Deployment

What a production release needs beyond the development setup. Items marked 🔌 are integration points that aren't built.

## Desktop (Windows)

### Build

```powershell
$env:APEXY_RELEASE = "1"                                   # strict: everything below is required
$env:APEXY_API_URL = "https://api.<your-domain>"           # baked into the service and the app
$env:APEXY_RELAY_KEYS = "fleet-1:<base64 Ed25519 public key>"  # keys that may sign the server list
$env:APEXY_SIGN_THUMBPRINT = "<SHA-1 of the code-signing certificate>"  # or APEXY_SIGN_PFX + _PASSWORD
npm run release -w apps/desktop
```

The output lands in `target/release/bundle/`:
* `nsis/Apexy VPN_<version>_x64-setup.exe`
* `msi/Apexy VPN_<version>_x64_en-US.msi`

`npm run release` uses `src-tauri/tauri.release.conf.json` on top of the base config, in this order:

1. **Prepare.** `scripts/prepare-bundle.ps1` builds `apexyd` (the service) and `apexy` (the CLI) in release mode, signs them, and stages them as Tauri sidecars.
2. **Build.** Tauri builds the app and bundles:
   * the sidecars and the signed `wireguard.dll` (from `vendor/wireguard-nt`, never rebuilt), all placed next to `apexy-app.exe`;
   * an NSIS and an MSI installer.
3. **Sign.** Tauri signs the app and both installers through `scripts/sign.ps1`.

Development builds (`npm run tauri dev`, `cargo build`) don't use the release config, so they don't need release binaries or a certificate.

### Code signing

`scripts/sign.ps1` is driven only by environment variables; nothing is stored in the repository.

| Variable | Purpose |
|---|---|
| `APEXY_SIGN_PFX`, `APEXY_SIGN_PFX_PASSWORD` | A `.pfx` certificate and its password (CI secrets) |
| `APEXY_SIGN_THUMBPRINT` | A certificate in the Windows store: EV certificates on a hardware token or HSM work this way |
| `APEXY_SIGN_TIMESTAMP_URL` | RFC 3161 timestamp server (default DigiCert) |
| `APEXY_SIGNTOOL` | Path to `signtool.exe` (default: newest Windows SDK) |
| `APEXY_RELEASE=1` | Fail the build when no certificate, API URL or relay key is configured |

Every signature uses SHA-256 and a timestamp, and is verified (`signtool verify /pa`) before the build continues. Without a certificate in a non-release build, it prints `not signing …` and continues.

The signtool call is the only thing to change for other signing services (Azure Trusted Signing, a cloud HSM).

### What the installers register

Both installers are per-machine, so they elevate through UAC.

| | NSIS (`installer-hooks.nsh`) | MSI (`service.wxs`) |
|---|---|---|
| Before files are replaced | `Stop-Service ApexyVPN` (upgrade: releases the locked `apexyd.exe`) | `ServiceControl Stop="both"` |
| After files are in place | `apexyd install` | deferred custom action `apexyd install` as LocalSystem |
| Before removal | `apexyd uninstall` | deferred custom action `apexyd uninstall` |

What the service commands do:

* **`apexyd install`** creates the service, or updates an existing one on upgrade. It is set to start automatically as LocalSystem, with restart-on-failure recovery (1 s, 5 s, 30 s; the count resets after a day), and then started.
* **`apexyd uninstall`** stops and deletes the service, then removes every Apexy VPN firewall filter.

**Drivers.** No separate driver installation is needed:
* The WireGuardNT driver ships inside the signed `wireguard.dll`, and installs itself the first time the service creates a tunnel adapter.
* The kill switch uses the Windows Filtering Platform, which is part of Windows.

The service checks the DLL's WireGuard LLC signature before loading it.

**Service configuration.**
* The API address and relay keys are baked in at build time.
* `%ProgramData%\Apexy VPN\service.json`, writable only by SYSTEM and Administrators, can override them.
* Development options (`allowPrivateRelays`, `allowInsecureApi`) are refused by release builds.

### Updates 🔌

Add `tauri-plugin-updater` with a signing key held offline and an HTTPS release feed. An update must go through the installer, whose hooks stop and re-register the service, so the running service binary is never replaced.

## Backend

* Node 22, PostgreSQL 16+ (`DATABASE_URL=postgres://…`). Migrations run at start, forward-only, one transaction each.
* **Secrets come from the environment or a secret manager, never from files in the repo:**
  * `ACCESS_TOKEN_SEED` (EdDSA JWT signing);
  * `DATA_ENCRYPTION_KEY` (AES-GCM for TOTP secrets);
  * `RELAY_SIGNING_SEED` / `RELAY_KEY_ID`. Prefer a KMS signer.

  Rotate the relay key by publishing the new public key in a client release before switching.
* `NODE_PROVISIONING=agent`. The API refuses `wireguard-demo` in production.
* Behind a TLS-terminating proxy. The IP-check endpoint must see the client's real public address, so set `TRUST_PROXY=true`, and only when the API is reachable exclusively through that proxy.
* Mail: replace the console mailer with an SMTP/API mailer.

### Stripe billing

`BILLING_PROVIDER=stripe`. The API refuses to start in production unless all of these are set:

| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_…` (or a restricted `rk_live_…` with Customers, Checkout Sessions, Subscriptions and Billing Portal) |
| `STRIPE_WEBHOOK_SECRET` | The endpoint's `whsec_…` |
| `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL` | Recurring prices (`price_…`) for the two paid plans |
| `PUBLIC_BASE_URL` | The API's public `https://` address (checkout and portal return to `/v1/billing/return`) |

In the Stripe dashboard:

1. **Products.** Create one product per plan, each with a recurring price, and put the price ids in the variables above.
2. **Webhook endpoint.** Point it at `https://<api>/v1/billing/webhooks/stripe` with these events:
   * `checkout.session.completed`
   * `customer.subscription.created`, `…updated`, `…deleted`, `…paused`, `…resumed`
   * `invoice.paid`, `invoice.payment_failed`
3. **Customer Portal.** Enable it, allowing payment-method updates, invoice history, cancellation, and switching between the two prices.

How it behaves:

* **Customers.** Each user maps to one Stripe customer (`billing.customers`).
* **Checkout.** Checkout starts a subscription. A user who already has one is sent to the portal instead, so nobody pays twice.
* **Webhooks.**
  * Deliveries are verified (`Stripe-Signature`, 5-minute tolerance, multiple `v1` for secret rotation).
  * State is read fresh from Stripe, not trusted from the payload, so late or out-of-order deliveries can't roll it back.
  * Each event is applied in one transaction with its idempotency record. Anything that isn't applied answers 500, so Stripe retries.
* **Access** follows the subscription:
  * `trialing`, `active` and `past_due` (grace) grant it until the period ends;
  * `incomplete`, `unpaid` and `canceled` don't.
* **Account deletion** cancels the Stripe subscription first. If Stripe can't confirm, the account isn't deleted.
* **Enforcement.**
  * **Nodes (the real enforcement):** they drop peers whose plan ended.
  * **Device enrollment:** it requires a valid plan.
  * **The service:** it refuses to start a connection past the registration's `validUntil`, without engaging the kill switch. If the plan ends mid-session, the kill switch keeps holding traffic. The app refreshes the registration after a renewal.

Tested against a fake Stripe API with real signatures (`server/api/test/billing.test.ts`). Before launch, run the flow once in Stripe **test mode** end to end (`stripe listen --forward-to …`), then in live mode with a real card and a refund.

## Nodes 🔌

An Apexy VPN node runs kernel WireGuard, a firewall, a resolver at its tunnel gateway and `apexy-node` (`crates/vpn-node`):
* it authenticates with its node token (`npm run node:add -w server/api` issues one);
* it long-polls its peer set from `/v1/nodes/self/peers`, so access changes reach it within milliseconds;
* it reports health and connected keys to `/v1/nodes/self/heartbeat`.

Setup, operations and failure behaviour: [deploy/node/README.md](../deploy/node/README.md).
