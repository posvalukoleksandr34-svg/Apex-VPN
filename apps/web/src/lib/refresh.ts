import { createHash } from "node:crypto";
import { ApiFailure } from "./api";
import { fromTokens, needsRefresh, type Session } from "./session";
import type { TokenResponse } from "./types";

/**
 * Refreshing sessions without tripping the API's reuse detection.
 *
 * The API rotates the refresh token on every refresh, and treats a rotated
 * token that comes back (after a 15 s grace) as stolen: it ends the whole
 * sign-in. A browser can legitimately send a rotated token again when the
 * response carrying the new cookie never reached it (an aborted prefetch,
 * a response Next doesn't forward). So each rotation is remembered for a
 * while: the old token then gets the new session instead of reaching the
 * API. Concurrent refreshes of one session share a single API call.
 *
 * The memory is per process: run one web instance, or route a browser to
 * the same instance (sticky sessions).
 */
export type Outcome = { kind: "fresh"; session: Session } | { kind: "ended" } | { kind: "keep" };

const hash = (token: string) => createHash("sha256").update(token).digest("base64url");

export class SessionRefresher {
  private successors = new Map<string, { session: Session; until: number }>();
  private inflight = new Map<string, Promise<Outcome>>();

  constructor(
    private readonly refreshCall: (refreshToken: string, forwardedFor: string | null) => Promise<TokenResponse>,
    private readonly now: () => number = Date.now,
    private readonly rememberMs = 10 * 60_000,
    private readonly capacity = 10_000,
  ) {}

  /** The session this one should be replaced with, if any. */
  async refresh(session: Session, forwardedFor: string | null = null): Promise<Outcome> {
    let current = session;
    let replaced = false;
    // Follow rotations already made for this browser.
    for (let hops = 0; hops < 8; hops++) {
      const known = this.successors.get(hash(current.rt));
      if (!known || known.until < this.now()) break;
      current = known.session;
      replaced = true;
    }
    if (!needsRefresh(current, this.now())) return replaced ? { kind: "fresh", session: current } : { kind: "keep" };
    const key = hash(current.rt);
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.rotate(current, key, forwardedFor).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const outcome = await pending;
    return outcome.kind === "keep" && replaced ? { kind: "fresh", session: current } : outcome;
  }

  private async rotate(session: Session, key: string, forwardedFor: string | null): Promise<Outcome> {
    try {
      const next = fromTokens(await this.refreshCall(session.rt, forwardedFor), this.now());
      this.remember(key, next);
      return { kind: "fresh", session: next };
    } catch (e) {
      // 401: the session is over (signed out, password reset, banned).
      // 409: another web instance is rotating it right now; anything else:
      // the API is unreachable. Both: keep the current token for now.
      return e instanceof ApiFailure && e.status === 401 ? { kind: "ended" } : { kind: "keep" };
    }
  }

  private remember(key: string, session: Session): void {
    const now = this.now();
    for (const [k, v] of this.successors) {
      if (this.successors.size < this.capacity && v.until >= now) break;
      this.successors.delete(k); // oldest first (insertion order)
    }
    this.successors.set(key, { session, until: now + this.rememberMs });
  }
}
