export interface GeoInfo {
  countryCode: string | null;
  country: string | null;
  city: string | null;
  timezone: string | null;
  asn: number | null;
  organization: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface GeoIp {
  readonly available: boolean;
  lookup(ip: string): GeoInfo;
}

const EMPTY: GeoInfo = {
  countryCode: null,
  country: null,
  city: null,
  timezone: null,
  asn: null,
  organization: null,
  latitude: null,
  longitude: null,
};

/** No database configured: every field is null, and clients show "unknown". */
export class NoGeoIp implements GeoIp {
  readonly available = false;
  lookup(): GeoInfo {
    return EMPTY;
  }
}

/**
 * Integration point: MaxMind GeoLite2/GeoIP2 (City + ASN databases). Needs a
 * licence key and the `.mmdb` files; not bundled.
 */
export function maxmindGeoIp(_path: string | undefined): GeoIp {
  throw new Error("GEOIP_PROVIDER=maxmind is an integration point: add an .mmdb reader in src/lib/geoip.ts");
}
