/**
 * Presentation helpers over the relay list: joining servers with their
 * locations, grouping by country, searching, filtering and sorting. The
 * actual Smart Connect choice is made by the service (vpn-core); the UI
 * ordering here only decides what to show first.
 */
import type { ConnectTarget, LatencySample, Location, RelayList, Server, ServerFeature, SmartMode } from "@/protocol";

export interface ServerView {
  server: Server;
  location: Location;
  latency: number | null;
}

export interface CountryGroup {
  countryCode: string;
  country: string;
  cities: { location: Location; servers: ServerView[] }[];
  servers: ServerView[];
  bestLatency: number | null;
  available: boolean;
}

export type SortKey = "best" | "latency" | "load" | "name";
export type FeatureFilter = ServerFeature | "all";

export function views(relays: RelayList | null, latencies: Record<string, LatencySample>): ServerView[] {
  if (!relays) return [];
  const loc = new Map(relays.locations.map((l) => [l.id, l]));
  return relays.servers.flatMap((server) => {
    const location = loc.get(server.locationId);
    if (!location) return [];
    const sample = latencies[server.id];
    return [{ server, location, latency: sample && !sample.viaTunnel ? sample.rttMs : null }];
  });
}

export const isAvailable = (v: ServerView) => v.server.status === "online" || v.server.status === "busy";

/** Display score: measured latency and load, both only when known. */
function displayScore(v: ServerView): number {
  const lat = v.latency ?? 400;
  const load = v.server.load ?? 50;
  return lat * 0.6 + load * 1.2 + (isAvailable(v) ? 0 : 10_000);
}

export function sortViews(list: ServerView[], key: SortKey, locale?: string): ServerView[] {
  const byName = (a: ServerView, b: ServerView) =>
    a.location.country.localeCompare(b.location.country, locale) || a.location.city.localeCompare(b.location.city, locale) || a.server.id.localeCompare(b.server.id);
  const copy = [...list];
  switch (key) {
    case "latency":
      return copy.sort((a, b) => (a.latency ?? Infinity) - (b.latency ?? Infinity) || byName(a, b));
    case "load":
      return copy.sort((a, b) => (a.server.load ?? Infinity) - (b.server.load ?? Infinity) || byName(a, b));
    case "name":
      return copy.sort(byName);
    case "best":
      return copy.sort((a, b) => displayScore(a) - displayScore(b) || byName(a, b));
  }
}

export function filterViews(list: ServerView[], query: string, feature: FeatureFilter): ServerView[] {
  const q = query.trim().toLowerCase();
  return list.filter((v) => {
    if (feature !== "all" && !v.server.features.includes(feature)) return false;
    if (!q) return true;
    return [v.location.country, v.location.city, v.location.countryCode, v.server.id, v.server.hostname].some((x) => x.toLowerCase().includes(q));
  });
}

export function groupByCountry(list: ServerView[], locale?: string): CountryGroup[] {
  const groups = new Map<string, CountryGroup>();
  for (const v of list) {
    let g = groups.get(v.location.countryCode);
    if (!g) {
      g = { countryCode: v.location.countryCode, country: v.location.country, cities: [], servers: [], bestLatency: null, available: false };
      groups.set(v.location.countryCode, g);
    }
    g.servers.push(v);
    if (isAvailable(v)) g.available = true;
    if (v.latency !== null && (g.bestLatency === null || v.latency < g.bestLatency)) g.bestLatency = v.latency;
    let city = g.cities.find((c) => c.location.id === v.location.id);
    if (!city) {
      city = { location: v.location, servers: [] };
      g.cities.push(city);
    }
    city.servers.push(v);
  }
  return [...groups.values()].sort((a, b) => a.country.localeCompare(b.country, locale));
}

export function smartTarget(mode: SmartMode, country?: string, city?: string, features: ServerFeature[] = []): ConnectTarget {
  return { kind: "smart", mode, country: country ?? null, city: city ?? null, features };
}

export function sameTarget(a: ConnectTarget | null | undefined, b: ConnectTarget | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Location ids are favourited as `loc:<id>`, servers by id. */
export const locationKey = (locationId: string) => `loc:${locationId}`;
