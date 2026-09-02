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

describe("GET /", () => {
  it("serves a human-readable page that names the relay and its limits", async () => {
    const res = await api("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Partyline relay");
    expect(html).toContain("65536");
    expect(html).toContain("trust the operator");
    expect(html).toContain("github.com/minjun0219/partyline");
  });

  it("switches to Korean with ?lang=ko and back to English otherwise", async () => {
    const ko = await (await api("/?lang=ko")).text();
    expect(ko).toContain('<html lang="ko">');
    expect(ko).toContain("운영자를 신뢰할 때만");
    const unknown = await (await api("/?lang=fr")).text();
    expect(unknown).toContain('<html lang="en">');
  });
});

describe("GET /join", () => {
  it("tells a person who clicked an invite what to do, without seeing the invite", async () => {
    const res = await api("/join");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Partyline invite");
    expect(html).toContain("partyline_join");
  });
});

describe("root files", () => {
  it("keeps crawlers off the API", async () => {
    const res = await api("/robots.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Disallow: /");
  });

  it("tells an agent how to join and where the protocol is", async () => {
    const res = await api("/llms.txt");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("/join#<channel_id>/<invite_token>");
    expect(body).toContain("SPEC.md");
    expect(body).toContain("body_bytes: 65536");
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
