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
* Behind a TLS-terminating proxy. Rate limits and the IP-check endpoint need the client's real address, so list the proxies whose `X-Forwarded-For` the API may believe:
  * `TRUST_PROXY=loopback,uniquelocal` when the reverse proxy and the web dashboard reach the API over loopback or a private network (the Docker setup);
  * or explicit addresses and CIDRs: `TRUST_PROXY=10.0.0.5,10.0.1.0/24`.

  `TRUST_PROXY=true` believes anyone; use it only if the proxy overwrites the header and nothing else can reach the API.
* `WEB_APP_URL=https://app.<your-domain>`: the web dashboard. Checkout and the billing portal send web customers back to `/billing` there.
* Mail: replace the console mailer with an SMTP/API mailer.

### Stripe billing

`BILLING_PROVIDER=stripe`. The API refuses to start in production unless all of these are set:

| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_…`, or better a restricted `rk_live_…`: write access to Customers, Checkout Sessions, Subscriptions, Customer portal and Refunds; read access to Invoices and Prices. `STRIPE_MODE` (default `live`) must match the key; `test` is for staging |
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

## Production stack

`deploy/app` has everything for one server:
* **Images:** the API and the dashboard (`Dockerfile.api`, `Dockerfile.web`).
* **Compose file:** with Caddy and a Cloudflare Tunnel, so no port is open.
* **Operations:** a systemd unit, and the env templates.

The walkthrough, including Stripe's switch from test to live and the Cloudflare checklist, is [PRODUCTION.md](PRODUCTION.md). CI (`.github/workflows/images.yml`) builds both images and smoke-tests them against PostgreSQL behind the stack's Caddyfile. On version tags it publishes them to GitHub's registry.

## Web dashboard

`apps/web`: Next.js, built as a self-contained server (`output: "standalone"`). It is where customers sign up, pay, and get WireGuard configs for phones and routers.

```bash
npm ci
npm run build -w apps/web
# Serve apps/web/.next/standalone/apps/web/server.js, with
# .next/static copied to .next/standalone/apps/web/.next/static
```

| Variable | Value |
|---|---|
| `API_INTERNAL_URL` | The API as the dashboard reaches it, over the private network: `http://api:8787` |
| `WEB_SESSION_SECRET` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts the session cookie; changing it signs everyone out |
| `DOWNLOAD_URL_WINDOWS` | Optional: the published Windows installer |
| `PORT`, `HOSTNAME` | Where `server.js` listens (default 3000, all interfaces) |

It needs:
* **HTTPS.** In production the session cookie is `__Host-`/`Secure`, and sign-in doesn't work over plain HTTP.
* **One instance, or sticky sessions.** Token refreshes are remembered in the process (see SECURITY.md).
* **The API configured for it:** `WEB_APP_URL` pointing at the dashboard, and `TRUST_PROXY` covering the dashboard's address.
* **Stripe's default domains.** Checkout and portal redirects are allowed to `checkout.stripe.com` and `billing.stripe.com` only. A custom Stripe domain needs adding in `apps/web/src/app/actions/billing.ts` and the CSP's `form-action`.

### Staff accounts

The admin pages (`/admin` in the dashboard) are for accounts with the `admin` role. To make one:
1. Register it like any account.
2. Turn on two-step verification in the desktop app (Account → Security). Production refuses staff tools without it (`ADMIN_REQUIRE_MFA`, default on in production).
3. Run, with the API's database configuration:

   ```bash
   npm run user:role -w server/api -- --email you@example.com --role admin
   ```

`--role user` takes it away. Refunds go through the Stripe account in `STRIPE_SECRET_KEY`; the "Open in Stripe" link follows test or live mode from the key.

## Nodes 🔌

An Apexy VPN node runs kernel WireGuard, a firewall, a resolver at its tunnel gateway and `apexy-node` (`crates/vpn-node`):
* it authenticates with its node token (`npm run node:add -w server/api` issues one);
* it long-polls its peer set from `/v1/nodes/self/peers`, so access changes reach it within milliseconds;
* it reports health and connected keys to `/v1/nodes/self/heartbeat`.

Setup, operations and failure behaviour: [deploy/node/README.md](../deploy/node/README.md).
