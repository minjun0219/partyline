import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configDir,
  dropSeat,
  loadConfig,
  loadSeats,
  relayForCreate,
  saveConfig,
  saveSeat,
  type Seat,
} from "../src/config.ts";
import { formatInviteUrl, parseInviteUrl } from "../src/invite.ts";
import { ChannelConnection } from "../src/receive.ts";
import { buildWireLine, formatInjection } from "../src/session.ts";

let dir: string | null = null;
function tempEnv(): NodeJS.ProcessEnv {
  dir = mkdtempSync(join(tmpdir(), "partyline-test-"));
  return { PARTYLINE_CONFIG_DIR: dir };
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("config", () => {
  it("has no default relay URL (SPEC.md §7.1)", () => {
    const config = loadConfig(tempEnv());
    expect(config.relay_url).toBeNull();
  });

  it("takes the relay from the environment or the file, never from code", () => {
    const env = tempEnv();
    saveConfig({ relay_url: "https://relay.example", relay_key: null, machine_label: "m" }, env);
    expect(loadConfig(env).relay_url).toBe("https://relay.example");
    env.PARTYLINE_RELAY_URL = "https://other.example";
    expect(loadConfig(env).relay_url).toBe("https://other.example");
  });

  it("reads a relay key from the file or the environment, absent by default", () => {
    const env = tempEnv();
    expect(loadConfig(env).relay_key).toBeNull();
    saveConfig(
      { relay_url: "https://relay.example", relay_key: "rk_file\n", machine_label: "m" },
      env,
    );
    expect(loadConfig(env).relay_key).toBe("rk_file");
    env.PARTYLINE_RELAY_KEY = "rk_env";
    expect(loadConfig(env).relay_key).toBe("rk_env");
  });

  it("does not carry the file's key to a relay named by the environment (SPEC.md §9)", () => {
    const env = tempEnv();
    saveConfig(
      { relay_url: "https://relay.example", relay_key: "rk_file", machine_label: "m" },
      env,
    );
    env.PARTYLINE_RELAY_URL = "https://other.example";
    expect(loadConfig(env)).toMatchObject({ relay_url: "https://other.example", relay_key: null });
    env.PARTYLINE_RELAY_KEY = "rk_other";
    expect(loadConfig(env).relay_key).toBe("rk_other");
  });

  it("sends the relay key only to the configured relay (SPEC.md §9)", () => {
    const config = { relay_url: "https://relay.example/", relay_key: "rk", machine_label: "m" };
    expect(relayForCreate(config, undefined)).toEqual({ url: "https://relay.example", key: "rk" });
    expect(relayForCreate(config, "https://relay.example")).toEqual({
      url: "https://relay.example",
      key: "rk",
    });
    expect(relayForCreate(config, "https://other.example")).toEqual({
      url: "https://other.example",
      key: null,
    });
    expect(relayForCreate({ ...config, relay_url: null }, undefined)).toBeNull();
  });

  it("writes credential files with 0600 (SPEC.md §7.6)", () => {
    const env = tempEnv();
    saveConfig({ relay_url: null, relay_key: null, machine_label: "m" }, env);
    const mode = statSync(join(configDir(env), "config.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("seats", () => {
  const seat: Seat = {
    relay_url: "https://relay.example",
    channel_id: "c_1",
    channel_name: "ops",
    party_id: "p_1",
    party_token: "pt_x",
    display_name: "alpha",
    last_injected_seq: 0,
  };

  it("persists, updates, and drops seats per channel", () => {
    const env = tempEnv();
    saveSeat(seat, env);
    saveSeat({ ...seat, last_injected_seq: 7 }, env);
    expect(loadSeats(env).c_1?.last_injected_seq).toBe(7);
    dropSeat("c_1", env);
    expect(loadSeats(env).c_1).toBeUndefined();
  });

  it("fills a legacy seat's relay from config, and drops it without one", () => {
    const env = tempEnv();
    const { relay_url: _omitted, ...legacy } = {
      ...seat,
      channel_id: "c_old",
      last_injected_seq: 5,
    };
    saveSeat(legacy as unknown as Seat, env);
    // Before invites carried a relay, config held the only one — so this is
    // the seat's relay, not a guess. Without config there is nothing to fill.
    expect(loadSeats(env).c_old).toBeUndefined();
    saveConfig({ relay_url: "https://relay.example", relay_key: null, machine_label: "m" }, env);
    expect(loadSeats(env).c_old).toMatchObject({
      relay_url: "https://relay.example",
      last_injected_seq: 5,
    });
  });

  it("keeps seats it cannot read when writing others (a filter is not a migration)", () => {
    const env = tempEnv();
    const { relay_url: _omitted, ...legacy } = seat;
    saveSeat({ ...(legacy as Seat), channel_id: "c_old" }, env);
    // unconfigured: c_old is invisible to loadSeats…
    expect(loadSeats(env).c_old).toBeUndefined();
    saveSeat({ ...seat, channel_id: "c_new" }, env);
    dropSeat("c_new", env);
    // …but a save and a drop of other seats must leave it in the file.
    const raw = JSON.parse(readFileSync(join(configDir(env), "seats.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(raw)).toEqual(["c_old"]);
  });
});

describe("invite URL (SPEC.md §3)", () => {
  const invite = {
    relay_url: "https://relay.example",
    channel_id: "c_4nRt9v",
    invite_token: "iv_abc-D_e",
  };

  it("round-trips through <relay>/join#<channel>/<token>", () => {
    const url = formatInviteUrl(invite);
    expect(url).toBe("https://relay.example/join#c_4nRt9v/iv_abc-D_e");
    expect(parseInviteUrl(url)).toEqual(invite);
  });

  it("tolerates a trailing slash on the relay URL", () => {
    expect(formatInviteUrl({ ...invite, relay_url: "https://relay.example/" })).toBe(
      "https://relay.example/join#c_4nRt9v/iv_abc-D_e",
    );
  });

  it("keeps a path prefix in front of the relay", () => {
    const url = "https://host.example/partyline/join#c_1/iv_1";
    expect(parseInviteUrl(url)?.relay_url).toBe("https://host.example/partyline");
  });

  it("rejects anything that is not an invite URL", () => {
    for (const bad of [
      "iv_abc",
      "https://relay.example/join",
      "https://relay.example/join#c_1",
      "https://relay.example/join#/iv_1",
      "https://relay.example/invite#c_1/iv_1",
      "https://relay.example/join?x=1#c_1/iv_1",
      "ftp://relay.example/join#c_1/iv_1",
    ]) {
      expect(parseInviteUrl(bad), bad).toBeNull();
    }
  });
});

describe("wire line", () => {
  it("is one NDJSON line carrying session_id for misdelivery protection", () => {
    const line = buildWireLine({
      sessionId: "s-123",
      from: "alpha (partyline:ops)",
      content: "hi\nthere",
    });
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe("user");
    expect(parsed.message).toEqual({ role: "user", content: "hi\nthere" });
    expect(parsed.session_id).toBe("s-123");
    expect(parsed.from).toBe("alpha (partyline:ops)");
    expect(typeof parsed.uuid).toBe("string");
  });
});

describe("injection text", () => {
  const envelope = {
    v: 1 as const,
    message_id: "x_abc",
    channel_id: "c_1",
    seq: 3,
    from: { party_id: "p_1", display_name: "alice", machine_label: "laptop" },
    to: "p_2",
    body: "tag pushed",
    sent_at: "2026-09-02T00:00:00.000Z",
    reply_to: null,
  };

  it("carries sender, machine and message_id ahead of the body", () => {
    const text = formatInjection(envelope, "release");
    expect(text).toBe(
      "partyline · alice @ laptop → you · channel release · id x_abc\n\ntag pushed",
    );
  });

  it("names the message being replied to when there is one", () => {
    expect(formatInjection({ ...envelope, reply_to: "x_prev" }, "release")).toContain(
      "id x_abc · reply_to x_prev\n\n",
    );
  });
});

describe("stream watchdog", () => {
  it("drops a stream that stops sending frames and reconnects", async () => {
    const { WebSocketServer } = await import("ws");
    // A relay that accepts the stream and then never pings (SPEC.md §6 says
    // it must, every 30 s) — the client has to notice on its own.
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.on("listening", resolve));
    const { port } = wss.address() as { port: number };
    let connections = 0;
    wss.on("connection", () => {
      connections += 1;
    });

    const notes: string[] = [];
    const connection = new ChannelConnection({
      relayUrl: `http://127.0.0.1:${port}`,
      seat: {
        relay_url: `http://127.0.0.1:${port}`,
        channel_id: "c_1",
        channel_name: "",
        party_id: "p_1",
        party_token: "t",
        display_name: "me",
        last_injected_seq: 0,
      },
      persistSeat: () => {},
      inject: async () => {},
      note: (t) => notes.push(t),
      staleAfterMs: 200,
      watchdogTickMs: 50,
    });
    connection.start();
    try {
      // /v1/channels/c_1/stream — the server above accepts any path
      await new Promise((r) => setTimeout(r, 100));
      expect(connection.status).toBe("connected");
      expect(connections).toBe(1);
      expect(connection.streams).toBe(1);
      const openedAt = connection.connectedAt;
      expect(openedAt).not.toBeNull();
      await new Promise((r) => setTimeout(r, 400));
      expect(connection.lastError).toMatch(/silent for \ds — presumed dead/);
      expect(connection.status).toBe("backoff");
      // The outage is dated, so status can say when — not just that — it broke.
      expect(connection.lastErrorAt).toBeGreaterThanOrEqual(openedAt as number);
      expect(connection.connectedAt).toBeNull();
      expect(connection.downSince).toBe(connection.lastErrorAt);
      expect(connection.downCause).toBe(connection.lastError);
      expect(connection.attempts).toBe(1);
      // First backoff is 1 s; the silent relay then gets a fresh stream.
      await new Promise((r) => setTimeout(r, 1200));
      expect(connections).toBe(2);
      expect(connection.streams).toBe(2);
      // The silent relay may have gone stale again by now; without the reset
      // on open the count would carry over from the first outage.
      expect(connection.attempts).toBeLessThanOrEqual(1);
    } finally {
      connection.stop();
      wss.close();
    }
  });

  it("reconnects at once when nudged during backoff", async () => {
    const { WebSocketServer } = await import("ws");
    // A relay that refuses the first stream — an outage — then accepts.
    let refuse = true;
    const wss = new WebSocketServer({
      port: 0,
      verifyClient: (_info: unknown, cb: (ok: boolean, code?: number) => void) => cb(!refuse, 503),
    });
    await new Promise<void>((resolve) => wss.on("listening", resolve));
    const { port } = wss.address() as { port: number };
    let connections = 0;
    wss.on("connection", () => {
      connections += 1;
    });

    const connection = new ChannelConnection({
      relayUrl: `http://127.0.0.1:${port}`,
      seat: {
        relay_url: `http://127.0.0.1:${port}`,
        channel_id: "c_1",
        channel_name: "",
        party_id: "p_1",
        party_token: "t",
        display_name: "me",
        last_injected_seq: 0,
      },
      persistSeat: () => {},
      inject: async () => {},
      note: () => {},
    });
    connection.start();
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect(connection.status).toBe("backoff");
      expect(connections).toBe(0);
      // The link is back (some HTTP call to the relay succeeded). Without the
      // nudge the stream would wait out the backoff timer.
      refuse = false;
      connection.nudge();
      await new Promise((r) => setTimeout(r, 200));
      expect(connection.status).toBe("connected");
      expect(connections).toBe(1);
    } finally {
      connection.stop();
      wss.close();
    }
  });
});
