// SPEC.md §2 (relay metadata), §4 (open creation), §8 (source rate limits —
// the only brake on an admin-less relay's unauthenticated doors).

import { describe, expect, it } from "vitest";
import { api, createChannel, join, post } from "./helpers.ts";

describe("GET /v1/relay", () => {
  it("publishes protocol versions and limits without authentication", async () => {
    const res = await api("/v1/relay");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      protocol_versions: string[];
      limits: Record<string, number>;
    };
    expect(body.protocol_versions).toContain("1");
    expect(body.limits.body_bytes).toBe(65536);
    expect(body.limits.long_poll_max_seconds).toBe(60);
  });
});

describe("open channel creation", () => {
  it("requires no credential", async () => {
    const setup = await createChannel("open");
    expect(setup.channel_id).toMatch(/^c_/);
    expect(setup.invite.uses_remaining).toBe(1);
  });

  it("rate-limits creation per source", async () => {
    const source = { "CF-Connecting-IP": "203.0.113.9" };
    for (let i = 0; i < 10; i++) {
      const res = await post("/v1/channels", { name: `c${i}` }, source);
      expect(res.status).toBe(201);
    }
    const eleventh = await post("/v1/channels", { name: "c10" }, source);
    expect(eleventh.status).toBe(429);
  });

  it("rate-limits join attempts per source", async () => {
    const setup = await createChannel();
    const source = { "CF-Connecting-IP": "203.0.113.10" };
    let limited = false;
    for (let i = 0; i < 35; i++) {
      const res = await post(
        `/v1/channels/${setup.channel_id}/join`,
        { invite_token: "iv_wrong", display_name: `g${i}`, machine_label: "m" },
        source,
      );
      if (res.status === 429) {
        limited = true;
        break;
      }
      expect(res.status).toBe(404); // bad invite hides existence until then
    }
    expect(limited).toBe(true);
  });
});

describe("party-initiated destruction (SPEC.md §4)", () => {
  it("lets any party destroy the channel; everything after is gone", async () => {
    const setup = await createChannel("burn-me");
    const a = await join(setup.channel_id, setup.invite.token, "alpha");
    const res = await api(`/v1/channels/${setup.channel_id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${a.party_token}` },
    });
    expect(res.status).toBe(204);
    const after = await api(`/v1/channels/${setup.channel_id}/parties`, {
      headers: { Authorization: `Bearer ${a.party_token}` },
    });
    expect(after.status).toBe(410);
  });

  it("is not available to non-parties — and does not confirm existence", async () => {
    const setup = await createChannel();
    await join(setup.channel_id, setup.invite.token, "alpha");
    const wrongToken = await api(`/v1/channels/${setup.channel_id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer pt_wrong" },
    });
    expect(wrongToken.status).toBe(404);
    const noToken = await api(`/v1/channels/${setup.channel_id}`, { method: "DELETE" });
    expect(noToken.status).toBe(401);
    // channel is still alive
    const alive = await post(
      `/v1/channels/${setup.channel_id}/join`,
      { invite_token: "iv_wrong", display_name: "x", machine_label: "m" },
      { "CF-Connecting-IP": crypto.randomUUID() },
    );
    expect(alive.status).toBe(404);
  });
});
