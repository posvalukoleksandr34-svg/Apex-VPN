import { NextResponse, type NextRequest } from "next/server";
import { callApi } from "@/lib/api";
import { secureCookies, sessionSecret } from "@/lib/env";
import { SessionRefresher } from "@/lib/refresh";
import { needsRefresh, seal, sessionCookie, unseal } from "@/lib/session";
import type { TokenResponse } from "@/lib/types";

// One per process (kept on globalThis so development reloads don't lose it).
const g = globalThis as typeof globalThis & { apexyRefresher?: SessionRefresher };
const refresher = (g.apexyRefresher ??= new SessionRefresher((refreshToken, forwardedFor) =>
  callApi<TokenResponse>("/v1/auth/refresh", { method: "POST", body: { refreshToken }, forwardedFor, timeoutMs: 8_000 }),
));

/**
 * Runs before every page and server action:
 * - a Content-Security-Policy with a fresh nonce: no script runs unless
 *   this server put it on the page;
 * - the session: refreshed shortly before the access token expires, and
 *   cleared once the API says it has ended (signed out elsewhere, password
 *   reset, ban). Pages still check the session themselves.
 */
export async function proxy(request: NextRequest) {
  const secure = secureCookies();
  const cookie = sessionCookie(secure);

  let update: string | null | undefined; // undefined: unchanged; null: clear
  const value = request.cookies.get(cookie.name)?.value;
  if (value) {
    const session = await unseal(value, sessionSecret());
    // Next renders a server action's redirect by fetching the page from
    // itself, and drops that response's Set-Cookie: a token rotated there
    // would never reach the browser. The action's own response carries any
    // refresh already.
    const internal = request.headers.has("x-action-redirect");
    if (!session) {
      update = null;
    } else if (!internal && needsRefresh(session)) {
      const outcome = await refresher.refresh(session, request.headers.get("x-forwarded-for"));
      if (outcome.kind === "ended") update = null;
      else if (outcome.kind === "fresh") update = await seal(outcome.session, sessionSecret());
    }
  }
  // Make the change visible to this request's pages and actions too.
  if (update === null) request.cookies.delete(cookie.name);
  else if (update) request.cookies.set(cookie.name, update);

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    // Checkout and the billing portal are Stripe's pages, reached by redirect after a form post.
    "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
    "frame-ancestors 'none'",
    ...(secure ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  headers.set("x-apexy-path", request.nextUrl.pathname + request.nextUrl.search);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", csp);
  response.headers.set("cache-control", "private, no-store");
  if (update === null) response.cookies.delete({ name: cookie.name, path: "/" });
  else if (update) response.cookies.set(cookie.name, update, cookie.options);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|logo.png|robots.txt).*)"],
};
