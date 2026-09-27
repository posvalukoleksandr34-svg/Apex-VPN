#!/usr/bin/env bash
# End-to-end check of a node as deployed, on Linux with kernel WireGuard:
# the API (PGlite), setup.sh (wg-quick, firewall, the systemd unit) and a
# client in a network namespace connecting through the real tunnel.
#
# It rewires the machine's firewall and networking: run it on a throwaway
# VM or CI runner only. Needs sudo, systemd, Node 22, and a release build
# of apexy-node (cargo build --release -p vpn-node).
set -euo pipefail

repo="$(cd "$(dirname "$0")/../../.." && pwd)"
here="$repo/deploy/node/ci"
work="$(mktemp -d)"
api="http://127.0.0.1:8787"
ns="apexy-client"
account() { node "$here/account.mjs" "$@"; }
node_peers() { sudo wg show wg0 allowed-ips; }
in_client() { sudo ip netns exec "$ns" "$@"; }

step() { printf '\n== %s\n' "$*"; }
fail() {
  printf '\nFAIL: %s\n' "$*" >&2
  exit 1
}
on_exit() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    printf '\n--- apexy-node journal\n'
    sudo journalctl -u apexy-node --no-pager -o short-precise | tail -n 60 || true
    printf '\n--- API log (tail)\n'
    tail -n 60 "$work/api.log" || true
  fi
}
trap on_exit EXIT

# Waits up to $1 seconds for a command to succeed.
until_ok() {
  local secs="$1"
  shift
  local end=$((SECONDS + secs))
  until "$@" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$end" ] || return 1
    sleep 0.1
  done
}
has_peer() { node_peers | grep -qF "$1"; }
lacks_peer() { ! has_peer "$1"; }
ms() { date +%s%3N; }

export NODE_ENV=development
export DATABASE_URL="pglite://$work/db"
export NODE_PROVISIONING=agent
export RATE_LIMIT_ENABLED=false
export MAIL_TRANSPORT=console
export UPLOAD_DIR="$work/uploads"
ACCESS_TOKEN_SEED="$(openssl rand -base64 32)"
RELAY_SIGNING_SEED="$(openssl rand -base64 32)"
DATA_ENCRYPTION_KEY="$(openssl rand -base64 32)"
export ACCESS_TOKEN_SEED RELAY_SIGNING_SEED DATA_ENCRYPTION_KEY

start_api() {
  (cd "$repo/server/api" && exec npx tsx src/index.ts) >>"$work/api.log" 2>&1 &
  until_ok 60 curl -sf "$api/v1/health" || fail "the API didn't start"
}
stop_api() {
  pkill -f "src/index.ts" || true
  until_ok 15 bash -c "! curl -sf $api/v1/health" || fail "the API didn't stop"
}

step "register the node"
(cd "$repo/server/api" && npm run -s node:add -- --id ci-001 --hostname ci-001.test --ipv4 192.0.2.1 \
  --location ci-test --country-code DE --country Test --city CI --lat 0 --lon 0 --token-out "$work/node-token")

step "start the API"
start_api

step "set up the node (setup.sh)"
sudo bash "$repo/deploy/node/setup.sh" --api "$api" --token "$work/node-token" --binary "$repo/target/release/apexy-node" --no-resolver
# Heartbeat every 10 s so the test needn't wait a minute.
echo "APEXY_NODE_HEARTBEAT_SECS=10" | sudo tee -a /etc/apexy/node.env >/dev/null
sudo systemctl restart apexy-node
until_ok 20 bash -c "sudo journalctl -u apexy-node -o cat | grep -q 'syncing peers'" || fail "apexy-node didn't start"
agent_pid="$(systemctl show -p MainPID --value apexy-node)"
[ "$(ps -o uid= -p "$agent_pid" | tr -d ' ')" != 0 ] || fail "apexy-node runs as root"
until_ok 20 bash -c "[ \"\$(node $here/account.mjs node-key ci-001)\" = \"\$(sudo wg show wg0 public-key)\" ]" \
  || fail "the node's heartbeat didn't introduce its key"
node_key="$(sudo wg show wg0 public-key)"
echo "node key introduced; wg0 has $(node_peers | grep -c . || true) peers"

step "a client connects through the tunnel"
account create "$work/a.json" "$work/api.log"
client_key="$(wg genkey)"
client_pub="$(printf '%s' "$client_key" | wg pubkey)"
printf '%s' "$client_key" >"$work/client.key"
t0=$(ms)
client_ip="$(account enroll "$work/a.json" "$client_pub")"
until_ok 5 has_peer "$client_pub" || fail "the node didn't add the enrolled key"
echo "peer added $(($(ms) - t0)) ms after enrollment; tunnel address $client_ip"

sudo ip netns add "$ns"
sudo ip link add veth-node type veth peer name veth-client
sudo ip link set veth-client netns "$ns"
sudo ip addr add 192.0.2.1/24 dev veth-node
sudo ip link set veth-node up
in_client ip link set lo up
in_client ip addr add 192.0.2.2/24 dev veth-client
in_client ip link set veth-client up
in_client ip link add wgc type wireguard
in_client wg set wgc private-key "$work/client.key" peer "$node_key" endpoint 192.0.2.1:51820 allowed-ips 10.64.0.0/10
in_client ip addr add "$client_ip/32" dev wgc
in_client ip link set wgc up
in_client ip route add 10.64.0.0/10 dev wgc
until_ok 10 in_client ping -c1 -W1 10.64.0.1 || fail "no ping through the tunnel"
echo "ping through the tunnel works"

step "the firewall keeps clients to what they may reach"
# The API listens on the node, but not for the tunnel: the packet must be
# dropped (a timeout), not refused.
set +e
in_client timeout 3 bash -c 'exec 3<>/dev/tcp/10.64.0.1/8787'
rc=$?
set -e
[ "$rc" -eq 124 ] || fail "a client reached a port on the node (exit $rc)"
echo "the node's other ports are closed to clients"

step "the API sees the live tunnel (heartbeat)"
until_ok 25 bash -c "[ \"\$(node $here/account.mjs connected $work/a.json)\" = 1 ]" || fail "the device isn't reported connected"
echo "reported connected"

step "revoking access ends the tunnel at once"
t0=$(ms)
account delete "$work/a.json"
until_ok 5 lacks_peer "$client_pub" || fail "the node kept a deleted account's key"
echo "peer removed $(($(ms) - t0)) ms after the account was deleted"
if in_client ping -c1 -W1 10.64.0.1 >/dev/null 2>&1; then fail "the tunnel still carries traffic"; fi
echo "the tunnel is dead"

step "no keys or client addresses in the agent's log"
if sudo journalctl -u apexy-node -o cat | grep -qF -e "$client_pub" -e "192.0.2.2" -e "$client_ip"; then
  fail "the agent logged a key or an address"
fi
if grep -qF "192.0.2.2" "$work/api.log"; then fail "the API logged the client's endpoint"; fi
echo "clean"

step "restarting the agent keeps peers; a refused token removes them"
account create "$work/b.json" "$work/api.log"
key2="$(wg genkey | wg pubkey)"
account enroll "$work/b.json" "$key2" >/dev/null
until_ok 5 has_peer "$key2" || fail "the node didn't add the second key"
sudo systemctl stop apexy-node
has_peer "$key2" || fail "stopping the agent removed peers"
sudo cp /etc/apexy/node-token "$work/node-token.good"
openssl rand -base64 32 | sudo tee /etc/apexy/node-token >/dev/null
sudo systemctl start apexy-node
until_ok 10 lacks_peer "$key2" || fail "a refused token didn't remove the peers"
echo "refused token: peers removed"
sudo install -m 0600 "$work/node-token.good" /etc/apexy/node-token
sudo systemctl restart apexy-node
until_ok 10 has_peer "$key2" || fail "the peers didn't come back with the right token"
echo "right token: peers back"

step "an API outage: peers kept, then removed once the set is too old"
stop_api
sleep 3
has_peer "$key2" || fail "a short outage removed peers"
echo "APEXY_NODE_MAX_STALE_SECS=5" | sudo tee -a /etc/apexy/node.env >/dev/null
sudo systemctl restart apexy-node
until_ok 20 lacks_peer "$key2" || fail "a stale peer set wasn't removed"
echo "stale set: peers removed"
start_api
# The agent backs off while the API is down (up to 30 s between tries).
until_ok 45 has_peer "$key2" || fail "the peers didn't come back with the API"
echo "API back: peers back"

step "static checks"
sudo nft -c -f "$repo/deploy/node/apexy.nft"
echo "firewall rules parse"

printf '\nAll node checks passed.\n'
