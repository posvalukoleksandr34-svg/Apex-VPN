#!/usr/bin/env bash
# Creates a deployment's settings from the templates in env/production:
#   stack.env, api.env, web.env, desktop-build.env  (0600, gitignored)
# with fresh secrets, your domain filled in, and the server list's public
# key in desktop-build.env. Existing files are never overwritten.
#
#   bash env/generate.sh production --domain example.com
#   bash env/generate.sh staging --domain staging.example.com   (Stripe test mode)
#
# Run it on the server: the secrets are made there and never leave it
# (except desktop-build.env, which holds no secret).
set -euo pipefail

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

target="${1:-}"
case "$target" in production | staging) shift ;; *) usage ;; esac
domain=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) domain="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
if [ -n "$domain" ] && ! [[ "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "--domain: a domain name like example.com" >&2
  exit 2
fi
command -v openssl >/dev/null || { echo "openssl is needed" >&2; exit 1; }

here="$(cd "$(dirname "$0")" && pwd)"
templates="$here/production"
out="$here/$target"
umask 077
mkdir -p "$out/secrets"

secret() { openssl rand -base64 32 | tr -d '\n'; }

# The Ed25519 public key for a 32-byte seed (what the API signs the server list with).
relay_public_key() {
  {
    printf '\x30\x2e\x02\x01\x00\x30\x05\x06\x03\x2b\x65\x70\x04\x22\x04\x20'
    printf '%s' "$1" | openssl base64 -d -A
  } | openssl pkey -inform DER -pubout -outform DER | tail -c 32 | openssl base64 -A
}

# A value from an env file (no sourcing: values may hold spaces).
value_of() {
  sed -n "s/^$2=//p" "$1" | tail -n 1
}

created=()
for name in stack api web desktop-build; do
  file="$out/$name.env"
  if [ -e "$file" ]; then
    echo "kept     env/${file#"$here/"} (exists; delete it to make a new one)"
    continue
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ACCESS_TOKEN_SEED= | RELAY_SIGNING_SEED= | DATA_ENCRYPTION_KEY= | WEB_SESSION_SECRET=) line="${line}$(secret)" ;;
      STRIPE_MODE=live) [ "$target" = staging ] && line="STRIPE_MODE=test" ;;
    esac
    if [ -n "$domain" ]; then line="${line//example.com/$domain}"; fi
    printf '%s\n' "$line"
  done <"$templates/$name.env.example" >"$file"
  chmod 600 "$file"
  created+=("$name")
  echo "created  env/${file#"$here/"}"
done

# The desktop app must trust the key this API signs the server list with.
seed="$(value_of "$out/api.env" RELAY_SIGNING_SEED)"
key_id="$(value_of "$out/api.env" RELAY_KEY_ID)"
relay_key="${key_id:-fleet-1}:$(relay_public_key "$seed")"
if [[ " ${created[*]} " == *" desktop-build "* ]]; then
  sed -i "s|^APEXY_RELAY_KEYS=\$|APEXY_RELAY_KEYS=$relay_key|" "$out/desktop-build.env"
fi

cat <<EOF

Server list key for the desktop app: $relay_key

Next:
  1. Fill in every <…> and empty value:  nano env/$target/api.env  (and stack.env)
  2. Put the database's CA certificate at env/$target/secrets/supabase-ca.crt
  3. Check:  bash env/check.sh $target
Keep a copy of api.env and web.env in a password manager.
EOF
