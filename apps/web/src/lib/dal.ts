import "server-only";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { ApiFailure, callApi, type CallOptions } from "./api";
import { secureCookies, sessionSecret } from "./env";
import { safeNext } from "./paths";
import { seal, sessionCookie, unseal, type Session } from "./session";
import type { User } from "./types";

/**
 * Data access for pages and server actions. Every call that acts for a user
 * carries that user's access token, so the API checks each one: nothing
 * here relies on the proxy having run.
 */

export const currentSession = cache(async (): Promise<Session | null> => {
  const value = (await cookies()).get(sessionCookie(secureCookies()).name)?.value;
  return value ? unseal(value, sessionSecret()) : null;
});

async function forwardedFor(): Promise<string | null> {
  return (await headers()).get("x-forwarded-for");
}

/** The page being requested (set by the proxy), for returning after sign-in. */
async function here(): Promise<string> {
  return safeNext((await headers()).get("x-apexy-path")) ?? "/dashboard";
}

export async function requireSession(): Promise<Session> {
  const session = await currentSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(await here())}`);
  return session;
}

/** Calls that need no account (plans, the server list, sign-in). */
export async function publicApi<T>(path: string, o: Omit<CallOptions, "token" | "forwardedFor"> = {}): Promise<T> {
  return callApi<T>(path, { ...o, forwardedFor: await forwardedFor() });
}

/** 401s about the token itself; others (a wrong password on a form) belong to the form. */
const SESSION_ENDED = new Set(["missing_token", "invalid_token", "session_revoked"]);

/** Calls as the signed-in user. A refused token sends the browser to sign in again. */
export async function userApi<T>(path: string, o: Omit<CallOptions, "token" | "forwardedFor"> = {}): Promise<T> {
  const session = await requireSession();
  try {
    return await callApi<T>(path, { ...o, token: session.at, forwardedFor: await forwardedFor() });
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 401 && SESSION_ENDED.has(e.code)) redirect("/auth/expired");
    throw e;
  }
}

export const currentUser = cache(async (): Promise<User> => userApi<User>("/v1/users/me"));

/**
 * Staff pages: anyone else gets a plain 404 (the page doesn't admit it
 * exists). The API checks the role again on every staff request.
 */
export async function requireAdmin(): Promise<User> {
  const user = await currentUser();
  if (user.role !== "admin") notFound();
  return user;
}

/** Server actions and route handlers only: store or clear the session cookie. */
export async function storeSession(session: Session | null): Promise<void> {
  const jar = await cookies();
  const { name, options } = sessionCookie(secureCookies());
  if (session) jar.set(name, await seal(session, sessionSecret()), options);
  else jar.delete({ name, path: "/" });
}
