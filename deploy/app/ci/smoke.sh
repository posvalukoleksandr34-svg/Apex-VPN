#!/usr/bin/env bash
# Smoke test of the production images, as deployed: the API in production
# mode on a real PostgreSQL, the dashboard, and Caddy with the stack's own
# Caddyfile. Checks that migrations apply, the pages render, and a visitor's
# address travels Cloudflare → Caddy → API as the stack intends.
#
# Needs Docker and the images apexy/api:smoke and apexy/web:smoke:
#   docker build -f deploy/app/Dockerfile.api -t apexy/api:smoke .
#   docker build -f deploy/app/Dockerfile.web -t apexy/web:smoke .
set -euo pipefail

repo="$(cd "$(dirname "$0")/../../.." && pwd)"
app="$repo/deploy/app"
net="apexy-smoke-$$"
work="$(mktemp -d)"
names=(pg api web caddy)

fail() {
  printf '\nFAIL: %s\n' "$*" >&2
  exit 1
}
cleanup() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    for n in "${names[@]}"; do
      printf '\n--- %s logs\n' "$n"
      docker logs "$n-$$" 2>&1 | tail -n 40 || true
    done
  fi
  for n in "${names[@]}"; do docker rm -f "$n-$$" >/dev/null 2>&1 || true; done
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

until_ok() {
  local secs="$1"
  shift
  local end=$((SECONDS + secs))
  until "$@" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$end" ] || return 1
    sleep 1
  done
}
key() { openssl rand -base64 32; }

docker network create "$net" >/dev/null

echo "== PostgreSQL"
docker run -d --name "pg-$$" --network "$net" --network-alias pg -e POSTGRES_PASSWORD=smoke postgres:16-alpine >/dev/null
until_ok 60 docker exec "pg-$$" pg_isready -U postgres || fail "PostgreSQL didn't start"

echo "== API (production mode)"
docker run -d --name "api-$$" --network "$net" --network-alias api -p 127.0.0.1:18787:8787 \
  -e NODE_ENV=production \
  -e DATABASE_URL=postgres://postgres:smoke@pg:5432/postgres \
  -e PUBLIC_BASE_URL=https://api.apexy.test -e WEB_APP_URL=https://app.apexy.test \
  -e TRUST_PROXY=loopback,uniquelocal \
  -e ACCESS_TOKEN_SEED="$(key)" -e RELAY_SIGNING_SEED="$(key)" -e DATA_ENCRYPTION_KEY="$(key)" \
  -e NODE_PROVISIONING=agent \
  -e MAIL_TRANSPORT=smtp -e SMTP_URL=smtp://mail.invalid:587 -e MAIL_FROM="Apexy VPN <no-reply@apexy.test>" \
  -e BILLING_PROVIDER=manual \
  apexy/api:smoke >/dev/null
until_ok 90 curl -sf http://127.0.0.1:18787/v1/health || fail "the API didn't become healthy"
curl -sf http://127.0.0.1:18787/v1/subscription/plans | grep -q '"id":"monthly"' || fail "plans missing: migrations didn't apply"
[ "$(docker exec "api-$$" id -u)" != 0 ] || fail "the API runs as root"
echo "healthy; migrations applied; not root"

echo "== Dashboard"
docker run -d --name "web-$$" --network "$net" --network-alias web -p 127.0.0.1:13000:3000 \
  -e API_INTERNAL_URL=http://api:8787 -e WEB_SESSION_SECRET="$(key)" \
  apexy/web:smoke >/dev/null
until_ok 60 curl -sf http://127.0.0.1:13000/login || fail "the dashboard didn't start"
curl -s -D "$work/h" -o "$work/login.html" http://127.0.0.1:13000/login
grep -qi '^content-security-policy:.*nonce-' "$work/h" || fail "no nonce CSP on the page"
grep -q 'Apexy VPN' "$work/login.html" || fail "the sign-in page didn't render"
docker exec "web-$$" node -e "fetch('http://api:8787/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" || fail "the dashboard can't reach the API"
echo "renders with a nonce CSP; reaches the API"

echo "== Caddy (the stack's Caddyfile)"
docker run -d --name "caddy-$$" --network "$net" -p 127.0.0.1:18080:80 \
  -e APP_DOMAIN=app.apexy.test -e API_DOMAIN=api.apexy.test \
  -v "$app/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.10-alpine >/dev/null
until_ok 30 curl -sf -H "Host: app.apexy.test" http://127.0.0.1:18080/login || fail "Caddy doesn't serve the dashboard"
seen="$(curl -sf -H "Host: api.apexy.test" -H "Cf-Connecting-Ip: 203.0.113.50" http://127.0.0.1:18080/v1/network/ip)"
echo "$seen" | grep -q '"ip":"203.0.113.50"' || fail "the API saw $seen, not the visitor's address"
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: elsewhere.test" http://127.0.0.1:18080/)"
[ "$code" = 404 ] || fail "an unknown name answered $code"
echo "visitor address reaches the API; unknown names get 404"

echo "== Option B Caddyfile and compose files"
mkdir -p "$work/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=apexy.test" -keyout "$work/certs/origin.key" -out "$work/certs/origin.pem" 2>/dev/null
docker run --rm -e APP_DOMAIN=app.apexy.test -e API_DOMAIN=api.apexy.test \
  -v "$app/Caddyfile.direct:/etc/caddy/Caddyfile:ro" -v "$work/certs:/certs:ro" \
  caddy:2.10-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null || fail "Caddyfile.direct doesn't validate"
echo "valid"

echo "== Settings: env/generate.sh, then env/check.sh with the API's own production check"
prod="$repo/env/production"
trap 'code=$?; rm -rf "$prod"/*.env "$prod/secrets"; (exit $code); cleanup' EXIT
bash "$repo/env/generate.sh" production --domain apexy.test >/dev/null
[ "$(stat -c %a "$prod/api.env")" = 600 ] || fail "generate.sh left api.env readable by others"
grep -q '^APEXY_RELAY_KEYS=fleet-1:.\{44\}$' "$prod/desktop-build.env" || fail "generate.sh didn't fill the server list key"
if bash "$repo/env/check.sh" production >/dev/null; then fail "check.sh passed settings that still hold placeholders"; fi
# What an operator fills in by hand.
sed -i 's/^TUNNEL_TOKEN=$/TUNNEL_TOKEN=placeholder/' "$prod/stack.env"
sed -i 's/<project-ref>/abcdefgh/; s/<database-password>/secret/; s/<smtp-user>/user/; s/<smtp-password>/pass/; s/<smtp-host>/smtp.example.org/;
  s/^STRIPE_SECRET_KEY=$/STRIPE_SECRET_KEY=rk_live_x/; s/^STRIPE_WEBHOOK_SECRET=$/STRIPE_WEBHOOK_SECRET=whsec_x/;
  s/^STRIPE_PRICE_MONTHLY=$/STRIPE_PRICE_MONTHLY=price_m/; s/^STRIPE_PRICE_ANNUAL=$/STRIPE_PRICE_ANNUAL=price_a/' "$prod/api.env"
echo "-----BEGIN CERTIFICATE-----" >"$prod/secrets/supabase-ca.crt"
# The images under the names stack.env points at (local/apexy-*:dev).
docker tag apexy/api:smoke local/apexy-api:dev
docker tag apexy/web:smoke local/apexy-web:dev
report="$(bash "$repo/env/check.sh" production)" || { echo "$report"; fail "check.sh refused filled-in settings"; }
echo "$report" | grep -q "the API accepts it" || { echo "$report"; fail "the API's own configuration check didn't run"; }
bash "$app/stack.sh" production config -q || fail "compose.yaml doesn't validate with the generated settings"
APEXY_DIRECT=1 bash "$app/stack.sh" production config -q || fail "compose.direct.yaml doesn't validate"
echo "generated, checked, accepted by the API, and compose resolves them"

printf '\nAll smoke checks passed.\n'
