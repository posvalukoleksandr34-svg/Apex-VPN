import type { RelayList } from "./types";
import type { ConfigServer } from "./wireguard";

/** One server with its location, flattened for lists and search. */
export interface ServerRow {
  id: string;
  hostname: string;
  status: "online" | "busy" | "maintenance" | "offline";
  load: number | null;
  features: string[];
  countryCode: string;
  country: string;
  city: string;
  /** Null when the server can't take WireGuard configs (no key published yet). */
  wireguard: ConfigServer | null;
}

export function serverRows(list: RelayList): ServerRow[] {
  const where = new Map(list.locations.map((l) => [l.id, l]));
  return list.servers
    .map((s) => {
      const loc = where.get(s.locationId);
      const wg = s.wireguard;
      return {
        id: s.id,
        hostname: s.hostname,
        status: s.status,
        load: s.load,
        features: s.features,
        countryCode: loc?.countryCode ?? "",
        country: loc?.country ?? "",
        city: loc?.city ?? "",
        wireguard:
          wg && wg.ports.length > 0
            ? { id: s.id, hostname: s.hostname, publicKey: wg.publicKey, endpoint: s.ipv4, port: wg.ports[0]!, dns: wg.dnsIpv4 ?? wg.gatewayIpv4, ipv6: !!wg.gatewayIpv6 }
            : null,
      };
    })
    .sort((a, b) => a.country.localeCompare(b.country) || a.city.localeCompare(b.city) || a.id.localeCompare(b.id));
}

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Every word of the query must match somewhere: country, city, server name,
 * country code or a feature (by id or by its name in the page's language).
 */
export function searchServers<T extends ServerRow>(rows: T[], query: string, featureNames: Record<string, string> = {}): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  return rows.filter((r) => {
    const hay = fold([r.country, r.city, r.hostname, r.id, r.countryCode, ...r.features, ...r.features.map((f) => featureNames[f] ?? "")].join(" "));
    return words.every((w) => hay.includes(w));
  });
}

/** Servers that can take a config right now: online first, then the least loaded. */
export function configurable<T extends ServerRow>(rows: T[]): T[] {
  const rank = { online: 0, busy: 1, maintenance: 2, offline: 3 } as const;
  return rows
    .filter((r) => r.wireguard && (r.status === "online" || r.status === "busy"))
    .sort((a, b) => rank[a.status] - rank[b.status] || (a.load ?? 50) - (b.load ?? 50));
}
