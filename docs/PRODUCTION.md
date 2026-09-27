# Going to production

From an empty server to taking real payments. Every file referenced is in `deploy/app/`; the reasoning behind each piece is in [SECURITY.md](SECURITY.md) and [DEPLOYMENT.md](DEPLOYMENT.md).

```
Browser ─┐                 ┌───────────────── web server (VPS, no open web ports) ─────────────────┐
Desktop  ├─▶ Cloudflare ─▶ │ cloudflared ─▶ Caddy ─┬─▶ web (Next.js dashboard) ─┐                   │
Nodes    ┘   (WAF, rate    │  (outbound tunnel)    └─▶ api (Fastify) ◀───────────┘ ─▶ Supabase (PG)  │
Stripe ──▶    limits)      └────────────────────────────────────────────────────────────────────────┘
                                                             │
VPN nodes (separate servers, WireGuard UDP, DNS-only) ◀──────┘ long-poll /v1/nodes/self/peers
```

## 1. Accounts you need

| Service | For | Notes |
|---|---|---|
| A VPS | API + dashboard | Ubuntu 24.04, 2 vCPU / 4 GB is plenty to start. Hetzner (Falkenstein, Nuremberg, Helsinki) or AWS `eu-west-1` (Ireland). Use a fresh server and IP, never used for anything else on your domain. |
| Supabase | PostgreSQL | Create the project in `eu-west-1` (or the region nearest the VPS). See [DATABASE.md](DATABASE.md#hosting-on-supabase). |
| Cloudflare | DNS, WAF, tunnel | The domain's nameservers on Cloudflare. |
| An SMTP provider | Verification and reset codes | Postmark, Amazon SES, Mailgun, Brevo or Resend. Set up SPF, DKIM and DMARC for the sending domain. |
| Stripe | Payments | Activate the account (business details, bank account) before live mode. |
| GitHub | CI and images | The `images` and `node` workflows run on push. |

## 2. The server

As root on the new VPS:

```bash
adduser deploy && usermod -aG sudo deploy          # log in as deploy from now on, with an SSH key
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh
apt-get update && apt-get install -y unattended-upgrades nftables git
curl -fsSL https://get.docker.com | sh                # Docker Engine + compose plugin (docs.docker.com/engine/install)
install -D -m 0644 /opt/apexy/deploy/app/firewall.nft /etc/nftables.d/apexy-app.nft   # after step 3's clone
```

The firewall allows SSH only. Narrow it to your own addresses, or put SSH behind Cloudflare Access.

## 3. Code and secrets

All settings live in `env/production/` ([env/README.md](../env/README.md)). The generator makes them from the templates, with fresh secrets, on the server:

```bash
sudo git clone https://github.com/<you>/<repo>.git /opt/apexy
cd /opt/apexy
bash env/generate.sh production --domain <your-domain>
```

This writes `env/production/stack.env`, `api.env`, `web.env` and `desktop-build.env` (0600, gitignored). They get:
* your domain;
* the three API keys and the dashboard's session secret;
* the server list's public key for the desktop app.

**What only you can fill in:**
* `stack.env`: `TUNNEL_TOKEN` (step 4).
* `api.env`:
  * `DATABASE_URL`: `<project-ref>`, `<database-password>`, and the region in the host.
  * `SMTP_URL`: the SMTP login, password and host.
  * The Stripe values (step 6). Until then, set `BILLING_PROVIDER=manual`.

The database certificate goes to `env/production/secrets/supabase-ca.crt` (Supabase → Project Settings → Database → SSL). Then check:

```bash
bash env/check.sh production
```

Keep `api.env` and `web.env` in a password manager: losing `DATA_ENCRYPTION_KEY` makes stored two-step secrets unreadable.

## 4. Cloudflare Tunnel

1. **Create the tunnel.** Zero Trust → Networks → Tunnels → Create a tunnel (Cloudflared). Copy its token into `env/production/stack.env` as `TUNNEL_TOKEN`.
2. **Public hostnames.** Add `app.<domain>` and `api.<domain>`, both pointing at service `HTTP` → `caddy:80`. Cloudflare creates the proxied DNS records itself.
3. **No other DNS record points at this server.** Not in this zone, not anywhere.

## 5. Start

```bash
cd /opt/apexy
bash env/check.sh production                                  # must end with "Ready"
sudo bash deploy/app/stack.sh production up -d --build
sudo install -m 0644 deploy/app/apexy-stack.service /etc/systemd/system/ && sudo systemctl enable apexy-stack
curl https://api.<domain>/v1/health                           # {"status":"ok",…}
```

After the images are built, `bash env/check.sh production` also runs the API's own configuration check (the production rules).

`deploy/app/stack.sh` is `docker compose` with the deployment's settings: `ps`, `logs -f api`, `exec …` all work through it. Migrations run when the API starts. To run images built by CI instead of building here, set `APEXY_REGISTRY=ghcr.io/<owner>` and `APEXY_VERSION=v1.0.0` in `env/production/stack.env`, then `sudo bash deploy/app/stack.sh production pull && sudo systemctl reload apexy-stack`.

**The first staff account:**
1. Register it on the dashboard.
2. Turn on two-step verification in the desktop app (Account → Security).
3. Grant the role:

   ```bash
   sudo bash deploy/app/stack.sh production exec api node dist/scripts/userRole.js --email you@<domain> --role admin
   ```

**VPN nodes** are separate servers: [deploy/node/README.md](../deploy/node/README.md). Register each from the `api` container. It has the same options as `npm run node:add`; the container is read-only, so the token goes to `/tmp` and you copy it out:

```bash
sudo bash deploy/app/stack.sh production exec api node dist/scripts/addNode.js --id de-fra-001 … --token-out /tmp/de-fra-001.token
sudo bash deploy/app/stack.sh production cp api:/tmp/de-fra-001.token . && sudo bash deploy/app/stack.sh production exec api rm /tmp/de-fra-001.token
```

## 6. Stripe: test first, then live

Run the whole flow in test mode on a staging copy (or locally), then switch.

**Locally:**

```bash
stripe listen --forward-to http://127.0.0.1:8787/v1/billing/webhooks/stripe   # prints the whsec_… to use
```

`server/api/.env.local`:
* `BILLING_PROVIDER=stripe`
* `STRIPE_SECRET_KEY=sk_test_…`
* `STRIPE_WEBHOOK_SECRET` (the one `stripe listen` printed)
* `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL`

Pay with `4242 4242 4242 4242`, then try the customer portal, a cancellation, and a refund from `/admin`.

**The settings, per environment** (`env/production/api.env`; a staging copy is made with `bash env/generate.sh staging`, which sets `STRIPE_MODE=test`):

| Setting | Staging (test mode) | Production (live mode) |
|---|---|---|
| `STRIPE_MODE` | `test` | `live` (the default; the API refuses a key from the other mode) |
| `STRIPE_SECRET_KEY` | `sk_test_…` or `rk_test_…` | a restricted `rk_live_…` key (permissions below) |
| `STRIPE_WEBHOOK_SECRET` | the test endpoint's `whsec_…` | the live endpoint's `whsec_…` |
| `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL` | test prices | live prices. Products and prices don't carry over from test mode: create them again, and the ids differ |
| `PUBLIC_BASE_URL`, `WEB_APP_URL` | staging names | production names |

**Switching to live, in the Stripe dashboard with Test mode off:**
1. **Products.** Create "Monthly" and "Annual" with recurring prices. Copy the `price_…` ids.
2. **Restricted key** (Developers → API keys → Create restricted key), write access to:
   * Customers
   * Checkout Sessions
   * Subscriptions
   * Customer portal
   * Refunds

   Read access to Invoices and Prices. Everything else: none.
3. **Webhook endpoint** (Developers → Webhooks → Add endpoint): `https://api.<domain>/v1/billing/webhooks/stripe`, listening to:
   * `checkout.session.completed`
   * `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`
   * `invoice.paid`, `invoice.payment_failed`

   Copy its signing secret.
4. **Customer portal** (Settings → Billing → Customer portal). It's configured separately in live mode. Allow:
   * payment-method updates;
   * invoice history;
   * cancellation (at period end);
   * switching between the two prices.
5. **Branding and receipts:** the statement descriptor, email receipts, and, if you need it, Stripe Tax.
6. **Deploy.** Put the live values in `env/production/api.env` (`STRIPE_MODE=live`), run `bash env/check.sh production`, then `sudo systemctl reload apexy-stack`. The API refuses to start if anything is missing or from the wrong mode.
7. **Prove it with real money:**
   * Buy the monthly plan with your own card. The dashboard shows "active" within seconds; the webhook did that.
   * Refund it from `/admin` (tick "also end the subscription"). Check Stripe shows the refund, and the account shows "Canceled".

The webhook secret can be rolled without downtime: Stripe signs with both secrets during the overlap, and the API accepts either.

## 7. Cloudflare checklist

**SSL/TLS**
* [ ] Mode **Full (strict)**; minimum TLS version 1.2; TLS 1.3 on.
* [ ] Always Use HTTPS on.
* [ ] HSTS on: 12 months, include subdomains. Add preload only once you're sure.

**Hiding the origin**
* [ ] Traffic comes through the tunnel; the server has no DNS record, and no inbound port but SSH (step 2).
* [ ] Check that no old or other DNS record ever pointed at this IP (historical DNS services show them). If one did, move to a fresh server.
* [ ] Restrict SSH to your addresses, or use Cloudflare Access for SSH.
* [ ] Assume the address can still leak (for example in the headers of mail submitted over SMTP). What makes that harmless is that nothing on it answers.

**WAF: managed rules**
* [ ] Cloudflare Managed Ruleset on (Free: the Free Managed Ruleset).
* [ ] On Pro or higher, also the OWASP Core Ruleset, starting at paranoia level 1 in log mode, then block.

**WAF: custom rules** (Security → WAF → Custom rules), in this order:
1. **Skip** for Stripe's webhooks: `http.host eq "api.<domain>" and http.request.uri.path eq "/v1/billing/webhooks/stripe"`. Skip managed rules and rate limiting; the API verifies Stripe's signature itself.
2. **Skip** for VPN nodes: `http.host eq "api.<domain>" and starts_with(http.request.uri.path, "/v1/nodes/")`. Nodes long-poll constantly from a few addresses; the API checks their tokens.
3. **Block** anything outside the API on its host: `http.host eq "api.<domain>" and not starts_with(http.request.uri.path, "/v1/")`.

**Rate limiting** (Security → WAF → Rate limiting rules). The API has its own per-client limits; these stop floods before they reach it.
* **Sign-in and account endpoints.**
  * Match: `(http.host eq "api.<domain>" and starts_with(http.request.uri.path, "/v1/auth/") and http.request.method eq "POST") or (http.host eq "app.<domain>" and http.request.method eq "POST" and http.request.uri.path in {"/login" "/register" "/forgot"})`.
  * Limit, per IP: on Free, 10 requests per 10 seconds, blocked for 10 seconds (the plan's fixed period); on Pro or higher, 30 per minute, blocked for 10 minutes.
* **Everything else on the API** (Pro or higher): 600 per minute per IP, blocking for 1 minute.

**Bots and challenges**
* [ ] Keep **Bot Fight Mode off**, and don't set JS challenges or "Under attack" mode on `api.<domain>`. The desktop app, VPN nodes and Stripe can't solve challenges, and would simply fail.
* [ ] Challenges on `app.<domain>` are fine, if ever needed.

**The staff pages**
* [ ] Optionally, put `app.<domain>/admin*` behind Cloudflare Access (Zero Trust → Access → Applications), with your staff emails and a one-time PIN. It's another lock in front of the role and two-step checks.

**Caching** (Caching → Cache Rules)
* [ ] Bypass cache for `api.<domain>`.
* [ ] On `app.<domain>`, cache only `/_next/static/*`: those files are immutable. Pages are per-user and must never be cached.

**Network**
* [ ] HTTP/3 and IPv6 on. WebSockets aren't used.

**VPN nodes**
* [ ] Their DNS names (if any) must be **DNS only** (grey cloud): WireGuard is UDP and can't go through Cloudflare's proxy.
* [ ] A node's address is public by design (the app connects to it); that's unrelated to the web origin.

## 8. Go-live checklist

**Accounts and mail**
* [ ] Sign-up, email code (arrives, in the right language, not in spam), sign-in, sign-out, password reset.

**Money**
* [ ] Live purchase and refund done (step 6). Stripe webhook deliveries succeed (Developers → Webhooks).

**Devices and nodes**
* [ ] A phone config from the dashboard connects through a real node.
* [ ] The desktop app, built with the production API URL and relay key, connects and passes Diagnostics.
* [ ] `/admin` works for the staff account, and 404s for others.
* [ ] The `node` and `images` CI workflows are green.

**Operations**
* [ ] Backups: Supabase daily backups or PITR on; a restore tried once. The `uploads` volume (support attachments) is in the server's backups.
* [ ] Monitoring: an uptime check on `https://api.<domain>/v1/health` and `https://app.<domain>/login` (Cloudflare Health Checks, or any uptime service).

## 9. Running it

**Update:**

```bash
cd /opt/apexy && sudo git pull && sudo bash deploy/app/stack.sh production up -d --build
```

With CI images: set the new `APEXY_VERSION`, then `docker compose pull` and `systemctl reload apexy-stack`.

**Roll back:**
* With CI images, set the previous `APEXY_VERSION` and reload. Migrations only ever add, so an older API runs on a newer schema.
* When building locally, check out the previous tag first.

**Logs:** `sudo bash deploy/app/stack.sh production logs -f api`. Requests are logged as method and path only. Caddy keeps no access log, and there is none of client addresses (see [DATABASE.md](DATABASE.md#no-logs)).

**Secrets:**
* Changing `WEB_SESSION_SECRET` signs everyone out of the dashboard.
* Changing `ACCESS_TOKEN_SEED` ends every app and dashboard session.
* The relay signing key needs an app release first (DEPLOYMENT.md).
