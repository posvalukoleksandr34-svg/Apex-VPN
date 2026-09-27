/**
 * Every tunnel state the service can report, as runtime values. The
 * `Record<Union, true>` tables fail to compile when the Rust types gain a
 * variant, so tests that loop over these can't silently miss one.
 */
import type { ConnectPhase, ConnectTarget, ConnectedDetails, ErrorKind, ReconnectCause, RelaySummary, TunnelState } from "@/protocol";

const keys = <T extends string>(table: Record<T, true>) => Object.keys(table) as T[];

export const ERROR_KINDS = keys<ErrorKind>({
  auth_required: true,
  subscription_inactive: true,
  no_internet: true,
  server_unavailable: true,
  no_matching_server: true,
  relay_list_unavailable: true,
  relay_list_invalid: true,
  protocol_unavailable: true,
  permission_denied: true,
  driver_unavailable: true,
  handshake_timeout: true,
  tunnel_verification_failed: true,
  tunnel_failure: true,
  dns_failure: true,
  routing_failure: true,
  firewall_failure: true,
  timeout: true,
  configuration_corrupted: true,
  unsupported_platform: true,
  internal: true,
});

export const PHASES = keys<ConnectPhase>({
  waiting_to_retry: true,
  selecting_server: true,
  creating_interface: true,
  configuring_network: true,
  handshaking: true,
  verifying_tunnel: true,
  checking_tunnel: true,
});

export const CAUSES = keys<ReconnectCause>({
  network_changed: true,
  network_restored: true,
  woke_from_sleep: true,
  handshake_stale: true,
  server_unavailable: true,
  tunnel_failure: true,
  settings_changed: true,
  user_requested: true,
});

export const relay: RelaySummary = {
  serverId: "de-fra-001",
  hostname: "de-fra-001.example.test",
  countryCode: "DE",
  country: "Germany",
  city: "Frankfurt",
  protocol: "wireguard",
};

const target: ConnectTarget = { kind: "smart", mode: "best_overall", country: null, city: null, features: [] };

export const details: ConnectedDetails = {
  relay,
  endpoint: "203.0.113.10:51820",
  tunnelIpv4: "10.64.0.2",
  tunnelIpv6: null,
  dnsServers: ["10.64.0.1"],
  dnsMode: "vpn",
  mtu: 1420,
  interface: { name: "Apexy VPN", index: 42, luid: null },
  cipher: { handshake: "Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s", data: "ChaCha20-Poly1305", keyExchange: "Curve25519" },
  connectedAt: 1_700_000_000_000,
  lastHandshake: 1_700_000_000_000,
  protections: { killSwitch: true, dnsLeakBlocking: true, ipv6LeakBlocking: true, ipv6Tunneled: false, splitTunnel: "inactive" },
  localPublicKey: "bG9jYWw=",
  serverPublicKey: "c2VydmVy",
};

/** One of every shape, with both values of each boolean that matters. */
export function allStates(now = 1_700_000_000_000): { name: string; state: TunnelState }[] {
  const out: { name: string; state: TunnelState }[] = [];
  for (const lockedDown of [false, true]) out.push({ name: `disconnected lockedDown=${lockedDown}`, state: { state: "disconnected", lockedDown } });
  for (const blocking of [false, true]) {
    for (const phase of PHASES) {
      out.push({
        name: `connecting ${phase} blocking=${blocking}`,
        state: { state: "connecting", target, relay: null, attempt: 2, phase, blocking, lastError: "handshake_timeout", retryAt: phase === "waiting_to_retry" ? now + 4_200 : null },
      });
    }
    for (const cause of CAUSES) {
      out.push({
        name: `reconnecting ${cause} blocking=${blocking}`,
        state: { state: "reconnecting", target, relay, attempt: 1, cause, phase: "handshaking", blocking, lastError: null, retryAt: null },
      });
    }
    out.push({ name: `waiting_for_network blocking=${blocking}`, state: { state: "waiting_for_network", target, blocking } });
    for (const kind of ERROR_KINDS) {
      out.push({ name: `error ${kind} blocking=${blocking}`, state: { state: "error", error: { kind, detail: null, at: now }, blocking } });
    }
  }
  out.push({ name: "disconnecting", state: { state: "disconnecting", then: "nothing" } });
  out.push({ name: "connected", state: { state: "connected", details } });
  return out;
}
