// Smoke test of the committed bundle: speak MCP over stdio and list tools.
// Guards the artifact itself — a broken dist/server.cjs would otherwise only
// surface after someone installs the plugin.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const configDir = mkdtempSync(join(tmpdir(), "partyline-smoke-"));

afterAll(() => rmSync(configDir, { recursive: true, force: true }));

function rpc(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

describe("bundled MCP server", () => {
  it("initializes and exposes the partyline tools", async () => {
    const child = spawn("node", [join(import.meta.dirname, "..", "dist", "server.cjs")], {
      env: { ...process.env, PARTYLINE_CONFIG_DIR: configDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses: Record<number, unknown> = {};
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const msg = JSON.parse(line);
          if (typeof msg.id === "number") responses[msg.id] = msg;
        } catch {
          // partial line
        }
        index = buffer.indexOf("\n");
      }
    });

    child.stdin.write(
      rpc(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" },
      }),
    );

    const waitFor = async (id: number) => {
      for (let i = 0; i < 100 && !responses[id]; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(responses[id], `no response for request ${id}`).toBeDefined();
      return responses[id] as { result: Record<string, unknown> };
    };

    const init = await waitFor(1);
    expect((init.result.serverInfo as { name: string }).name).toBe("partyline");

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    child.stdin.write(rpc(2, "tools/list", {}));
    const tools = await waitFor(2);
    const names = (tools.result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual([
      "partyline_channel_create",
      "partyline_destroy",
      "partyline_invite",
      "partyline_join",
      "partyline_leave",
      "partyline_peers",
      "partyline_send",
      "partyline_status",
      "partyline_update_me",
    ]);

    // status must work unconfigured and must say there is no default relay
    child.stdin.write(rpc(3, "tools/call", { name: "partyline_status", arguments: {} }));
    const status = await waitFor(3);
    const textOut = (status.result.content as { text: string }[])[0]?.text ?? "";
    expect(textOut).toContain("NOT CONFIGURED");

    child.kill();
  }, 20_000);
});
