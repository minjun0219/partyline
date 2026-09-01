// Relay-wide rate limiting for the two unauthenticated doors: channel
// creation and join attempts. In an admin-less open relay these limits are
// the only brake on abuse (SPEC.md §8), so they live in one durable place
// rather than in per-isolate memory.

import { DurableObject } from "cloudflare:workers";

export class RateLimitDO extends DurableObject<Record<string, never>> {
  private get sql() {
    return this.ctx.storage.sql;
  }

  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS windows (
        key          TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count        INTEGER NOT NULL
      );
    `);
  }

  /** Fixed-window counter. Returns false once `limit` is reached. */
  admit(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const row = this.sql
      .exec("SELECT window_start, count FROM windows WHERE key = ?", key)
      .toArray()[0];
    if (!row || (row.window_start as number) < now - windowMs) {
      this.sql.exec(
        "INSERT OR REPLACE INTO windows (key, window_start, count) VALUES (?, ?, 1)",
        key,
        now,
      );
      // Opportunistic sweep so the table stays bounded.
      this.sql.exec("DELETE FROM windows WHERE window_start < ?", now - 24 * 3600 * 1000);
      return true;
    }
    if ((row.count as number) >= limit) return false;
    this.sql.exec("UPDATE windows SET count = count + 1 WHERE key = ?", key);
    return true;
  }
}
