import "server-only";
import * as flags from "country-flag-icons/string/3x2";
import { cache } from "react";
import { publicApi } from "./dal";
import { serverRows, type ServerRow } from "./servers";
import type { RelayList } from "./types";

/**
 * The server list, as the apps get it. This server reaches the API over the
 * private network, so it reads the payload without re-checking the
 * signature the apps verify.
 */
export const getRelays = cache(async (): Promise<RelayList> => {
  const signed = await publicApi<{ payload: string }>("/v1/servers/relays");
  return JSON.parse(Buffer.from(signed.payload, "base64").toString("utf8")) as RelayList;
});

export type ServerWithFlag = ServerRow & { flag: string | null };

export async function getServers(): Promise<ServerWithFlag[]> {
  return serverRows(await getRelays()).map((r) => ({ ...r, flag: flagUri(r.countryCode) }));
}

/** A country's flag as a data URI (small, and allowed by the page's CSP). */
export function flagUri(countryCode: string): string | null {
  const svg = (flags as Record<string, string>)[countryCode.toUpperCase()];
  return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
}
