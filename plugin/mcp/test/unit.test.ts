import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configDir,
  dropSeat,
  loadConfig,
  loadSeats,
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
    saveConfig({ relay_url: "https://relay.example", machine_label: "m" }, env);
    expect(loadConfig(env).relay_url).toBe("https://relay.example");
    env.PARTYLINE_RELAY_URL = "https://other.example";
    expect(loadConfig(env).relay_url).toBe("https://other.example");
  });

  it("writes credential files with 0600 (SPEC.md §7.6)", () => {
    const env = tempEnv();
    saveConfig({ relay_url: null, machine_label: "m" }, env);
    const mode = statSync(join(configDir(env), "config.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("seats", () => {
  it("persists, updates, and drops seats per channel", () => {
    const env = tempEnv();
    const seat = {
      relay_url: "https://relay.example",
      channel_id: "c_1",
      channel_name: "ops",
      party_id: "p_1",
      party_token: "pt_x",
      display_name: "alpha",
      last_injected_seq: 0,
    };
    saveSeat(seat, env);
    saveSeat({ ...seat, last_injected_seq: 7 }, env);
    expect(loadSeats(env).c_1?.last_injected_seq).toBe(7);
    dropSeat("c_1", env);
    expect(loadSeats(env).c_1).toBeUndefined();
  });

  it("drops seats that do not name their relay rather than guessing one", () => {
    const env = tempEnv();
    const { relay_url: _omitted, ...legacy } = {
      relay_url: "https://relay.example",
      channel_id: "c_old",
      channel_name: "ops",
      party_id: "p_1",
      party_token: "pt_x",
      display_name: "alpha",
      last_injected_seq: 0,
    };
    saveSeat(legacy as unknown as Seat, env);
    expect(loadSeats(env).c_old).toBeUndefined();
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
      await new Promise((r) => setTimeout(r, 400));
      expect(connection.lastError).toMatch(/silent for \ds — presumed dead/);
      expect(connection.status).toBe("backoff");
      // First backoff is 1 s; the silent relay then gets a fresh stream.
      await new Promise((r) => setTimeout(r, 1200));
      expect(connections).toBe(2);
    } finally {
      connection.stop();
      wss.close();
    }
  });
});
