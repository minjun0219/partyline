// One Durable Object per channel: parties, invites, inboxes, and the two
// receive transports (WebSocket stream, long poll). The design constraints
// come straight from SPEC.md — no history (rows exist only until acked), no
// broadcast (delivery is always to one inbox), and destruction when the last
// party is gone.

import { DurableObject } from "cloudflare:workers";
import { randomId, randomToken, sha256Hex } from "./crypto.ts";
import { type Fail, fail } from "./errors.ts";
import {
  CHANNEL_GRACE_MS,
  INVITE_MAX_USES,
  INVITE_TTL_MAX_MS,
  INVITE_TTL_MS,
  isoTime,
  LIMITS,
  type MessageEnvelope,
  type PartyView,
  PRESENCE_GRACE_MS,
  type RecipientView,
  type ServerFrame,
  WS_CLOSE,
} from "./protocol.ts";

const MESSAGE_TTL_MS = LIMITS.message_ttl_seconds * 1000;
const PARTY_TTL_MS = LIMITS.party_ttl_seconds * 1000;
const ALARM_INTERVAL_MS = 30 * 1000;
/** Two missed ping rounds before a silent socket is dropped. */
const PONG_DEADLINE_MS = 75 * 1000;

/** In-memory per-party fixed-window rate limits (reference-grade). */
const SEND_RATE_PER_MINUTE = 120;
const INVITE_RATE_PER_MINUTE = 30;

interface PartyRow {
  id: string;
  display_name: string;
  machine_label: string;
  about: string | null;
  joined_at: number;
  last_seen_at: number;
  next_seq: number;
}

interface PendingPoll {
  partyId: string;
  afterSeq: number;
  limit: number;
  resolve: (result: PollResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface InviteInfo {
  token: string;
  expires_at: string;
  uses_remaining: number;
}

export type CreateResult = { ok: true; invite: InviteInfo } | Fail;
export type JoinResult =
  | {
      ok: true;
      party_id: string;
      party_token: string;
      channel: { channel_id: string; name: string };
      parties: PartyView[];
    }
  | Fail;
export type PartiesResult = { ok: true; you: string; parties: PartyView[] } | Fail;
export type UpdateResult = { ok: true; party: PartyView } | Fail;
export type InviteResult = { ok: true; invite: InviteInfo } | Fail;
export type SendResult =
  | { ok: true; message_id: string; seq: number; recipient: RecipientView }
  | Fail;
export type PollResult = { ok: true; messages: MessageEnvelope[]; last_seq: number } | Fail;
export type OkResult = { ok: true } | Fail;

export class ChannelDO extends DurableObject<Record<string, never>> {
  private pendingPolls: PendingPoll[] = [];
  private rates = new Map<string, { windowStart: number; count: number }>();

  private get sql() {
    return this.ctx.storage.sql;
  }

  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS parties (
        id            TEXT PRIMARY KEY,
        display_name  TEXT NOT NULL UNIQUE,
        machine_label TEXT NOT NULL,
        about         TEXT,
        token_hash    TEXT NOT NULL UNIQUE,
        joined_at     INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        next_seq      INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS invites (
        hash           TEXT PRIMARY KEY,
        expires_at     INTEGER NOT NULL,
        uses_remaining INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbox (
        recipient    TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        message_id   TEXT NOT NULL,
        from_id      TEXT NOT NULL,
        from_name    TEXT NOT NULL,
        from_machine TEXT NOT NULL,
        body         TEXT NOT NULL,
        sent_at      INTEGER NOT NULL,
        reply_to     TEXT,
        PRIMARY KEY (recipient, seq)
      );
    `);
  }

  // ---- meta helpers --------------------------------------------------------

  private metaGet(key: string): string | null {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? (row.value as string) : null;
  }

  private metaSet(key: string, value: string): void {
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
  }

  private metaDelete(key: string): void {
    this.sql.exec("DELETE FROM meta WHERE key = ?", key);
  }

  /**
   * Uninitialized and destroyed channels answer differently on purpose:
   * `not_found` hides whether a guessed identifier ever existed, while a
   * bearer of a token minted for a destroyed channel gets an honest `gone`
   * (SPEC.md §4). The tombstone itself is swept after message_ttl.
   */
  private state(): "missing" | "destroyed" | "live" {
    if (this.metaGet("destroyed_at") !== null) return "destroyed";
    if (this.metaGet("id") === null) return "missing";
    return "live";
  }

  private gate(): Fail | null {
    switch (this.state()) {
      case "missing":
        return fail("not_found", "no such channel");
      case "destroyed":
        return fail("gone", "channel was destroyed");
      default:
        return null;
    }
  }

  /**
   * SPEC.md §8: a wrong or expired party token on a live channel gets
   * the same answer as an unknown channel — existence is never confirmed to
   * a non-party.
   */
  private hideExistence(): Fail {
    return fail("not_found", "no such channel");
  }

  // ---- lifecycle -----------------------------------------------------------

  async create(channelId: string, name: string): Promise<CreateResult> {
    if (this.state() !== "missing") return fail("internal", "channel identifier collision");
    const now = Date.now();
    this.metaSet("id", channelId);
    this.metaSet("name", name);
    this.metaSet("created_at", String(now));
    this.metaSet("empty_since", String(now));
    await this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS);
    const invite = await this.mintInviteRow(now, INVITE_TTL_MS, 1);
    return { ok: true, invite };
  }

  private async mintInviteRow(now: number, ttlMs: number, uses: number): Promise<InviteInfo> {
    const token = randomToken("iv_");
    const expiresAt = now + ttlMs;
    this.sql.exec(
      "INSERT INTO invites (hash, expires_at, uses_remaining) VALUES (?, ?, ?)",
      await sha256Hex(token),
      expiresAt,
      uses,
    );
    return { token, expires_at: isoTime(expiresAt), uses_remaining: uses };
  }

  async mintInvite(
    partyToken: string,
    ttlSeconds: number | undefined,
    maxUses: number | undefined,
  ): Promise<InviteResult> {
    const gate = this.gate();
    if (gate) return gate;
    const me = await this.auth(partyToken);
    if (!me) return this.hideExistence();
    if (!this.admitRate(`invite:${me.id}`, INVITE_RATE_PER_MINUTE)) {
      return fail("rate_limited", "too many invites");
    }
    const ttlMs = Math.min((ttlSeconds ?? INVITE_TTL_MS / 1000) * 1000, INVITE_TTL_MAX_MS);
    const uses = Math.min(maxUses ?? 1, INVITE_MAX_USES);
    if (ttlMs <= 0 || uses <= 0) return fail("invalid_request", "ttl and uses must be positive");
    const invite = await this.mintInviteRow(Date.now(), ttlMs, uses);
    return { ok: true, invite };
  }

  async join(
    inviteToken: string,
    displayName: string,
    machineLabel: string,
    about: string | undefined,
  ): Promise<JoinResult> {
    const gate = this.gate();
    if (gate) return gate;
    const now = Date.now();

    const inviteHash = await sha256Hex(inviteToken);
    const invite = this.sql
      .exec(
        "SELECT expires_at, uses_remaining FROM invites WHERE hash = ? AND expires_at > ? AND uses_remaining > 0",
        inviteHash,
        now,
      )
      .toArray()[0];
    if (!invite) return this.hideExistence(); // a bad invite must not confirm the channel exists (§8)

    const taken = this.sql
      .exec("SELECT id FROM parties WHERE display_name = ?", displayName)
      .toArray()[0];
    if (taken) return fail("name_taken", "display name is in use in this channel");

    const partyId = randomId("p_");
    const token = randomToken("pt_");
    this.sql.exec(
      `INSERT INTO parties
         (id, display_name, machine_label, about, token_hash, joined_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      partyId,
      displayName,
      machineLabel,
      about ?? null,
      await sha256Hex(token),
      now,
      now,
    );
    if ((invite.uses_remaining as number) <= 1) {
      this.sql.exec("DELETE FROM invites WHERE hash = ?", inviteHash);
    } else {
      this.sql.exec(
        "UPDATE invites SET uses_remaining = uses_remaining - 1 WHERE hash = ?",
        inviteHash,
      );
    }
    this.metaDelete("empty_since");

    const joined = this.partyById(partyId);
    if (joined) this.broadcastPresence("joined", joined);
    return {
      ok: true,
      party_id: partyId,
      party_token: token,
      channel: { channel_id: this.metaGet("id") ?? "", name: this.metaGet("name") ?? "" },
      parties: this.allViews(),
    };
  }

  // ---- party auth and views -----------------------------------------

  private async auth(token: string): Promise<PartyRow | null> {
    const hash = await sha256Hex(token);
    const row = this.sql.exec("SELECT * FROM parties WHERE token_hash = ?", hash).toArray()[0];
    if (!row) return null;
    const now = Date.now();
    this.sql.exec("UPDATE parties SET last_seen_at = ? WHERE id = ?", now, row.id);
    return { ...(row as unknown as PartyRow), last_seen_at: now };
  }

  private partyById(id: string): PartyRow | null {
    const row = this.sql.exec("SELECT * FROM parties WHERE id = ?", id).toArray()[0];
    return row ? (row as unknown as PartyRow) : null;
  }

  /**
   * A socket counts as presence only while it answers pings. A peer that
   * vanished without closing (a pulled cable, a sleeping laptop) leaves a
   * socket the runtime keeps listing well past close() — the TCP timeout,
   * not the close handshake, decides when it goes — and an `online` read
   * off that socket would be a false positive for minutes.
   */
  private hasLiveSocket(partyId: string, now = Date.now()): boolean {
    return this.ctx.getWebSockets(partyId).some((ws) => {
      const attachment = ws.deserializeAttachment() as { p: string; pong: number } | null;
      return attachment !== null && now - attachment.pong <= PONG_DEADLINE_MS;
    });
  }

  private isOnline(row: PartyRow): boolean {
    const now = Date.now();
    if (this.hasLiveSocket(row.id, now)) return true;
    return now - row.last_seen_at <= PRESENCE_GRACE_MS;
  }

  private view(row: PartyRow): PartyView {
    return {
      party_id: row.id,
      display_name: row.display_name,
      machine_label: row.machine_label,
      ...(row.about !== null ? { about: row.about } : {}),
      online: this.isOnline(row),
      joined_at: isoTime(row.joined_at),
      last_seen_at: isoTime(row.last_seen_at),
    };
  }

  private allViews(): PartyView[] {
    return this.sql
      .exec("SELECT * FROM parties ORDER BY joined_at")
      .toArray()
      .map((r) => this.view(r as unknown as PartyRow));
  }

  async listParties(token: string): Promise<PartiesResult> {
    const gate = this.gate();
    if (gate) return gate;
    const me = await this.auth(token);
    if (!me) return this.hideExistence();
    return { ok: true, you: me.id, parties: this.allViews() };
  }

  async updateMe(
    token: string,
    patch: { display_name?: string; about?: string },
  ): Promise<UpdateResult> {
    const gate = this.gate();
    if (gate) return gate;
    const me = await this.auth(token);
    if (!me) return this.hideExistence();
    if (patch.display_name !== undefined && patch.display_name !== me.display_name) {
      const taken = this.sql
        .exec("SELECT id FROM parties WHERE display_name = ?", patch.display_name)
        .toArray()[0];
      if (taken) return fail("name_taken", "display name is in use in this channel");
      this.sql.exec("UPDATE parties SET display_name = ? WHERE id = ?", patch.display_name, me.id);
    }
    if (patch.about !== undefined) {
      this.sql.exec(
        "UPDATE parties SET about = ? WHERE id = ?",
        patch.about === "" ? null : patch.about,
        me.id,
      );
    }
    const updated = this.partyById(me.id);
    if (!updated) return fail("internal", "party vanished");
    this.broadcastPresence("updated", updated);
    return { ok: true, party: this.view(updated) };
  }

  async leave(token: string): Promise<OkResult> {
    const gate = this.gate();
    if (gate) return gate;
    const me = await this.auth(token);
    if (!me) return this.hideExistence();
    this.removeParty(me.id, 1000, "left the channel");
    return { ok: true };
  }

  /**
   * Shared by leave, the staleness sweep, and destruction.
   * Unacked messages in the inbox are discarded with the party
   * (SPEC.md §4) — nobody else may ever read them.
   */
  private removeParty(id: string, closeCode: number, closeReason: string): void {
    const row = this.partyById(id);
    if (!row) return;
    for (const ws of this.ctx.getWebSockets(id)) {
      try {
        ws.close(closeCode, closeReason);
      } catch {
        // already closed
      }
    }
    this.flushPollsFor(id, fail("gone", "no longer a party"));
    this.sql.exec("DELETE FROM parties WHERE id = ?", id);
    this.sql.exec("DELETE FROM inbox WHERE recipient = ?", id);
    this.broadcastPresence("left", row);
    const remaining = this.sql.exec("SELECT COUNT(*) AS n FROM parties").toArray()[0];
    if (((remaining?.n as number) ?? 0) === 0 && this.metaGet("empty_since") === null) {
      this.metaSet("empty_since", String(Date.now()));
    }
  }

  // ---- sending -------------------------------------------------------------

  async send(
    token: string,
    to: string,
    body: string,
    replyTo: string | undefined,
  ): Promise<SendResult> {
    const gate = this.gate();
    if (gate) return gate;
    const me = await this.auth(token);
    if (!me) return this.hideExistence();
    if (!this.admitRate(`send:${me.id}`, SEND_RATE_PER_MINUTE)) {
      return fail("rate_limited", "sending too fast");
    }
    const recipient = this.partyById(to);
    if (!recipient) return fail("no_such_recipient", "`to` is not a current party");
    const queued = this.sql
      .exec("SELECT COUNT(*) AS n FROM inbox WHERE recipient = ?", to)
      .toArray()[0];
    if (((queued?.n as number) ?? 0) >= LIMITS.inbox_messages) {
      return fail("inbox_full", "recipient inbox is at capacity");
    }

    const now = Date.now();
    const messageId = randomId("x_");
    const seq = recipient.next_seq;
    this.sql.exec("UPDATE parties SET next_seq = next_seq + 1 WHERE id = ?", to);
    this.sql.exec(
      `INSERT INTO inbox (recipient, seq, message_id, from_id, from_name, from_machine, body, sent_at, reply_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      to,
      seq,
      messageId,
      me.id,
      me.display_name,
      me.machine_label,
      body,
      now,
      replyTo ?? null,
    );

    const envelope = this.envelopeFromRow({
      recipient: to,
      seq,
      message_id: messageId,
      from_id: me.id,
      from_name: me.display_name,
      from_machine: me.machine_label,
      body,
      sent_at: now,
      reply_to: replyTo ?? null,
    });
    for (const ws of this.ctx.getWebSockets(to)) {
      this.wsSend(ws, { type: "message", message: envelope });
    }
    this.flushPollsFor(to, null);

    return { ok: true, message_id: messageId, seq, recipient: this.recipientView(to) };
  }

  private recipientView(id: string): RecipientView {
    const row = this.partyById(id);
    if (!row) {
      return { party_id: id, display_name: "", online: false, last_seen_at: isoTime(0) };
    }
    return {
      party_id: row.id,
      display_name: row.display_name,
      online: this.isOnline(row),
      last_seen_at: isoTime(row.last_seen_at),
    };
  }

  // row shape is fixed by the SELECTs above; the casts narrow SqlStorageValue
  private envelopeFromRow(row: Record<string, SqlStorageValue>): MessageEnvelope {
    return {
      v: 1,
      message_id: row.message_id as string,
      channel_id: this.metaGet("id") ?? "",
      seq: row.seq as number,
      from: {
        party_id: row.from_id as string,
        display_name: row.from_name as string,
        machine_label: row.from_machine as string,
      },
      to: row.recipient as string,
      body: row.body as string,
      sent_at: isoTime(row.sent_at as number),
      reply_to: (row.reply_to as string | null) ?? null,
    };
  }

  // ---- receiving: long poll and ack ---------------------------------------

  private readInbox(recipient: string, afterSeq: number, limit: number): MessageEnvelope[] {
    return this.sql
      .exec(
        "SELECT * FROM inbox WHERE recipient = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
        recipient,
        afterSeq,
        limit,
      )
      .toArray()
      .map((r) => this.envelopeFromRow(r));
  }

  private lastSeq(recipient: string): number {
    const row = this.sql.exec("SELECT next_seq FROM parties WHERE id = ?", recipient).toArray()[0];
    return row ? (row.next_seq as number) - 1 : 0;
  }

  async poll(
    token: string,
    waitSeconds: number,
    afterSeq: number,
    limit: number,
  ): Promise<PollResult> {
    const gate = this.gate();
    if (gate) return gate;
    const me = await this.auth(token);
    if (!me) return this.hideExistence();

    const capped = Math.min(Math.max(limit, 1), 64);
    const messages = this.readInbox(me.id, afterSeq, capped);
    if (messages.length > 0 || waitSeconds <= 0) {
      return { ok: true, messages, last_seq: this.lastSeq(me.id) };
    }

    const wait = Math.min(waitSeconds, LIMITS.long_poll_max_seconds) * 1000;
    return new Promise<PollResult>((resolve) => {
      const pending: PendingPoll = {
        partyId: me.id,
        afterSeq,
        limit: capped,
        resolve,
        timer: setTimeout(() => {
          this.pendingPolls = this.pendingPolls.filter((p) => p !== pending);
          resolve({ ok: true, messages: [], last_seq: this.lastSeq(me.id) });
        }, wait),
      };
      this.pendingPolls.push(pending);
    });
  }

  /** Resolve held polls for a party — with fresh messages, or a failure. */
  private flushPollsFor(partyId: string, failure: Fail | null): void {
    const matching = this.pendingPolls.filter((p) => p.partyId === partyId);
    if (matching.length === 0) return;
    this.pendingPolls = this.pendingPolls.filter((p) => p.partyId !== partyId);
    for (const p of matching) {
      clearTimeout(p.timer);
      if (failure) {
        p.resolve(failure);
      } else {
        p.resolve({
          ok: true,
          messages: this.readInbox(partyId, p.afterSeq, p.limit),
          last_seq: this.lastSeq(partyId),
        });
      }
    }
  }

  /**
   * The ack cursor (SPEC.md §6): deletes everything at or below `seq`.
   * Idempotent; acking below a previous ack is a no-op. This is the only code
   * path that removes delivered messages — read paths never do.
   */
  async ack(token: string, seq: number): Promise<OkResult> {
    const gate = this.gate();
    if (gate) return gate;
    const me = await this.auth(token);
    if (!me) return this.hideExistence();
    this.sql.exec("DELETE FROM inbox WHERE recipient = ? AND seq <= ?", me.id, seq);
    return { ok: true };
  }

  // ---- receiving: WebSocket stream ----------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const state = this.state();
    if (state === "missing") return new Response("not found", { status: 404 });
    if (state === "destroyed") return new Response("gone", { status: 410 });

    const token = bearerFrom(request.headers.get("Authorization"));
    const me = token ? await this.auth(token) : null;
    if (!me) return new Response("not found", { status: 404 }); // §8: do not confirm existence

    // One stream per party: a second connection supersedes the first
    // (SPEC.md §6). Two live streams would each ack past the other.
    for (const existing of this.ctx.getWebSockets(me.id)) {
      try {
        existing.close(WS_CLOSE.superseded, "superseded by a newer stream");
      } catch {
        // already closed
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [me.id]);
    server.serializeAttachment({ p: me.id, pong: Date.now() });

    this.wsSend(server, {
      type: "ready",
      party_id: me.id,
      last_seq: this.lastSeq(me.id),
      parties: this.allViews(),
    });
    // Backlog first, then live traffic — same at-least-once contract as the
    // long poll: nothing is deleted here, only on ack.
    for (const envelope of this.readInbox(me.id, 0, LIMITS.inbox_messages)) {
      this.wsSend(server, { type: "message", message: envelope });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as { p: string; pong: number } | null;
    if (!attachment) return;
    let frame: { type?: string; seq?: number };
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      this.wsSend(ws, { type: "error", error: "invalid_request", message: "frames are JSON" });
      return;
    }
    if (frame.type === "pong") {
      ws.serializeAttachment({ p: attachment.p, pong: Date.now() });
      this.touch(attachment.p);
      return;
    }
    if (frame.type === "ack" && typeof frame.seq === "number") {
      this.sql.exec("DELETE FROM inbox WHERE recipient = ? AND seq <= ?", attachment.p, frame.seq);
      this.touch(attachment.p);
      return;
    }
    this.wsSend(ws, { type: "error", error: "invalid_request", message: "unknown frame type" });
  }

  private touch(partyId: string): void {
    this.sql.exec("UPDATE parties SET last_seen_at = ? WHERE id = ?", Date.now(), partyId);
  }

  private wsSend(ws: WebSocket, frame: ServerFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // socket is closing; the sweep will collect it
    }
  }

  private broadcastPresence(event: "joined" | "left" | "updated", row: PartyRow): void {
    const frame: ServerFrame = { type: "presence", event, party: this.view(row) };
    for (const ws of this.ctx.getWebSockets()) {
      this.wsSend(ws, frame);
    }
  }

  // ---- destruction ---------------------------------------------------------

  /**
   * Any party may destroy the channel (SPEC.md §4). The invitation is
   * the trust boundary; when it was misplaced, burning the channel and
   * re-forming it with fresh invites is the remedy — and nobody outside the
   * invitation chain can trigger this at all.
   */
  async destroyByParty(token: string): Promise<OkResult> {
    const gate = this.gate();
    if (gate) return gate;
    const me = await this.auth(token);
    if (!me) return this.hideExistence();
    await this.destroy();
    return { ok: true };
  }

  private async destroy(): Promise<void> {
    if (this.state() !== "live") return;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(WS_CLOSE.gone, "channel destroyed");
      } catch {
        // already closed
      }
    }
    for (const p of this.pendingPolls) {
      clearTimeout(p.timer);
      p.resolve(fail("gone", "channel was destroyed"));
    }
    this.pendingPolls = [];
    const id = this.metaGet("id");
    this.sql.exec("DELETE FROM parties");
    this.sql.exec("DELETE FROM inbox");
    this.sql.exec("DELETE FROM invites");
    this.sql.exec("DELETE FROM meta");
    if (id !== null) this.metaSet("id", id);
    this.metaSet("destroyed_at", String(Date.now()));
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  // ---- periodic sweep ------------------------------------------------------

  override async alarm(): Promise<void> {
    const now = Date.now();
    const state = this.state();

    if (state === "destroyed") {
      // Keep the tombstone long enough for stale clients to see `gone`,
      // then forget the channel ever existed.
      const destroyedAt = Number(this.metaGet("destroyed_at") ?? 0);
      if (now - destroyedAt > MESSAGE_TTL_MS) {
        this.sql.exec("DELETE FROM meta");
        await this.ctx.storage.deleteAlarm();
      } else {
        await this.ctx.storage.setAlarm(now + MESSAGE_TTL_MS / 4);
      }
      return;
    }
    if (state === "missing") {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    this.sql.exec("DELETE FROM inbox WHERE sent_at < ?", now - MESSAGE_TTL_MS);
    this.sql.exec("DELETE FROM invites WHERE expires_at < ?", now);

    // Drop parties that have gone silent (SPEC.md §4). A socket that still
    // answers pings counts as presence; a zombie does not.
    const stale = this.sql
      .exec("SELECT id FROM parties WHERE last_seen_at < ?", now - PARTY_TTL_MS)
      .toArray();
    for (const row of stale) {
      const id = row.id as string;
      if (this.hasLiveSocket(id, now)) continue;
      this.removeParty(id, WS_CLOSE.unauthorized, "dropped after inactivity");
    }

    // Ping every socket; drop the ones that stopped answering.
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as { p: string; pong: number } | null;
      if (attachment && now - attachment.pong > PONG_DEADLINE_MS) {
        try {
          ws.close(1001, "no pong");
        } catch {
          // already closed
        }
        continue;
      }
      this.wsSend(ws, { type: "ping" });
    }

    const emptySince = this.metaGet("empty_since");
    if (emptySince !== null && now - Number(emptySince) > CHANNEL_GRACE_MS) {
      await this.destroy();
      return;
    }
    await this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS);
  }

  private admitRate(key: string, perMinute: number): boolean {
    const now = Date.now();
    const entry = this.rates.get(key);
    if (!entry || now - entry.windowStart > 60_000) {
      this.rates.set(key, { windowStart: now, count: 1 });
      return true;
    }
    if (entry.count >= perMinute) return false;
    entry.count += 1;
    return true;
  }
}

export function bearerFrom(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] as string) : null;
}
