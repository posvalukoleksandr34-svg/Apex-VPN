import "server-only";
import { fmt } from "@/i18n/format";
import type { Messages } from "@/i18n/messages/en";
import { ApiFailure } from "./api";

/**
 * The message to show for a failed API call. Anything that isn't an API
 * answer (a redirect, a bug) is rethrown, so server actions can catch
 * broadly without swallowing Next's redirects.
 */
export function describeFailure(e: unknown, m: Messages, prefer?: Record<string, string>): string {
  if (!(e instanceof ApiFailure)) throw e;
  if (e.status === 0) return m.common.unreachable;
  if (e.code === "rate_limited") return fmt(m.common.rateLimited, { seconds: e.retryAfterS ?? 60 });
  if (e.code === "too_many_attempts") {
    return fmt(m.auth.errors.too_many_attempts, { minutes: Math.max(1, Math.ceil((e.retryAfterS ?? 900) / 60)) });
  }
  if (e.code === "invalid_request") return m.auth.errors.invalid_email;
  const tables: Record<string, string>[] = [...(prefer ? [prefer] : []), m.auth.errors, m.devices.errors, m.billing.errors, m.account.errors, m.admin.errors];
  for (const t of tables) if (e.code in t) return t[e.code]!;
  console.error(`api ${e.status} ${e.code}`);
  return m.common.unexpected;
}
