// End-to-end against the reference relay in this repository: open channel
// creation → two parties by invitation → send → stream delivery with
// ack-after-inject → reconnect without duplicate injection → party
// destruction. This is the interop check between
// the client modules and server/ — the two sides of SPEC.md meeting.
// The second part drives the bundled MCP server's tools the way a session
// does, with the relay behind a proxy that can drop, stall, or answer for it.
//
// Dev-time only: spawning the sibling package's wrangler dev is a monorepo
// convenience; nothing in src/ reaches outside plugin/.

import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Seat, saveConfig } from "../src/config.ts";
import { generateChannelKey, type SealedMessage, seal } from "../src/e2e.ts";
import { formatInviteUrl } from "../src/invite.ts";
import { ChannelConnection } from "../src/receive.ts";
import * as relay from "../src/relay.ts";
import type { MessageEnvelope } from "../src/types.ts";

const PORT = 8971;
const RELAY = `http://127.0.0.1:${PORT}`;
const SERVER_DIR = join(import.meta.dirname, "..", "..", "..", "server");
const KEY = generateChannelKey();

let relayProcess: ChildProcess;
let env: NodeJS.ProcessEnv;
let configTmp: string;

async function relayReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${RELAY}/v1/relay`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("relay did not come up");
}

beforeAll(async () => {
  configTmp = mkdtempSync(join(tmpdir(), "partyline-e2e-"));
  env = { ...process.env, PARTYLINE_CONFIG_DIR: configTmp };
  // Fresh relay state every run: the relay's creation limit (10 channels per
  // 5 minutes) would otherwise carry over between runs through .wrangler/state.
  const relayState = join(configTmp, "relay-state");
  relayProcess = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "--port", String(PORT), "--persist-to", relayState],
    {
      cwd: SERVER_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1" },
    },
  );
  await relayReady();
}, 90_000);

afterAll(() => {
  relayProcess?.kill("SIGTERM");
  rmSync(configTmp, { recursive: true, force: true });
});

function collect(seat: Seat) {
  const injected: SealedMessage[] = [];
  const notes: string[] = [];
  const connection = new ChannelConnection({
    relayUrl: RELAY,
    seat,
    persistSeat: () => {},
    inject: async (_envelope: MessageEnvelope, message) => {
      injected.push(message);
    },
    note: (note) => notes.push(note),
  });
  return { injected, notes, connection };
}

async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("client against the reference relay", () => {
  it("runs the whole story", async () => {
    // no membership, no secrets: create a channel and enter by invitation
    saveConfig(
      { relay_url: RELAY, relay_key: null, relay_headers: null, machine_label: "e2e-machine" },
      env,
    );
    loadConfig(env);
    const created = await relay.createChannel(RELAY, "e2e");

    const a = await relay.joinChannel(
      RELAY,
      created.channel_id,
      created.invite.token,
      "alpha",
      "machine-a",
    );
    const inviteB = await relay.mintInvite(RELAY, created.channel_id, a.party_token);
    const b = await relay.joinChannel(
      RELAY,
      created.channel_id,
      inviteB.invite.token,
      "beta",
      "machine-b",
    );

    const seatB: Seat = {
      relay_url: RELAY,
      channel_id: created.channel_id,
      channel_name: "e2e",
      party_id: b.party_id,
      party_token: b.party_token,
      display_name: "beta",
      last_injected_seq: 0,
      channel_key: KEY,
      seen_ids: {},
    };
    const sealFor = (body: string) =>
      seal(KEY, created.channel_id, {
        from: a.party_id,
        from_name: "alpha",
        from_label: "laptop",
        to: b.party_id,
        body,
      });

    // stream delivery with ack-after-inject
    const first = collect(seatB);
    first.connection.start();
    await until(() => first.connection.status === "connected", "stream connect");

    const sent = await relay.sendMessage(
      RELAY,
      created.channel_id,
      a.party_token,
      b.party_id,
      sealFor("hello across processes"),
    );
    expect(sent.recipient.display_name).toBe("beta");
    expect(sent.recipient.online).toBe(true);

    await until(() => first.injected.length === 1, "first delivery");
    expect(first.injected[0]?.body).toBe("hello across processes");
    expect(first.injected[0]?.from_name).toBe("alpha");
    expect(seatB.last_injected_seq).toBe(1);

    // a plaintext body — what anyone without the key could send — is
    // refused, acked away, and noted where the user looks
    await relay.sendMessage(RELAY, created.channel_id, a.party_token, b.party_id, "plain");
    await until(() => first.notes.length === 1, "refusal note");
    expect(first.notes[0]).toContain("plaintext body");
    expect(first.injected).toHaveLength(1);
    expect(seatB.last_injected_seq).toBe(2);
    first.connection.stop();

    // acked messages do not come back; the cursor survives the "restart"
    const second = collect(seatB);
    second.connection.start();
    await until(() => second.connection.status === "connected", "reconnect");
    await relay.sendMessage(
      RELAY,
      created.channel_id,
      a.party_token,
      b.party_id,
      sealFor("second"),
    );
    await until(() => second.injected.length >= 1, "second delivery");
    expect(second.injected.map((m) => m.body)).toEqual(["second"]);
    second.connection.stop();

    // leave cleans up
    await relay.leaveChannel(RELAY, created.channel_id, b.party_token);
    await expect(relay.listParties(RELAY, created.channel_id, b.party_token)).rejects.toMatchObject(
      { status: 404 },
    );

    // any remaining party can burn the channel (SPEC.md §4)
    await relay.destroyChannel(RELAY, created.channel_id, a.party_token);
    await expect(relay.listParties(RELAY, created.channel_id, a.party_token)).rejects.toMatchObject(
      { status: 410 },
    );
  }, 60_000);
});

// ---- the MCP tools, end to end ---------------------------------------------

type ProxyMode = "pass" | "refuse" | "hang" | "html404";

/** A TCP proxy in front of the relay: forwards, or plays a relay that is down,
 * stalled, or hidden behind something answering 404 in its place. */
async function startProxy(targetPort: number) {
  const sockets = new Set<Socket>();
  let mode: ProxyMode = "pass";
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  };
  const server = createServer((client) => {
    track(client);
    if (mode === "refuse") client.destroy();
    else if (mode === "html404") {
      client.once("data", () =>
        client.end(
          "HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot here\n",
        ),
      );
    } else if (mode === "pass") {
      const upstream = connect(targetPort, "127.0.0.1");
      track(upstream);
      client.pipe(upstream);
      upstream.pipe(client);
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    }
    // hang: accept, read nothing, answer nothing
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    /** Switching also cuts every open connection, so pooled ones cannot dodge the new mode. */
    set(next: ProxyMode) {
      mode = next;
      for (const socket of sockets) socket.destroy();
    },
    cutAll() {
      for (const socket of sockets) socket.destroy();
    },
    close: () => server.close(),
  };
}

/** The bundled server over stdio, as a Claude Code session spawns it. */
class McpClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, (msg: { result: Record<string, unknown> }) => void>();
  private nextId = 1;

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn("node", [join(import.meta.dirname, "..", "dist", "server.cjs")], {
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buffer = "";
    this.child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const msg = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (typeof msg.id === "number") this.pending.get(msg.id)?.(msg);
        index = buffer.indexOf("\n");
      }
    });
  }

  request(method: string, params: unknown): Promise<{ result: Record<string, unknown> }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async init(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    });
    this.child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
  }

  async call(name: string, args: Record<string, unknown> = {}) {
    const { result } = await this.request("tools/call", { name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    return { text, isError: result.isError === true };
  }

  kill(): void {
    this.child.kill();
  }
}

describe("leave and destroy through the MCP tools", () => {
  let proxy: Awaited<ReturnType<typeof startProxy>>;
  let mcp: McpClient;
  let home: string;
  let mcpConfig: string;
  let session: Server;
  const injected: string[] = [];

  beforeAll(async () => {
    proxy = await startProxy(PORT);
    home = mkdtempSync(join(tmpdir(), "partyline-tools-"));
    mcpConfig = join(home, "config");
    // The session registry entry the server finds through its parent pid,
    // and the socket a session would read injected messages from.
    const socketPath = join(home, "s.sock");
    session = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          injected.push(JSON.parse(buffer.slice(0, index)).message.content);
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
        }
      });
    });
    await new Promise<void>((resolve) => session.listen(socketPath, resolve));
    mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "sessions", `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: "e2e-session",
        messagingSocketPath: socketPath,
      }),
    );
    mcp = new McpClient({
      ...process.env,
      HOME: home,
      PARTYLINE_CONFIG_DIR: mcpConfig,
      CLAUDE_CODE_MESSAGING_SOCKET: socketPath,
    });
    await mcp.init();
  });

  // A failed test must not leave the next one behind a dead relay.
  beforeEach(() => proxy.set("pass"));

  afterAll(() => {
    mcp?.kill();
    proxy?.close();
    session?.close();
    rmSync(home, { recursive: true, force: true });
  });

  const savedSeats = (): Record<string, { party_token: string }> => {
    try {
      return JSON.parse(readFileSync(join(mcpConfig, "seats.json"), "utf8"));
    } catch {
      return {};
    }
  };

  /** Another machine opens a channel on the relay; this session joins it through the proxy. */
  async function joinedChannel(name: string) {
    const created = await relay.createChannel(RELAY, name);
    const alpha = await relay.joinChannel(
      RELAY,
      created.channel_id,
      created.invite.token,
      "alpha",
      "machine-a",
    );
    const { invite } = await relay.mintInvite(RELAY, created.channel_id, alpha.party_token);
    const joined = await mcp.call("partyline_join", {
      invite: formatInviteUrl({
        relay_url: proxy.url,
        channel_id: created.channel_id,
        invite_token: invite.token,
        channel_key: KEY,
      }),
      display_name: "beta",
    });
    expect(joined.isError, joined.text).toBe(false);
    const channelId = created.channel_id;
    await connected(channelId);
    const { parties } = await relay.listParties(RELAY, channelId, alpha.party_token);
    const beta = parties.find((p) => p.display_name === "beta")?.party_id ?? "";
    const send = (body: string) =>
      relay.sendMessage(
        RELAY,
        channelId,
        alpha.party_token,
        beta,
        seal(KEY, channelId, {
          from: alpha.party_id,
          from_name: "alpha",
          from_label: "machine-a",
          to: beta,
          body,
        }),
      );
    return { channelId, alphaToken: alpha.party_token, send };
  }

  async function connected(channelId: string): Promise<void> {
    let status = "";
    for (let i = 0; i < 100; i++) {
      status = (await mcp.call("partyline_status")).text;
      if (
        status
          .split("\n")
          .some((l) => l.startsWith(`channel ${channelId}`) && l.includes(": connected"))
      )
        return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`stream for ${channelId} never connected:\n${status}`);
  }

  async function isJoined(channelId: string): Promise<boolean> {
    const { text } = await mcp.call("partyline_status");
    return text.split("\n").some((l) => l.startsWith(`channel ${channelId}`));
  }

  it("keeps the seat when the relay is unreachable, resumes receiving, and discards it only when forced", async () => {
    const { channelId, send } = await joinedChannel("unreachable");
    proxy.set("refuse");
    const failed = await mcp.call("partyline_leave", { channel_id: channelId });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("nothing changed");
    expect(failed.text).toContain("force: true");
    expect(await isJoined(channelId)).toBe(true);
    expect(savedSeats()[channelId]).toBeDefined();

    // Receiving resumed after the failed call: once the relay is back, messages land.
    proxy.set("pass");
    await connected(channelId);
    const before = injected.length;
    await send("still here");
    await until(() => injected.length > before, "delivery after a failed leave");
    expect(injected.at(-1)).toContain("still here");

    proxy.set("refuse");
    const forced = await mcp.call("partyline_leave", { channel_id: channelId, force: true });
    expect(forced.isError).toBe(false);
    expect(forced.text).toContain("without the relay's confirmation");
    expect(await isJoined(channelId)).toBe(false);
    expect(savedSeats()[channelId]).toBeUndefined();
    proxy.set("pass");
  }, 30_000);

  it("does not take a 404 from something in front of the relay for a dead seat", async () => {
    const { channelId, alphaToken } = await joinedChannel("not-relay");
    proxy.set("html404");
    const failed = await mcp.call("partyline_destroy", { channel_id: channelId });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("not_relay");
    expect(failed.text).toContain("retry partyline_destroy");
    expect(savedSeats()[channelId]).toBeDefined();

    proxy.set("pass");
    const destroyed = await mcp.call("partyline_destroy", { channel_id: channelId });
    expect(destroyed.text).toContain("destroyed for all parties");
    await expect(relay.listParties(RELAY, channelId, alphaToken)).rejects.toMatchObject({
      code: "gone",
    });
  }, 30_000);

  it("says a destroy with an invalid seat left the channel alive", async () => {
    const { channelId, alphaToken } = await joinedChannel("invalid-seat");
    // The seat dies at the relay behind this session's back.
    await relay.leaveChannel(RELAY, channelId, savedSeats()[channelId]?.party_token ?? "");
    const result = await mcp.call("partyline_destroy", { channel_id: channelId });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("could NOT destroy");
    expect(savedSeats()[channelId]).toBeUndefined();
    // Still there for the other party.
    await expect(relay.listParties(RELAY, channelId, alphaToken)).resolves.toBeDefined();
    await relay.destroyChannel(RELAY, channelId, alphaToken);
  }, 30_000);

  it("refuses a second teardown while one waits on the relay", async () => {
    const { channelId } = await joinedChannel("concurrent");
    proxy.set("hang");
    const leaving = mcp.call("partyline_leave", { channel_id: channelId });
    await new Promise((r) => setTimeout(r, 300));
    const second = await mcp.call("partyline_destroy", { channel_id: channelId });
    expect(second.isError).toBe(true);
    expect(second.text).toContain("already in progress");
    // The stalled call ends in a failure that keeps the seat.
    proxy.cutAll();
    const first = await leaving;
    expect(first.isError).toBe(true);
    expect(first.text).toContain("nothing changed");
    expect(savedSeats()[channelId]).toBeDefined();

    proxy.set("pass");
    const left = await mcp.call("partyline_leave", { channel_id: channelId });
    expect(left.text).toBe(`left ${channelId}`);
  }, 30_000);

  it("does not write back a seat released while a message was being injected", async () => {
    const { channelId, send } = await joinedChannel("inject-race");
    const before = injected.length;
    await send("arriving as we leave");
    // The socket has the line; the client resolves the injection 150 ms later.
    await until(() => injected.length > before, "injection started", 5_000);
    const left = await mcp.call("partyline_leave", { channel_id: channelId });
    expect(left.text).toBe(`left ${channelId}`);
    await new Promise((r) => setTimeout(r, 500));
    expect(savedSeats()[channelId]).toBeUndefined();
  }, 30_000);

  it.skipIf(process.getuid?.() === 0)(
    "reports a destroy that succeeded even when the seat file cannot be written",
    async () => {
      const { channelId } = await joinedChannel("read-only");
      const file = join(mcpConfig, "seats.json");
      chmodSync(file, 0o400);
      try {
        const result = await mcp.call("partyline_destroy", { channel_id: channelId });
        expect(result.isError).toBe(false);
        expect(result.text).toContain("destroyed for all parties");
        expect(result.text).toContain("could not remove the saved seat");
        expect(await isJoined(channelId)).toBe(false);
      } finally {
        chmodSync(file, 0o600);
      }
    },
    30_000,
  );
});
