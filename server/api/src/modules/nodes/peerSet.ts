import { createHash } from "node:crypto";
import type { AppDeps } from "../../deps.js";

export interface Peer {
  publicKey: string;
  allowedIps: string[];
}

export interface PeerSet {
  /** Changes whenever the set does; nodes send it back to wait for the next change. */
  version: string;
  peers: Peer[];
}

/** How often a waiting node's set is re-read, for changes made outside the API (SQL bans, expiry). */
export const RECHECK_MS = 2_000;
/** A read shared by every node polling within this window. */
const SHARE_MS = 1_000;

/**
 * The peer set every node enforces: devices whose owner isn't banned and
 * whose subscription grants access right now. Nodes long-poll it; the API
 * wakes them the moment something it did changes the set (a device added or
 * revoked, a Stripe event), and re-reads every RECHECK_MS for changes it
 * didn't make (a ban in plain SQL, a period running out).
 */
export class PeerSetWatch {
  private waiters = new Set<() => void>();
  private cached: { at: number; set: Promise<PeerSet> } | null = null;

  /** Something the API did may have changed the set: wake every waiting node. */
  changed(): void {
    this.cached = null;
    for (const wake of [...this.waiters]) wake();
  }

  async current(deps: AppDeps): Promise<PeerSet> {
    const now = Date.now();
    if (!this.cached || now - this.cached.at > SHARE_MS) {
      const set = readPeerSet(deps);
      this.cached = { at: now, set };
      set.catch(() => (this.cached = null));
    }
    return this.cached.set;
  }

  /** Resolves after `ms`, or earlier when `changed()` is called. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  /**
   * The current set, or, when the caller already has version `since`, the
   * first different set within `waitMs` (else the unchanged one).
   */
  async next(deps: AppDeps, since: string | undefined, waitMs: number): Promise<PeerSet> {
    const deadline = Date.now() + waitMs;
    let set = await this.current(deps);
    while (since && set.version === since && Date.now() < deadline) {
      await this.sleep(Math.min(RECHECK_MS, deadline - Date.now()));
      set = await this.current(deps);
    }
    return set;
  }
}

async function readPeerSet(deps: AppDeps): Promise<PeerSet> {
  const rows = await deps.database.db
    .selectFrom("ops.devices as d")
    .innerJoin("billing.subscriptions as s", "s.user_id", "d.user_id")
    .innerJoin("identity.users as u", "u.id", "d.user_id")
    .select(["d.wg_public_key", "d.ipv4", "d.ipv6"])
    .where("d.revoked_at", "is", null)
    .where("u.is_banned", "=", false)
    .where("s.status", "in", ["trialing", "active", "past_due"])
    .where("s.current_period_end", ">", deps.now())
    .orderBy("d.wg_public_key")
    .execute();
  const peers = rows.map((r) => ({
    publicKey: r.wg_public_key,
    allowedIps: [withMask(String(r.ipv4), 32), ...(r.ipv6 ? [withMask(String(r.ipv6), 128)] : [])],
  }));
  const hash = createHash("sha256");
  for (const p of peers) hash.update(`${p.publicKey} ${p.allowedIps.join(",")}\n`);
  return { version: hash.digest("hex").slice(0, 24), peers };
}

function withMask(ip: string, bits: number): string {
  return ip.includes("/") ? ip : `${ip}/${bits}`;
}
