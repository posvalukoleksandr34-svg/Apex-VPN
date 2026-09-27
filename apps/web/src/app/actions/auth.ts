"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getI18n } from "@/i18n/server";
import { callApi } from "@/lib/api";
import { currentSession, publicApi, storeSession } from "@/lib/dal";
import { describeFailure } from "@/lib/errors";
import { safeNext } from "@/lib/paths";
import { fromTokens } from "@/lib/session";
import type { LoginResponse, TokenResponse } from "@/lib/types";
import { webSessionName } from "@/lib/ua";

export interface AuthState {
  error?: string;
  notice?: string;
  /** The next screen of a multi-step form. */
  step?: "mfa" | "verify" | "reset";
  mfaToken?: string;
  email?: string;
}

const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
};
const isCode = (v: string) => /^\d{6}$/.test(v);

async function webDevice() {
  return { name: webSessionName((await headers()).get("user-agent")), platform: "web" as const };
}

export async function login(_prev: AuthState, form: FormData): Promise<AuthState> {
  const { m } = await getI18n();
  const email = text(form, "email").trim();
  let res: LoginResponse;
  try {
    res = await publicApi<LoginResponse>("/v1/auth/login", { method: "POST", body: { email, password: text(form, "password"), device: await webDevice() } });
  } catch (e) {
    return { error: describeFailure(e, m), email };
  }
  if ("mfaRequired" in res) return { step: "mfa", mfaToken: res.mfaToken, email };
  await storeSession(fromTokens(res));
  redirect(safeNext(text(form, "next")) ?? "/dashboard");
}

export async function loginMfa(prev: AuthState, form: FormData): Promise<AuthState> {
  const { m } = await getI18n();
  const recovery = text(form, "recovery").trim();
  const code = text(form, "code").replace(/\s/g, "");
  if (!recovery && !isCode(code)) return { ...prev, error: m.auth.errors.invalid_code };
  let res: TokenResponse;
  try {
    res = await publicApi<TokenResponse>("/v1/auth/login/mfa", {
      method: "POST",
      body: { mfaToken: prev.mfaToken ?? "", ...(recovery ? { recoveryCode: recovery } : { code }), device: await webDevice() },
    });
  } catch (e) {
    const error = describeFailure(e, m);
    // An expired challenge can't be retried: back to the password.
    return error === m.auth.errors.mfa_token_invalid ? { error, email: prev.email } : { ...prev, error };
  }
  await storeSession(fromTokens(res));
  redirect(safeNext(text(form, "next")) ?? "/dashboard");
}

export async function register(_prev: AuthState, form: FormData): Promise<AuthState> {
  const { m, locale } = await getI18n();
  const email = text(form, "email").trim();
  try {
    await publicApi("/v1/auth/register", { method: "POST", body: { email, password: text(form, "password"), locale } });
  } catch (e) {
    return { error: describeFailure(e, m), email };
  }
  return { step: "verify", email };
}

/** Confirms the address, then signs in with the password just chosen. */
export async function verifyAndSignIn(prev: AuthState, form: FormData): Promise<AuthState> {
  const { m } = await getI18n();
  const email = prev.email ?? text(form, "email");
  const code = text(form, "code").replace(/\s/g, "");
  if (!isCode(code)) return { ...prev, notice: undefined, error: m.auth.errors.invalid_code };
  try {
    await publicApi("/v1/auth/verify-email", { method: "POST", body: { email, code } });
  } catch (e) {
    return { ...prev, notice: undefined, error: describeFailure(e, m) };
  }
  if (await currentSession()) redirect("/dashboard");
  const password = text(form, "password");
  if (password) {
    try {
      const res = await publicApi<LoginResponse>("/v1/auth/login", { method: "POST", body: { email, password, device: await webDevice() } });
      if (!("mfaRequired" in res)) {
        await storeSession(fromTokens(res));
        redirect("/billing?welcome=1");
      }
    } catch (e) {
      describeFailure(e, m); // a redirect passes through; a failed sign-in falls back to the form
    }
  }
  redirect(`/login?verified=1&email=${encodeURIComponent(email)}`);
}

export async function resendVerification(prev: AuthState, form: FormData): Promise<AuthState> {
  const { m } = await getI18n();
  const email = prev.email ?? text(form, "email");
  try {
    await publicApi("/v1/auth/resend-verification", { method: "POST", body: { email } });
  } catch (e) {
    return { ...prev, notice: undefined, error: describeFailure(e, m) };
  }
  return { ...prev, error: undefined, notice: m.auth.verify.resent };
}

export async function forgot(_prev: AuthState, form: FormData): Promise<AuthState> {
  const { m } = await getI18n();
  const email = text(form, "email").trim();
  try {
    await publicApi("/v1/auth/password/forgot", { method: "POST", body: { email } });
  } catch (e) {
    return { error: describeFailure(e, m), email };
  }
  return { step: "reset", email };
}

export async function resetPassword(prev: AuthState, form: FormData): Promise<AuthState> {
  const { m } = await getI18n();
  const code = text(form, "code").replace(/\s/g, "");
  if (!isCode(code)) return { ...prev, error: m.auth.errors.invalid_code };
  try {
    await publicApi("/v1/auth/password/reset", { method: "POST", body: { email: prev.email ?? "", code, newPassword: text(form, "password") } });
  } catch (e) {
    return { ...prev, error: describeFailure(e, m) };
  }
  redirect("/login?reset=1");
}

export async function logout(): Promise<void> {
  const session = await currentSession();
  if (session) {
    // Ends the session at the API too; the cookie goes either way.
    await callApi("/v1/auth/logout", { method: "POST", body: { refreshToken: session.rt } }).catch(() => undefined);
  }
  await storeSession(null);
  redirect("/login?signedOut=1");
}
