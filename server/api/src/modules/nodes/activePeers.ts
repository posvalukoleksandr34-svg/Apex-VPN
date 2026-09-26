/**
 * Which device keys have a live tunnel right now, from node heartbeats.
 * Held in memory only and forgotten after three minutes: the product can show
 * "connected now" without ever recording connection history.
 */
export class ActivePeers {
  private readonly seen = new Map<string, { serverId: string; at: number }>();

  constructor(private readonly ttlMs = 3 * 60_000) {}

  report(serverId: string, publicKeys: string[], now = Date.now()): void {
    for (const k of publicKeys) this.seen.set(k, { serverId, at: now });
  }

  lookup(publicKey: string, now = Date.now()): { serverId: string } | null {
    const v = this.seen.get(publicKey);
    if (!v) return null;
    if (now - v.at > this.ttlMs) {
      this.seen.delete(publicKey);
      return null;
    }
    return { serverId: v.serverId };
  }

  prune(now = Date.now()): void {
    for (const [k, v] of this.seen) if (now - v.at > this.ttlMs) this.seen.delete(k);
  }
}
