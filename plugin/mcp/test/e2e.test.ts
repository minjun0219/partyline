// End-to-end against the reference relay in this repository: open channel
// creation → two parties by invitation → send → stream delivery with
// ack-after-inject → reconnect without duplicate injection → party
// destruction. This is the interop check between
// the client modules and server/ — the two sides of SPEC.md meeting.
//
// Dev-time only: spawning the sibling package's wrangler dev is a monorepo
// convenience; nothing in src/ reaches outside plugin/.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Seat, saveConfig } from "../src/config.ts";
import { generateChannelKey, type SealedMessage, seal } from "../src/e2e.ts";
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
  relayProcess = spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(PORT)], {
    cwd: SERVER_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1" },
  });
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
      seal(KEY, created.channel_id, { from: a.party_id, from_name: "alpha", to: b.party_id, body });

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
