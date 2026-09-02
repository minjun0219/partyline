// SPEC.md §8 (closed relays): one optional static key gates channel creation
// and nothing else. Set through the binding rather than a config file, so the
// same worker is exercised open (every other test) and closed (this one).

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index.ts";
import { BASE, bearer, createChannel, join } from "./helpers.ts";

const KEY = "rk_test_correct_horse";

async function closedFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(BASE + path, init), { ...env, RELAY_KEY: KEY }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function create(headers: Record<string, string> = {}) {
  return closedFetch("/v1/channels", {
    method: "POST",
    body: JSON.stringify({ name: "keyed" }),
    headers: { "CF-Connecting-IP": crypto.randomUUID(), ...headers },
  });
}

describe("closed relay (SPEC.md §8)", () => {
  it("advertises itself in GET /v1/relay; an open relay says so too", async () => {
    const closed = (await (await closedFetch("/v1/relay")).json()) as { closed: boolean };
    expect(closed.closed).toBe(true);
    const ctx = createExecutionContext();
    const open = (await (await app.fetch(new Request(`${BASE}/v1/relay`), env, ctx)).json()) as {
      closed: boolean;
    };
    expect(open.closed).toBe(false);
  });

  it("tells an agent reading llms.txt that a key is needed to create", async () => {
    const body = await (await closedFetch("/llms.txt")).text();
    expect(body).toContain("relay_key");
    expect(body).toContain("Joining with an invite needs no key");
  });

  it("refuses creation without the key or with a wrong one", async () => {
    const missing = await create();
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as { error: string }).error).toBe("unauthorized");
    const wrong = await create(bearer("rk_test_wrong"));
    expect(wrong.status).toBe(401);
    const longer = await create(bearer(`${KEY}x`));
    expect(longer.status).toBe(401);
  });

  it("creates with the key, and the channel works like any other", async () => {
    const res = await create(bearer(KEY));
    expect(res.status).toBe(201);
    const setup = (await res.json()) as Awaited<ReturnType<typeof createChannel>>;
    expect(setup.channel_id).toMatch(/^c_/);
    // Joining never needs the key: the invite is complete on its own (SPEC.md §3).
    const a = await join(setup.channel_id, setup.invite.token, "alpha");
    expect(a.party_token).toMatch(/^pt_/);
  });

  it("counts refused keys against the creation limit", async () => {
    const source = { "CF-Connecting-IP": "203.0.113.77" };
    for (let i = 0; i < 10; i++) {
      const res = await closedFetch("/v1/channels", {
        method: "POST",
        body: JSON.stringify({ name: `g${i}` }),
        headers: source,
      });
      expect(res.status).toBe(401);
    }
    const eleventh = await closedFetch("/v1/channels", {
      method: "POST",
      body: JSON.stringify({ name: "g10" }),
      headers: { ...source, ...bearer(KEY) },
    });
    expect(eleventh.status).toBe(429);
  });
});
