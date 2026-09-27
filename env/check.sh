#!/usr/bin/env bash
# Checks a deployment's settings before it goes live:
#   bash env/check.sh production      (or staging)
#
# - every file exists and only its owner can read it;
# - nothing is left from the templates (<…>, example.com, empty required values);
# - Stripe's key matches STRIPE_MODE, and the database certificate is in place;
# - if the API image is built, the API's own configuration check (the one
#   it runs at start, production rules included) passes.
# Exits non-zero when anything must be fixed.
set -uo pipefail

target="${1:-}"
case "$target" in production | staging) ;; *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
dir="$here/$target"
problems=0
warnings=0

bad() { echo "  ✗ $*"; problems=$((problems + 1)); }
warn() { echo "  ! $*"; warnings=$((warnings + 1)); }
ok() { echo "  ✓ $*"; }
value_of() { sed -n "s/^$2=//p" "$1" | tail -n 1; }

check_file() {
  local name="$1" file="$dir/$1.env" start=$problems
  shift
  echo "$name.env"
  if [ ! -f "$file" ]; then
    bad "missing: run bash env/generate.sh $target"
    return
  fi
  local mode
  mode="$(stat -c %a "$file" 2>/dev/null || echo 600)"
  [ "$mode" = 600 ] || [ "$mode" = 400 ] || bad "readable by others (mode $mode): chmod 600 $file"
  # Leftovers from the template, in settings (comments don't count).
  local leftover
  leftover="$(grep -v '^\s*#' "$file" | grep -E '<[a-z][a-z-]*>|example\.com' | cut -d= -f1 | tr '\n' ' ' || true)"
  [ -z "$leftover" ] || bad "still from the template: $leftover"
  local key
  for key in "$@"; do
    [ -n "$(value_of "$file" "$key")" ] || bad "$key is empty"
  done
  [ "$problems" -gt "$start" ] || ok "filled in"
}

check_file stack APP_DOMAIN API_DOMAIN TUNNEL_TOKEN APEXY_REGISTRY APEXY_VERSION
check_file web WEB_SESSION_SECRET
api_required=(PUBLIC_BASE_URL WEB_APP_URL TRUST_PROXY DATABASE_URL ACCESS_TOKEN_SEED RELAY_SIGNING_SEED RELAY_KEY_ID DATA_ENCRYPTION_KEY SMTP_URL MAIL_FROM)
api="$dir/api.env"
if [ -f "$api" ] && [ "$(value_of "$api" BILLING_PROVIDER)" = stripe ]; then
  api_required+=(STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_MONTHLY STRIPE_PRICE_ANNUAL)
fi
check_file api "${api_required[@]}"

if [ -f "$api" ]; then
  # Stripe: the key's mode must be the one this deployment declares.
  key="$(value_of "$api" STRIPE_SECRET_KEY)"
  mode="$(value_of "$api" STRIPE_MODE)"
  if [ -n "$key" ]; then
    case "$key" in
      sk_live_* | rk_live_*) key_mode="live" ;;
      sk_test_* | rk_test_*) key_mode="test" ;;
      *) key_mode="" ;;
    esac
    if [ -z "$key_mode" ]; then bad "STRIPE_SECRET_KEY isn't a secret (sk_…) or restricted (rk_…) key"
    elif [ "$key_mode" != "${mode:-live}" ]; then bad "STRIPE_SECRET_KEY is a $key_mode key but STRIPE_MODE is ${mode:-live}"
    fi
    [ "$target" = production ] && [ "$key_mode" = test ] && warn "production is on Stripe test mode: switch to live before taking payments"
  fi
  # The database certificate the connection string names.
  cert="$(value_of "$api" DATABASE_URL | sed -n 's|.*sslrootcert=/run/secrets/\([^&]*\).*|\1|p')"
  if [ -n "$cert" ]; then
    [ -s "$dir/secrets/$cert" ] || bad "the database certificate is missing: put it at env/$target/secrets/$cert"
  fi
  [ "$(value_of "$api" ADMIN_REQUIRE_MFA)" = false ] && warn "ADMIN_REQUIRE_MFA=false: staff tools work without two-step verification"
fi

echo "desktop-build.env (for the Windows build machine)"
db="$dir/desktop-build.env"
if [ -f "$db" ]; then
  [ -n "$(value_of "$db" APEXY_RELAY_KEYS)" ] || warn "APEXY_RELAY_KEYS is empty: run generate.sh, or use the key it printed"
  [ -n "$(value_of "$db" APEXY_SIGN_THUMBPRINT)$(value_of "$db" APEXY_SIGN_PFX)" ] || warn "no signing certificate yet (APEXY_SIGN_THUMBPRINT or APEXY_SIGN_PFX): fill it on the build machine"
  [ "$(value_of "$db" APEXY_API_URL)" = "$(value_of "$api" PUBLIC_BASE_URL)" ] || bad "APEXY_API_URL differs from the API's PUBLIC_BASE_URL"
else
  warn "missing (only needed to build the installer)"
fi

# The API's own check, when its image is here.
echo "the API's configuration check"
stack="$here/../deploy/app/stack.sh"
if [ "$problems" -gt 0 ]; then
  echo "  - skipped until the above is fixed"
elif ! command -v docker >/dev/null; then
  echo "  - skipped: docker isn't installed"
elif ! docker info >/dev/null 2>&1; then
  echo "  - skipped: docker isn't running (or needs sudo)"
elif ! out="$(bash "$stack" "$target" run --rm --no-deps -T api node -e "import('./dist/config.js').then(m => { m.loadConfig(); console.log('ok'); })" 2>&1)"; then
  if echo "$out" | grep -qiE "no such image|pull access denied|not found"; then
    echo "  - skipped: build the images first (bash deploy/app/stack.sh $target build)"
  else
    bad "the API refuses this configuration:"
    echo "$out" | grep -vE '^\s*$' | tail -n 12 | sed 's/^/      /'
  fi
else
  ok "the API accepts it (production rules included)"
fi

echo
if [ "$problems" -gt 0 ]; then
  echo "$problems to fix, $warnings warning(s)."
  exit 1
fi
echo "Ready ($warnings warning(s))."
