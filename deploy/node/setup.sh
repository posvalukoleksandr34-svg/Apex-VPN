#!/usr/bin/env bash
# Sets up an Apexy VPN node: WireGuard (wg0), the firewall, the resolver and
# apexy-node. Debian 12 or Ubuntu 24.04, as root, from this folder:
#
#   ./setup.sh --api https://api.example.com --token ./de-fra-001.token --binary ./apexy-node
#
# The token comes from `npm run node:add` on the API side. Safe to run again:
# it keeps the node's WireGuard key and updates everything else.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
api="" token="" binary="" resolver=1 ssh_ports=""

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
  echo "Options: --api URL --token FILE --binary FILE [--ssh-port N[,N…]] [--no-resolver]"
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --api) api="${2:-}"; shift 2 ;;
    --token) token="${2:-}"; shift 2 ;;
    --binary) binary="${2:-}"; shift 2 ;;
    --ssh-port) ssh_ports="${2:-}"; shift 2 ;;
    --no-resolver) resolver=0; shift ;;
    *) usage ;;
  esac
done
if [ -z "$api" ] || [ -z "$token" ] || [ -z "$binary" ]; then usage; fi
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ -s "$token" ] || { echo "$token: no token" >&2; exit 1; }
[ -x "$binary" ] || { echo "$binary: not an executable" >&2; exit 1; }

step() { printf '\n== %s\n' "$*"; }

step "packages"
packages=(wireguard-tools nftables)
if [ "$resolver" -eq 1 ]; then packages+=(unbound); fi
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${packages[@]}" >/dev/null

step "WireGuard"
install -d -m 0700 /etc/wireguard /etc/apexy
if [ ! -s /etc/wireguard/private.key ]; then
  (umask 077 && wg genkey > /etc/wireguard/private.key)
fi
conf="$(cat "$here/wg0.conf")"
if [ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo 1)" = 1 ]; then
  echo "IPv6 is off on this machine: the tunnel carries IPv4 only"
  conf="${conf//, fc00:bbbb:bbbb:bb01::1\/64/}"
fi
(umask 077 && printf '%s\n' "$conf" > /etc/wireguard/wg0.conf)

step "routing"
install -m 0644 "$here/90-apexy.conf" /etc/sysctl.d/90-apexy.conf
sysctl -q --system

step "firewall"
# Keep SSH open: --ssh-port, else the ports sshd is configured with, else 22.
if [ -z "$ssh_ports" ]; then
  mkdir -p /run/sshd
  ssh_ports="$(sshd -T 2>/dev/null | awk '/^port /{print $2}' | paste -sd, - || true)"
fi
ssh_ports="${ssh_ports:-22}"
[[ "$ssh_ports" =~ ^[0-9]+(,[0-9]+)*$ ]] || { echo "--ssh-port: port numbers, comma-separated" >&2; exit 2; }
install -d -m 0755 /etc/nftables.d
sed "s/tcp dport 22 accept/tcp dport { ${ssh_ports} } accept/" "$here/apexy.nft" > /etc/nftables.d/apexy.nft
chmod 0644 /etc/nftables.d/apexy.nft
[ -f /etc/nftables.conf ] || printf '#!/usr/sbin/nft -f\nflush ruleset\n' > /etc/nftables.conf
grep -qF 'include "/etc/nftables.d/*.nft"' /etc/nftables.conf || printf '\ninclude "/etc/nftables.d/*.nft"\n' >> /etc/nftables.conf
nft -c -f /etc/nftables.conf
systemctl enable -q nftables
systemctl restart nftables
echo "SSH stays open on port(s) ${ssh_ports} (from outside the tunnel). If you use another port, run again with --ssh-port before closing this session."

if [ "$resolver" -eq 1 ]; then
  step "resolver"
  install -m 0644 "$here/unbound-apexy.conf" /etc/unbound/unbound.conf.d/apexy.conf
  unbound-checkconf >/dev/null
  systemctl enable -q unbound
  systemctl restart unbound
fi

step "apexy-node"
install -m 0600 "$token" /etc/apexy/node-token
printf 'APEXY_NODE_API=%s\n' "$api" > /etc/apexy/node.env
chmod 0644 /etc/apexy/node.env
install -m 0755 "$binary" /usr/local/bin/apexy-node
install -m 0644 "$here/apexy-node.service" /etc/systemd/system/apexy-node.service
systemctl daemon-reload
systemctl enable -q wg-quick@wg0 apexy-node
systemctl restart wg-quick@wg0
systemctl restart apexy-node

step "done"
echo "Node public key: $(wg show wg0 public-key)"
echo "The node introduces it to the API with its first heartbeat. Follow the agent with: journalctl -u apexy-node -f"
