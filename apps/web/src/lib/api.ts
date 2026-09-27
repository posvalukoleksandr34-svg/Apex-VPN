import "server-only";
import { env } from "./env";

/** An error answer from the API (status 0: it couldn't be reached). */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}

export interface CallOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  token?: string;
  /** The browser's X-Forwarded-For, so the API rate-limits per client and not per web server. */
  forwardedFor?: string | null;
  timeoutMs?: number;
}

/** One call to the account API from this server. Never cached. */
export async function callApi<T>(path: string, o: CallOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.forwardedFor) headers["x-forwarded-for"] = o.forwardedFor;
  let res: Response;
  try {
    res = await fetch(`${env().API_INTERNAL_URL}${path}`, {
      method: o.method ?? "GET",
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    });
  } catch {
    throw new ApiFailure(0, "api_unreachable", "the account service can't be reached");
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    const retry = Number(res.headers.get("retry-after"));
    throw new ApiFailure(res.status, err?.code ?? `http_${res.status}`, err?.message ?? res.statusText, Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }
  return data as T;
}
