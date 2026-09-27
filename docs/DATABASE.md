# Database

PostgreSQL 16+, hosted anywhere, Supabase included. Only the API server (`server/api`) connects to it. The desktop app, the service and the VPN nodes reach data only through the API, so no database credential ever ships in a client.

Migrations live in `server/api/migrations/`. They're forward-only and applied at API start, one transaction each, recorded in `public.schema_migrations`. A migration that has been applied is never edited; changes go in a new file.

## Tables

The product's four core tables, and where each field lives:

| Concept | Table | Key columns |
|---|---|---|
| **users** | `identity.users` | `id` uuid · `email` (unique, case-insensitive) · `password_hash` (argon2id) · `role` (`user` \| `admin`) · `is_banned` · `email_verified_at` · TOTP secret (AES-GCM sealed) · `created_at`, `updated_at` |
| **subscriptions** | `billing.subscriptions` | `user_id` (one per user, cascade) · `plan_id` → `billing.plans` · `status` (`incomplete`, `trialing`, `active`, `past_due`, `canceled`, `expired`) · `current_period_end` · `cancel_at_period_end` · `provider`, `provider_ref` (the Stripe subscription id, unique) · `provider_synced_at` |
| | `billing.customers` | `user_id` → the Stripe customer id (`customer_ref`, unique) |
| | `billing.plans` | `id` · `period` · `price_cents` · `device_limit` · `stripe_price_id` |
| **servers** | `fleet.servers` | `id` · `hostname` · `location_id` → `fleet.locations` (country, city) · `ipv4`/`ipv6` · `status` · `capacity` · `wg_public_key` · `wg_ports` · tunnel gateway and resolver · `node_token_hash`; live load and health come from node heartbeats |
| **devices** | `ops.devices` | `id` · `user_id` (cascade) · `name` · `platform` · `wg_public_key` (unique among active devices) · `ipv4`/`ipv6` (tunnel addresses, unique among active devices) · `last_seen_on` (a **date**) · `revoked_at` |

Supporting tables:
* `identity.sessions`: refresh tokens, stored hashed, with rotation and reuse detection.
* `identity.email_tokens`: hashed verification and reset codes.
* `identity.recovery_codes`: hashed 2FA recovery codes.
* `billing.invoices`, `billing.payment_methods`: display data only (card brand, last 4 digits); card numbers never reach us.
* `billing.webhook_events`: ids of provider events already applied.
* `support.*`, `diag.reports`: tickets, and diagnostic reports the user chose to send.
* `notify.notifications`: in-app notices.

Schemas (`identity`, `billing`, `fleet`, `ops`, …) separate concerns. They also keep everything out of `public`, the schema Supabase's auto-generated API serves.

## How they interact

```
users ──1:1── subscriptions ──n:1── plans (device_limit, stripe_price_id)
  │                 ▲
  │                 └── Stripe webhooks keep it in sync (via billing.customers)
  ├──1:n── devices (WireGuard public key → tunnel address)
  └──1:n── sessions

servers ── pull their peer set: devices of users who aren't banned and whose subscription grants access
```

### Access gating

A subscription grants access when:
* its `status` is `trialing`, `active` or `past_due` (grace while Stripe retries a payment), **and**
* `current_period_end > now()`.

It's enforced in three places, so no single layer has to be trusted:

1. **Device registration** (`POST /v1/devices`). The API refuses without access. It signs the period end into the registration it returns (`validUntil`).
2. **The service** (`apexyd`) refuses to start a tunnel after `validUntil`, allowing 10 minutes of skew for a fast clock. It does so without engaging the kill switch. The app refreshes the registration at start and after a renewal.
3. **The VPN nodes** long-poll their peer set from `GET /v1/nodes/self/peers`. It contains only devices whose owner has access and isn't banned, so a lapsed or banned user's key stops working at the node, whatever the client does. A change made through the API (a Stripe event, a revoked device, a deleted account) reaches every node within milliseconds; one made in plain SQL, or a period running out, within about 3 seconds. See [deploy/node/README.md](../deploy/node/README.md).

The service never queries the database. Doing so would require a database credential inside every installed client.

### Device limits

`POST /v1/devices` counts the user's active (not revoked) devices against `plans.device_limit`: trial 2, paid 5.

Registering the same key again is idempotent, and it doesn't count twice. Revoking a device frees its slot, and its address is never reissued.

### Stripe synchronisation

`POST /v1/billing/webhooks/stripe` handles:
* `checkout.session.completed`
* `customer.subscription.created`, `updated`, `deleted`, `paused` and `resumed`
* `invoice.paid`, `invoice.payment_failed`

Processing works like this:

1. Each delivery's `Stripe-Signature` is verified: HMAC-SHA256 over `t.payload`, a 5-minute tolerance, and any of the `v1` values may match.
2. The subscription is read fresh from Stripe rather than trusted from the payload. The user is found by subscription metadata, then by customer. The plan is found by the price.
3. The result is written in **one transaction with the event's idempotency record**. A repeat delivery changes nothing; a failure answers 500, so Stripe retries.
4. An older read never overwrites a newer one (`provider_synced_at`).

Checkout for a user who already has a subscription opens the Customer Portal instead, so nobody is charged twice. Deleting an account cancels the Stripe subscription first.

### Bans

Set `identity.users.is_banned = true`, from any tool, SQL included. A trigger revokes all of the user's sessions in the same statement. From then on:
* sign-in answers `account_disabled`;
* access tokens are refused on their next use;
* the nodes drop the user's peers within about 3 seconds, which ends their tunnels.

`role` (`user` / `admin`) is stored for staff tooling; no endpoint grants anything by role yet.

## No-logs

The database holds account data, subscription state, the server list and WireGuard **public** keys: what routing and billing need. It holds **no** browsing history, visited URLs, DNS queries, traffic metadata, connection history or client IP addresses. Specifically:

* **No address columns.** No table has a column for where a user connects from. `ops.devices.ipv4`/`ipv6` are *tunnel* addresses the account assigns, not the user's location. `test/privacy.test.ts` fails if any address-, URL- or history-like column appears that hasn't been reviewed.
* **Day-level last-seen.** `ops.devices.last_seen_on` is a date, overwritten, not a log. A precise last-seen timestamp would itself be activity data.
* **Connected peers aren't stored.** Which peers are connected right now lives in API memory only, and is gone within minutes of disconnecting.
* **Request logs:** method and path only. No client address, port, headers or bodies; this is tested.
* **Rate limits:** the rate limiter keys on the client address **in memory only**, with a short window, and never writes it anywhere.
* **The IP check** (`/v1/network/ip`) answers the caller's address and stores nothing.

## Hosting on Supabase

1. **Create the project.** Use Postgres 15 or newer.
2. **Connection string.** `DATABASE_URL` is the **direct connection** or the **session pooler** (port 5432):

   ```
   postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=/etc/apexy/supabase-ca.crt
   ```

   Download the certificate from Project Settings → Database → SSL. Don't use the transaction pooler (port 6543): migrations run multi-statement transactions, and a long-lived API server gains nothing from it.
3. **Start the API.** Migrations create the schemas and tables on first start.
4. **API roles.** Migration 0004 revokes all access for Supabase's `anon` and `authenticated` roles on every schema the product uses, including tables created later. The auto-generated API and the anon key can't read anything.
5. **Leave Supabase's other features off** (Auth, Storage, the table editor's RLS toggles) for these schemas. The API server is the only client.
