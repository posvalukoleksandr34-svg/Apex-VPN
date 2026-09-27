#!/usr/bin/env bash
# docker compose for one deployment, with its settings from env/<target>:
#
#   bash deploy/app/stack.sh production up -d --build
#   bash deploy/app/stack.sh production ps
#   bash deploy/app/stack.sh production logs -f api
#   bash deploy/app/stack.sh production exec api node dist/scripts/userRole.js --email you@example.com --role admin
#
# The target defaults to production. APEXY_DIRECT=1 uses option B
# (compose.direct.yaml: port 443 with a Cloudflare Origin certificate from
# env/<target>/certs instead of the tunnel).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
target=production
case "${1:-}" in production | staging) target="$1"; shift ;; esac
envdir="$(cd "$here/../../env" && pwd)/$target"
if [ ! -f "$envdir/stack.env" ]; then
  echo "No settings in env/$target: run bash env/generate.sh $target --domain <your-domain>" >&2
  exit 1
fi

files=(-f "$here/compose.yaml")
if [ "${APEXY_DIRECT:-}" = 1 ]; then files+=(-f "$here/compose.direct.yaml"); fi

export APEXY_ENV_DIR="$envdir"
exec docker compose --project-name "apexy-$target" "${files[@]}" --env-file "$envdir/stack.env" "$@"
