/**
 * DEVELOPMENT SIMULATOR ONLY. A made-up fleet for building the UI without a
 * service. Hostnames end in `.sim.invalid` and addresses are from the
 * documentation ranges (RFC 5737), so nothing here can be mistaken for, or
 * reach, a real server.
 */
import type { Location, RelayList, Server, ServerFeature } from "@/protocol";

const LOCATIONS: [string, string, string, string, number, number][] = [
  ["de-fra", "DE", "Germany", "Frankfurt", 50.11, 8.68],
  ["de-ber", "DE", "Germany", "Berlin", 52.52, 13.4],
  ["nl-ams", "NL", "Netherlands", "Amsterdam", 52.37, 4.9],
  ["gb-lon", "GB", "United Kingdom", "London", 51.51, -0.13],
  ["fr-par", "FR", "France", "Paris", 48.86, 2.35],
  ["it-mil", "IT", "Italy", "Milan", 45.46, 9.19],
  ["ch-zrh", "CH", "Switzerland", "Zurich", 47.38, 8.54],
  ["se-sto", "SE", "Sweden", "Stockholm", 59.33, 18.07],
  ["us-nyc", "US", "United States", "New York", 40.71, -74.01],
  ["us-lax", "US", "United States", "Los Angeles", 34.05, -118.24],
  ["ca-tor", "CA", "Canada", "Toronto", 43.65, -79.38],
  ["jp-tyo", "JP", "Japan", "Tokyo", 35.68, 139.69],
  ["sg-sin", "SG", "Singapore", "Singapore", 1.35, 103.82],
  ["au-syd", "AU", "Australia", "Sydney", -33.87, 151.21],
];

const FEATURES: ServerFeature[][] = [["streaming"], ["gaming", "low_latency"], ["privacy"], ["p2p"], ["streaming", "p2p"], []];

export function simulatedFleet(now: number): RelayList {
  const locations: Location[] = LOCATIONS.map(([id, countryCode, country, city, latitude, longitude]) => ({ id, countryCode, country, city, latitude, longitude }));
  const servers: Server[] = [];
  let n = 0;
  for (const [id] of LOCATIONS) {
    const count = id.startsWith("de") || id.startsWith("us") || id === "nl-ams" ? 3 : 2;
    for (let i = 1; i <= count; i++, n++) {
      servers.push({
        id: `${id}-00${i}`,
        hostname: `${id}-00${i}.sim.invalid`,
        locationId: id,
        status: n % 17 === 5 ? "maintenance" : n % 11 === 3 ? "busy" : "online",
        load: n % 17 === 5 ? null : (n * 37) % 90 + 5,
        capacity: 500,
        features: FEATURES[n % FEATURES.length]!,
        ipv4: `192.0.2.${10 + n}`,
        ipv6: null,
        wireguard: { publicKey: btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, k) => (k * 7 + n) % 256))), ports: [51820], gatewayIpv4: "10.64.0.1", gatewayIpv6: null, dnsIpv4: null },
        openvpn: null,
        ikev2: null,
        health: { measuredAt: now - 60_000, packetLoss: n % 13 === 0 ? 2.5 : 0, wireguardHealthy: true, openvpnHealthy: null, ikev2Healthy: null },
      });
    }
  }
  return { version: 1, generatedAt: now, expiresAt: now + 6 * 3600_000, locations, servers };
}
