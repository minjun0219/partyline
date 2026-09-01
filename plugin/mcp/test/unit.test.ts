import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configDir, dropSeat, loadConfig, loadSeats, saveConfig, saveSeat } from "../src/config.ts";
import { buildWireLine } from "../src/session.ts";

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
