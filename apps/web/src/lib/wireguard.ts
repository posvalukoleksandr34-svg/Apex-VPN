import { x25519 } from "@noble/curves/ed25519.js";

/**
 * WireGuard keys and configs, made in the browser. The private key exists
 * only in the page (and the config the user saves); the server only ever
 * sees the public key.
 */

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(value: string): Uint8Array {
  const s = atob(value);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Curve25519 clamping, as `wg genkey` does, so the key is canonical everywhere. */
function clamp(key: Uint8Array): Uint8Array {
  key[0]! &= 248;
  key[31]! &= 127;
  key[31]! |= 64;
  return key;
}

export function publicKeyOf(privateKey: string): string {
  return toBase64(x25519.getPublicKey(fromBase64(privateKey)));
}

export function generateKeyPair(random: () => Uint8Array = () => x25519.utils.randomSecretKey()): { privateKey: string; publicKey: string } {
  const secret = clamp(random());
  const pair = { privateKey: toBase64(secret), publicKey: toBase64(x25519.getPublicKey(secret)) };
  secret.fill(0);
  return pair;
}

export interface ConfigServer {
  id: string;
  hostname: string;
  publicKey: string;
  endpoint: string;
  port: number;
  dns: string;
  ipv6: boolean;
}

export interface ConfigInput {
  privateKey: string;
  ipv4Address: string;
  ipv6Address: string | null;
  server: ConfigServer;
}

/** Comments may not break a line or carry anything but plain text. */
function comment(text: string): string {
  return text.replace(/[\r\n#]+/g, " ").trim().slice(0, 64);
}

/**
 * A wg-quick config. All traffic, IPv4 and IPv6, goes into the tunnel
 * (AllowedIPs 0.0.0.0/0, ::/0): on a server without IPv6 that traffic is
 * dropped rather than leaking outside the tunnel.
 */
export function buildConfig(i: ConfigInput): string {
  const v6 = i.ipv6Address && i.server.ipv6 ? [`${i.ipv6Address}/128`] : [];
  return [
    "[Interface]",
    `PrivateKey = ${i.privateKey}`,
    `Address = ${[`${i.ipv4Address}/32`, ...v6].join(", ")}`,
    `DNS = ${i.server.dns}`,
    "",
    "[Peer]",
    `# ${comment(`Apexy VPN ${i.server.hostname}`)}`,
    `PublicKey = ${i.server.publicKey}`,
    "AllowedIPs = 0.0.0.0/0, ::/0",
    `Endpoint = ${i.server.endpoint.includes(":") ? `[${i.server.endpoint}]` : i.server.endpoint}:${i.server.port}`,
    "PersistentKeepalive = 25",
    "",
  ].join("\n");
}

/**
 * The file name becomes the tunnel's name in WireGuard apps, and on Linux
 * the interface name: at most 15 characters from [A-Za-z0-9_=+.-].
 */
export function configFileName(serverId: string): string {
  const safe = serverId.replace(/[^A-Za-z0-9_=+.-]/g, "");
  return `${`apx-${safe}`.slice(0, 15)}.conf`;
}
