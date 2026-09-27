import { NextResponse, type NextRequest } from "next/server";
import { ApiFailure, callApi } from "@/lib/api";
import { currentSession, storeSession } from "@/lib/dal";

/**
 * Where pages send the browser when the API refuses its token. The cookie
 * is cleared only if the session really doesn't work any more, so a link
 * from another site can't sign anyone out.
 */
export async function GET(request: NextRequest) {
  const session = await currentSession();
  if (session) {
    try {
      await callApi("/v1/users/me", { token: session.at, forwardedFor: request.headers.get("x-forwarded-for") });
      return NextResponse.redirect(new URL("/dashboard", request.url), 303);
    } catch (e) {
      if (!(e instanceof ApiFailure) || !["missing_token", "invalid_token", "session_revoked"].includes(e.code)) {
        return NextResponse.redirect(new URL("/dashboard", request.url), 303);
      }
    }
    await storeSession(null);
  }
  return NextResponse.redirect(new URL("/login?expired=1", request.url), 303);
}
