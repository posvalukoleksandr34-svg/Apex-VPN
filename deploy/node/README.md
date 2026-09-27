# VPN node

A node is a Linux server running kernel WireGuard (`wg0`), a firewall, a
resolver and **`apexy-node`**. The agent keeps `wg0`'s peers identical to
the API's peer set: the devices of accounts that have access and aren't
banned.

| File | Installed as |
|---|---|
| `wg0.conf` | `/etc/wireguard/wg0.conf`: gateway `10.64.0.1/10`, `fc00:bbbb:bbbb:bb01::1/64`, port 51820, no peers, `SaveConfig = false` |
| `apexy.nft` | `/etc/nftables.d/apexy.nft`: NAT; clients reach the internet and the resolver only |
| `90-apexy.conf` | `/etc/sysctl.d/`: forwarding |
| `unbound-apexy.conf` | `/etc/unbound/unbound.conf.d/apexy.conf`: the resolver at the gateway, no query logs |
| `apexy-node.service` | `/etc/systemd/system/`: the agent, as a throwaway user with `CAP_NET_ADMIN` only |
| `setup.sh` | Installs all of the above |
| `ci/` | The end-to-end test CI runs on Linux |

## How peers stay in step

```
API ──(long-poll GET /v1/nodes/self/peers?since=<version>&wait=25)──► apexy-node ──wg set──► wg0
 ▲                                                                        │
 └───────────────(POST /v1/nodes/self/heartbeat, every 60 s)──────────────┘
```

* **Instant for API changes.** Enrolling a device, revoking one, rotating a key, deleting an account, and any Stripe event that changes access all wake every waiting node. The node applies the change within milliseconds. Removing a peer ends its tunnel at once.
* **Seconds for the rest.** A ban made in plain SQL, or a subscription period running out, is picked up by the API's re-check every 2 s.
* **Self-healing.** After every answer (at least every 25 s), the agent reads the interface and puts right anything that differs: a peer added by hand, peers lost when `wg0` restarted.
* **The node checks what it's given.** It only accepts single addresses inside the tunnel pools (never a route like `0.0.0.0/0`, never the gateway) and well-formed keys. Anything else is left out and counted in the log.

### When things go wrong

| Situation | What the node does |
|---|---|
| API unreachable | Keeps the last peer set, so users stay connected, and retries with backoff (1 s up to 30 s). |
| API unreachable for longer than `APEXY_NODE_MAX_STALE_SECS` (default 900) | Removes every peer: it can no longer tell who has lost access. The peers come back when the API answers. |
| Token refused (node retired, token rotated) | Removes every peer at once and retries every 30 s. It re-reads the token file each time. |
| `wg` fails | Logs it and retries in 2 s. |
| Agent stopped or restarted | Peers stay as they are, so an upgrade disconnects nobody. To take a node out of service, stop WireGuard (`systemctl stop wg-quick@wg0`). |

## Setting up a node

On the API side, register the node. Its token goes to a new file:

```bash
npm run node:add -w server/api -- --id de-fra-001 --hostname de-fra-001.example.net \
  --ipv4 203.0.113.10 --ipv6 2001:db8::10 --location de-fra \
  --country-code DE --country Germany --city Frankfurt --lat 50.11 --lon 8.68 \
  --token-out de-fra-001.token
```

Build the agent on Linux (`cargo build --release -p vpn-node`, which produces `target/release/apexy-node`). Then copy this folder, the binary and the token to the node (Debian 12 or Ubuntu 24.04), and as root:

```bash
bash setup.sh --api https://api.example.com --token de-fra-001.token --binary apexy-node
shred -u de-fra-001.token
```

* **SSH.** It keeps SSH open on the ports `sshd` is configured with. Pass `--ssh-port 2222` if yours differs.
* **The node's WireGuard key.** It's generated on the node and never leaves it. The first heartbeat introduces the public key to the API, and the node then appears in the relay list as long as its heartbeats are fresh. To replace the key, clear `fleet.servers.wg_public_key` for the node; changing it is an operator action.
* **IPv6.** Without IPv6 on the node, the tunnel carries IPv4 only. Clients hold IPv6 in their kill switch, so it doesn't leak.

## Operating

* **Logs:** `journalctl -u apexy-node`. The agent logs counts ("added=1 removed=0 peers=412"), never keys or addresses.
* **Rotate a token:** `npm run node:add -w server/api -- --id de-fra-001 --rotate-token --token-out new.token`. Install it as `/etc/apexy/node-token` (0600), then `systemctl restart apexy-node`. Until then, the node removes its peers.
* **Retire a node:**
  1. Set `fleet.servers.status` to `maintenance`. Connected apps move their session to another server when they next refresh the server list, and no new connection picks the node.
  2. Stop WireGuard on it.
  3. Rotate its token without installing the new one, or delete the row.
* **Tuning** (`/etc/apexy/node.env`): `APEXY_NODE_MAX_STALE_SECS`, `APEXY_NODE_HEARTBEAT_SECS`; `APEXY_NODE_LOG=debug` for more detail.

## Privacy

* **The agent** asks `wg` for allowed IPs, handshake times and the public key only. It never reads peer endpoints (where users connect from) or the private key.
* **Heartbeats** report which keys had a handshake in the last 3 minutes. The API holds that in memory to show users which devices are connected, and stores nothing.
* **Peers** are never written to disk (`SaveConfig = false`), and the firewall and resolver don't log.

## Scale

Every node holds every entitled device, and each change sends the whole set. That's fine into the tens of thousands of devices. Beyond that, the next steps would be deltas between versions, gzip, or giving each node only its region's devices.

## Tests

* **Unit tests:** `cargo test -p vpn-node` (peer checks, diffs, `wg` output parsing, failure policies).
* **End to end:** `.github/workflows/node.yml` runs `ci/e2e.sh` on an Ubuntu runner. That covers the API, `setup.sh`, the systemd unit, and a client in a network namespace connecting through the real tunnel. It proves:
  * revoking access ends the tunnel;
  * the firewall confines clients;
  * heartbeats report the live tunnel;
  * nothing identifying is logged;
  * token refusal, outages and staleness behave as above.
