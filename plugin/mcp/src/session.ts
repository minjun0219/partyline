// Where received messages actually land: the Claude Code session that spawned
// this MCP server. Claude Code maintains a session registry under
// ~/.claude/sessions/<pid>.json; since an MCP server is a child process of
// its session, the parent pid names our own entry. Messages are delivered by
// writing one NDJSON line to the session's messaging socket.

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MessageEnvelope } from "./types.ts";

export interface SessionSelf {
  sessionId: string;
  socketPath: string;
}

interface RegistryEntry {
  pid?: number;
  sessionId?: string;
  messagingSocketPath?: string;
}

function readEntry(path: string): RegistryEntry | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as RegistryEntry;
    return typeof raw?.sessionId === "string" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Find our own session. Primary: the registry entry named by our parent pid.
 * Fallback: match CLAUDE_CODE_MESSAGING_SOCKET against all entries. Returns
 * null when the session cannot be identified — receiving must not start then,
 * because there is nowhere to deliver to.
 */
export function resolveSelf(env: NodeJS.ProcessEnv = process.env): SessionSelf | null {
  const dir = join(homedir(), ".claude", "sessions");

  const byParent = readEntry(join(dir, `${process.ppid}.json`));
  if (byParent?.messagingSocketPath && byParent.sessionId) {
    return { sessionId: byParent.sessionId, socketPath: byParent.messagingSocketPath };
  }

  const envSocket = env.CLAUDE_CODE_MESSAGING_SOCKET?.trim();
  if (envSocket) {
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        const entry = readEntry(join(dir, file));
        if (entry?.messagingSocketPath === envSocket && entry.sessionId) {
          return { sessionId: entry.sessionId, socketPath: entry.messagingSocketPath };
        }
      }
    } catch {
      // no registry directory — cannot resolve
    }
  }
  return null;
}

/**
 * What the session actually sees. Claude Code shows the content and not the
 * `from` field, so everything the session needs to act on the message — who
 * sent it, from where, and the id to put in reply_to — has to be in the text.
 * One header line, then the body verbatim. The header is the client's; the
 * body is the sender's (SPEC.md §7.3).
 */
export function formatInjection(envelope: MessageEnvelope, channelLabel: string): string {
  const parts = [
    `partyline · ${envelope.from.display_name} @ ${envelope.from.machine_label} → you`,
    `channel ${channelLabel}`,
    `id ${envelope.message_id}`,
  ];
  if (envelope.reply_to) parts.push(`reply_to ${envelope.reply_to}`);
  return `${parts.join(" · ")}\n\n${envelope.body}`;
}

/** The NDJSON line the session socket accepts. `session_id` must match the
 * target session — it is what prevents misdelivery through a stale socket. */
export function buildWireLine(opts: { sessionId: string; from: string; content: string }): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: opts.content },
    session_id: opts.sessionId,
    from: opts.from,
    uuid: randomUUID(),
  })}\n`;
}

/**
 * Write one message into the session. Resolves only after the socket write
 * has settled; callers acknowledge to the relay only after this resolves
 * (ack-after-inject, SPEC.md §7.5) — a failed write must leave the message
 * on the relay, because a duplicate is recoverable and a loss is not.
 */
export function injectToSocket(
  self: SessionSelf,
  from: string,
  content: string,
  timeoutMs = 3000,
): Promise<void> {
  const line = buildWireLine({ sessionId: self.sessionId, from, content });
  return new Promise((resolve, reject) => {
    const socket = createConnection(self.socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`inject timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on("connect", () => {
      socket.write(line, (err) => {
        if (err) {
          clearTimeout(timer);
          socket.destroy();
          reject(err);
          return;
        }
        // Give the peer a moment to drain before closing; an immediate end
        // can drop the write.
        setTimeout(() => {
          clearTimeout(timer);
          socket.end();
          resolve();
        }, 150);
      });
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
