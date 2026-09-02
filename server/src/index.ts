// HTTP surface of the reference relay. Thin by design: every rule that
// matters lives in the Durable Objects (channel.ts, gate.ts); this file
// parses requests, applies the source rate limits for the unauthenticated
// doors, and maps DO results onto the wire shapes of SPEC.md.

import type { Context } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { bearerFrom, ChannelDO } from "./channel.ts";
import { ERROR_STATUS, type ErrorCode, errorBody } from "./errors.ts";
import { RateLimitDO } from "./gate.ts";
import { landingPage, pickLang } from "./landing.ts";
import { LIMITS, PROTOCOL_VERSIONS } from "./protocol.ts";

export { ChannelDO, RateLimitDO };

export interface Env {
  CHANNEL: DurableObjectNamespace<ChannelDO>;
  GATE: DurableObjectNamespace<RateLimitDO>;
}

type Ctx = Context<{ Bindings: Env }>;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// The only brake on the unauthenticated doors of an open relay (SPEC.md §8).
const CREATE_LIMIT = { limit: 10, windowMs: 300_000 };
const JOIN_LIMIT = { limit: 30, windowMs: 300_000 };

function gate(env: Env) {
  return env.GATE.get(env.GATE.idFromName("gate"));
}

function channel(env: Env, channelId: string) {
  return env.CHANNEL.get(env.CHANNEL.idFromName(channelId));
}

function sourceOf(c: Ctx): string {
  return c.req.header("CF-Connecting-IP") ?? "unknown";
}

function sendError(c: Ctx, code: ErrorCode, message: string) {
  return c.json(errorBody(code, message), ERROR_STATUS[code] as ContentfulStatusCode);
}

/** DO results are `{ ok: true, ... } | Fail`; map them onto HTTP. */
function respond<T extends { ok: boolean }>(c: Ctx, result: T, okStatus = 200) {
  if (!result.ok) {
    const failure = result as unknown as { error: ErrorCode; message: string };
    return sendError(c, failure.error, failure.message);
  }
  const { ok: _ok, ...body } = result as Record<string, unknown>;
  return c.json(body, okStatus as ContentfulStatusCode);
}

async function readJson(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await c.req.json()) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function fieldLength(value: string): number {
  // spec limits count code points, so spreading is the intended measure
  // oxlint-disable-next-line typescript/no-misused-spread
  return [...value].length;
}

const app = new Hono<{ Bindings: Env }>();

app.notFound((c) => c.json(errorBody("not_found", "no such endpoint"), 404));
app.onError((err, c) => {
  console.error("unhandled error", err);
  return c.json(errorBody("internal", "internal error"), 500);
});

// ---- relay metadata (SPEC.md §2, §8) --------------------------------------

// For the person who opens the relay URL in a browser (?lang=ko for Korean).
// Everything a program needs is under /v1.
app.get("/", (c) => c.html(landingPage(pickLang(c.req.query("lang")))));

app.get("/v1/relay", (c) => c.json({ protocol_versions: PROTOCOL_VERSIONS, limits: LIMITS }));

// ---- channels (SPEC.md §4) ------------------------------------------------

app.post("/v1/channels", async (c) => {
  // Unauthenticated by design — the capability model starts at the invite,
  // not here. Creation is rate-limited per source instead.
  if (
    !(await gate(c.env).admit(`create:${sourceOf(c)}`, CREATE_LIMIT.limit, CREATE_LIMIT.windowMs))
  ) {
    return sendError(c, "rate_limited", "too many channels created; wait for the window");
  }
  const body = await readJson(c);
  const name = asString(body?.name)?.trim() ?? "";
  if (fieldLength(name) > 64) {
    return sendError(c, "invalid_request", "name is at most 64 characters");
  }
  const channelId = `c_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const result = await channel(c.env, channelId).create(channelId, name);
  if (result.ok) {
    return c.json(
      {
        channel_id: channelId,
        name,
        created_at: new Date().toISOString(),
        invite: result.invite,
      },
      201,
    );
  }
  return respond(c, result);
});

/** Everything under /v1/channels/:id shares the identifier check. */
function channelIdFrom(c: Ctx): string | null {
  const id = c.req.param("id");
  return id && ID_PATTERN.test(id) ? id : null;
}

app.post("/v1/channels/:id/invites", async (c) => {
  const channelId = channelIdFrom(c);
  if (!channelId) return sendError(c, "not_found", "no such channel");
  const token = bearerFrom(c.req.header("Authorization") ?? null);
  if (!token) return sendError(c, "unauthorized", "party token required");
  const body = (await readJson(c)) ?? {};
  const ttl = typeof body.ttl_seconds === "number" ? body.ttl_seconds : undefined;
  const uses = typeof body.max_uses === "number" ? body.max_uses : undefined;
  const result = await channel(c.env, channelId).mintInvite(token, ttl, uses);
  return respond(c, result, 201);
});

app.post("/v1/channels/:id/join", async (c) => {
  const channelId = channelIdFrom(c);
  if (!channelId) return sendError(c, "not_found", "no such channel");
  if (!(await gate(c.env).admit(`join:${sourceOf(c)}`, JOIN_LIMIT.limit, JOIN_LIMIT.windowMs))) {
    return sendError(c, "rate_limited", "too many join attempts; wait for the window");
  }
  const body = await readJson(c);
  const inviteToken = asString(body?.invite_token);
  const displayName = asString(body?.display_name)?.trim();
  const machineLabel = asString(body?.machine_label)?.trim();
  const about = asString(body?.about)?.trim();
  if (!inviteToken || !displayName || !machineLabel) {
    return sendError(
      c,
      "invalid_request",
      "invite_token, display_name, and machine_label are required",
    );
  }
  if (fieldLength(displayName) < 1 || fieldLength(displayName) > 32) {
    return sendError(c, "invalid_request", "display_name is 1–32 characters");
  }
  if (fieldLength(machineLabel) < 1 || fieldLength(machineLabel) > 32) {
    return sendError(c, "invalid_request", "machine_label is 1–32 characters");
  }
  if (about !== undefined && fieldLength(about) > 140) {
    return sendError(c, "invalid_request", "about is at most 140 characters");
  }
  const result = await channel(c.env, channelId).join(
    inviteToken,
    displayName,
    machineLabel,
    about === "" ? undefined : about,
  );
  return respond(c, result, 201);
});

app.get("/v1/channels/:id/parties", async (c) => {
  const channelId = channelIdFrom(c);
  if (!channelId) return sendError(c, "not_found", "no such channel");
  const token = bearerFrom(c.req.header("Authorization") ?? null);
  if (!token) return sendError(c, "unauthorized", "party token required");
  const result = await channel(c.env, channelId).listParties(token);
  return respond(c, result);
});

app.patch("/v1/channels/:id/parties/me", async (c) => {
  const channelId = channelIdFrom(c);
  if (!channelId) return sendError(c, "not_found", "no such channel");
  const token = bearerFrom(c.req.header("Authorization") ?? null);
  if (!token) return sendError(c, "unauthorized", "party token required");
  const body = await readJson(c);
  const displayName = asString(body?.display_name)?.trim();
  const about = asString(body?.about)?.trim();
  if (
    displayName !== undefined &&
    (fieldLength(displayName) < 1 || fieldLength(displayName) > 32)
  ) {
    return sendError(c, "invalid_request", "display_name is 1–32 characters");
  }
  if (about !== undefined && fieldLength(about) > 140) {
    return sendError(c, "invalid_request", "about is at most 140 characters");
  }
  const patch: { display_name?: string; about?: string } = {};
  if (displayName !== undefined) patch.display_name = displayName;
  if (about !== undefined) patch.about = about;
  const result = await channel(c.env, channelId).updateMe(token, patch);
  return respond(c, result);
});

app.delete("/v1/channels/:id/parties/me", async (c) => {
  const channelId = channelIdFrom(c);
  if (!channelId) return sendError(c, "not_found", "no such channel");
  const token = bearerFrom(c.req.header("Authorization") ?? null);
  if (!token) return sendError(c, "unauthorized", "party token required");
  const result = await channel(c.env, channelId).leave(token);
  if (!result.ok) return respond(c, result);
  return c.body(null, 204);
});

// Any party may destroy the channel — the in-band remedy for a leaked
// invite or misplaced trust (SPEC.md §4).
app.delete("/v1/channels/:id", async (c) => {
  const channelId = channelIdFrom(c);
  if (!channelId) return sendError(c, "not_found", "no such channel");
  const token = bearerFrom(c.req.header("Authorization") ?? null);
  if (!token) return sendError(c, "unauthorized", "party token required");
  const result = await channel(c.env, channelId).destroyByParty(token);
  if (!result.ok) return respond(c, result);
  return c.body(null, 204);
});

// ---- messages (SPEC.md §5–§6) ---------------------------------------------

app.post("/v1/channels/:id/messages", async (c) => {
  const channelId = channelIdFrom(c);
  if (!channelId) return sendError(c, "not_found", "no such channel");
  const token = bearerFrom(c.req.header("Authorization") ?? null);
  if (!token) return sendError(c, "unauthorized", "party token required");
  const body = await readJson(c);
  const to = asString(body?.to);
  const text = asString(body?.body);
  const replyTo = asString(body?.reply_to);
  if (!to || text === undefined) {
    // `to` is required by design — there is no broadcast (SPEC.md §5).
    return sendError(c, "invalid_request", "to and body are required; there is no broadcast");
  }
  if (new TextEncoder().encode(text).byteLength > LIMITS.body_bytes) {
    return sendError(c, "too_large", `body exceeds ${LIMITS.body_bytes} bytes`);
  }
  const result = await channel(c.env, channelId).send(token, to, text, replyTo);
  return respond(c, result, 202);
});

app.get("/v1/channels/:id/inbox", async (c) => {
  const channelId = channelIdFrom(c);
  if (!channelId) return sendError(c, "not_found", "no such channel");
  const token = bearerFrom(c.req.header("Authorization") ?? null);
  if (!token) return sendError(c, "unauthorized", "party token required");
  const wait = Number.parseInt(c.req.query("wait") ?? "0", 10) || 0;
  const afterSeq = Number.parseInt(c.req.query("after_seq") ?? "0", 10) || 0;
  const limit = Number.parseInt(c.req.query("limit") ?? "16", 10) || 16;
  const result = await channel(c.env, channelId).poll(token, wait, afterSeq, limit);
  return respond(c, result);
});

app.post("/v1/channels/:id/inbox/ack", async (c) => {
  const channelId = channelIdFrom(c);
  if (!channelId) return sendError(c, "not_found", "no such channel");
  const token = bearerFrom(c.req.header("Authorization") ?? null);
  if (!token) return sendError(c, "unauthorized", "party token required");
  const body = await readJson(c);
  if (typeof body?.seq !== "number") return sendError(c, "invalid_request", "seq is required");
  const result = await channel(c.env, channelId).ack(token, body.seq);
  if (!result.ok) return respond(c, result);
  return c.body(null, 204);
});

app.get("/v1/channels/:id/stream", async (c) => {
  const channelId = channelIdFrom(c);
  if (!channelId) return sendError(c, "not_found", "no such channel");
  // The upgrade (and its authentication) happens inside the Durable Object.
  return channel(c.env, channelId).fetch(c.req.raw);
});

export default app;
