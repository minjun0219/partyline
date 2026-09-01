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
import { ChannelConnection } from "../src/receive.ts";
import * as relay from "../src/relay.ts";
import type { MessageEnvelope } from "../src/types.ts";

const PORT = 8971;
const RELAY = `http://127.0.0.1:${PORT}`;
const SERVER_DIR = join(import.meta.dirname, "..", "..", "..", "server");

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
  const injected: MessageEnvelope[] = [];
  const connection = new ChannelConnection({
    relayUrl: RELAY,
    seat,
    persistSeat: () => {},
    inject: async (envelope) => {
      injected.push(envelope);
    },
    note: () => {},
  });
  return { injected, connection };
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
    saveConfig({ relay_url: RELAY, machine_label: "e2e-machine" }, env);
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
      channel_id: created.channel_id,
      channel_name: "e2e",
      party_id: b.party_id,
      party_token: b.party_token,
      display_name: "beta",
      last_injected_seq: 0,
    };

    // stream delivery with ack-after-inject
    const first = collect(seatB);
    first.connection.start();
    await until(() => first.connection.status === "connected", "stream connect");

    const sent = await relay.sendMessage(
      RELAY,
      created.channel_id,
      a.party_token,
      b.party_id,
      "hello across processes",
    );
    expect(sent.recipient.display_name).toBe("beta");
    expect(sent.recipient.online).toBe(true);

    await until(() => first.injected.length === 1, "first delivery");
    expect(first.injected[0]?.body).toBe("hello across processes");
    expect(first.injected[0]?.from.display_name).toBe("alpha");
    expect(seatB.last_injected_seq).toBe(1);
    first.connection.stop();

    // acked messages do not come back; the cursor survives the "restart"
    const second = collect(seatB);
    second.connection.start();
    await until(() => second.connection.status === "connected", "reconnect");
    await relay.sendMessage(RELAY, created.channel_id, a.party_token, b.party_id, "second");
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
