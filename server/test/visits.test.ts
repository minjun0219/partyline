// Optional page-view counting (src/visits.ts). Not part of the protocol, so
// this checks what the reference relay promises the people it counts: off
// unless the operator configures it, only the relay's own pages, no IP
// address or query string, nothing from /v1, and said on the pages when on.
// Values are set per request, like the relay key in closed.test.ts.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index.ts";
import { BASE } from "./helpers.ts";

const COUNTING = { POSTHOG_KEY: "phc_test_token", POSTHOG_HOST: "https://ph.test" };
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function visit(
  path: string,
  init: RequestInit = {},
  vars: { POSTHOG_KEY?: string; POSTHOG_HOST?: string } = COUNTING,
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(BASE + path, init), { ...env, ...vars }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Stands in for PostHog; every outbound fetch in these tests is a report. */
function capture() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() => Promise.resolve(new Response(null, { status: 200 })));
}

interface Report {
  url: string;
  body: {
    api_key: string;
    event: string;
    distinct_id: string;
    properties: Record<string, unknown>;
  };
}

function reports(spy: ReturnType<typeof capture>): Report[] {
  return spy.mock.calls.map(([input, init]) => ({
    url: input as string,
    body: JSON.parse(init?.body as string) as Report["body"],
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("page-view counting", () => {
  it("is off unless configured, and the pages do not mention it", async () => {
    const spy = capture();
    for (const path of ["/", "/join", "/llms.txt"]) {
      const res = await visit(path, {}, {});
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("PostHog");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("needs both the key and the host", async () => {
    const spy = capture();
    await visit("/", {}, { POSTHOG_KEY: COUNTING.POSTHOG_KEY });
    await visit("/", {}, { POSTHOG_HOST: COUNTING.POSTHOG_HOST });
    await visit("/", {}, { ...COUNTING, POSTHOG_KEY: " " });
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports one $pageview per page request to the configured host", async () => {
    const spy = capture();
    for (const path of ["/", "/join", "/llms.txt"]) {
      const res = await visit(path, { headers: { "User-Agent": "Mozilla/5.0 (test)" } });
      expect(res.status).toBe(200);
    }
    const sent = reports(spy);
    expect(sent.map((report) => report.url)).toEqual(Array(3).fill("https://ph.test/i/v0/e/"));
    expect(sent.map((report) => report.body.properties.$pathname)).toEqual([
      "/",
      "/join",
      "/llms.txt",
    ]);
    expect(sent[0]?.body).toMatchObject({
      api_key: "phc_test_token",
      event: "$pageview",
      properties: {
        $current_url: "https://relay.test/",
        $host: "relay.test",
        $referrer: "$direct",
        $referring_domain: "$direct",
        $raw_user_agent: "Mozilla/5.0 (test)",
        $lib: "partyline-relay",
        $process_person_profile: false,
        $geoip_disable: true,
      },
    });
  });

  it("makes every view its own visitor and session, with a current UUIDv7", async () => {
    const spy = capture();
    await visit("/");
    await visit("/");
    const [first, second] = reports(spy);
    expect(first?.body.distinct_id).toMatch(UUID_V7);
    expect(first?.body.properties.$session_id).toBe(first?.body.distinct_id);
    expect(second?.body.distinct_id).not.toBe(first?.body.distinct_id);
    const ms = Number.parseInt(
      (first?.body.distinct_id ?? "").replaceAll("-", "").slice(0, 12),
      16,
    );
    expect(Math.abs(Date.now() - ms)).toBeLessThan(60_000);
  });

  it("sends no query string, no referring page, and no visitor address", async () => {
    const spy = capture();
    await visit("/join?lang=ko&invite=c_x/secret_token", {
      headers: {
        Referer: "https://chat.example/thread/42?token=abc",
        "CF-Connecting-IP": "203.0.113.7",
      },
    });
    const [sent] = reports(spy);
    expect(sent?.body.properties).toMatchObject({
      $current_url: "https://relay.test/join",
      $pathname: "/join",
      $referrer: "https://chat.example",
      $referring_domain: "chat.example",
    });
    expect(sent?.body.properties).not.toHaveProperty("$ip");
    const raw = JSON.stringify(sent?.body);
    for (const leak of ["203.0.113.7", "secret_token", "lang=ko", "thread/42", "token=abc"]) {
      expect(raw).not.toContain(leak);
    }
  });

  it("accepts a host with a trailing slash or a path prefix", async () => {
    const spy = capture();
    await visit("/", {}, { ...COUNTING, POSTHOG_HOST: "https://ph.test/" });
    await visit("/", {}, { ...COUNTING, POSTHOG_HOST: " https://proxy.test/ingest// " });
    expect(reports(spy).map((report) => report.url)).toEqual([
      "https://ph.test/i/v0/e/",
      "https://proxy.test/ingest/i/v0/e/",
    ]);
  });

  it("reports nothing from /v1 or robots.txt, and nothing for HEAD", async () => {
    const spy = capture();
    expect((await visit("/v1/relay")).status).toBe(200);
    expect((await visit("/robots.txt")).status).toBe(200);
    expect((await visit("/", { method: "HEAD" })).status).toBe(200);
    const created = await visit("/v1/channels", {
      method: "POST",
      body: JSON.stringify({ name: "counted" }),
      headers: { "CF-Connecting-IP": crypto.randomUUID() },
    });
    expect(created.status).toBe(201);
    expect(spy).not.toHaveBeenCalled();
  });

  it("says so on both pages, in both languages, and in llms.txt", async () => {
    capture();
    for (const path of ["/", "/join", "/?lang=ko", "/join?lang=ko"]) {
      expect(await (await visit(path)).text()).toContain("PostHog");
    }
    const llms = await (await visit("/llms.txt")).text();
    expect(llms).toContain("PostHog");
    expect(llms).toContain("nothing under /v1 is recorded");
  });

  it("serves the page even when the report fails", async () => {
    const spy = capture();
    spy.mockRejectedValueOnce(new Error("unreachable"));
    spy.mockResolvedValueOnce(new Response("no", { status: 401 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const down = await visit("/");
    expect(down.status).toBe(200);
    expect(await down.text()).toContain("This relay runs Partyline");
    expect((await visit("/llms.txt")).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
