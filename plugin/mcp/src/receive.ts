// The receive side: one WebSocket subscription per joined channel, with the
// delivery discipline that makes at-least-once safe end to end:
//
//   dedupe (seq cursor) → inject into the session → persist cursor → ack
//
// An injection failure stops everything for that channel until reconnect —
// acking anything after a failed inject would move the relay's cursor past a
// message that never reached the session (the cursor deletes everything at or
// below the acked seq). A duplicate is recoverable; a silent loss is not.

import WebSocket, { type RawData } from "ws";
import type { Seat } from "./config.ts";
import type { MessageEnvelope, ServerFrame } from "./types.ts";

// ws hands frames over as Buffer, Buffer[] or ArrayBuffer depending on the runtime
function rawText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return (raw instanceof ArrayBuffer ? Buffer.from(raw) : raw).toString("utf8");
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** SPEC.md §6: the relay pings at least every 30 s. */
const PING_INTERVAL_MS = 30_000;
/**
 * Three missed pings and the stream is presumed dead. A half-open socket
 * (laptop slept, NAT entry expired) raises no close event on its own, so
 * without this a stream can sit at "connected" forever while messages pile
 * up in the relay inbox.
 */
const STALE_AFTER_MS = 3 * PING_INTERVAL_MS;
const WATCHDOG_TICK_MS = 10_000;

export interface ConnectionDeps {
  relayUrl: string;
  seat: Seat;
  persistSeat(seat: Seat): void;
  inject(envelope: MessageEnvelope): Promise<void>;
  /** One-line status notes surfaced through partyline_status. */
  note(text: string): void;
  /** Watchdog thresholds — overridable for tests only. */
  staleAfterMs?: number;
  watchdogTickMs?: number;
}

export type ConnectionStatus = "connecting" | "connected" | "backoff" | "stopped";

export class ChannelConnection {
  status: ConnectionStatus = "connecting";
  injected = 0;
  lastError: string | null = null;
  /** Epoch ms of lastError — so an outage can be dated without the user's memory. */
  lastErrorAt: number | null = null;
  /** Epoch ms the current stream opened; null while not connected. */
  connectedAt: number | null = null;
  /** Streams opened over this connection's life — 1 is the first, more means reconnects. */
  streams = 0;
  /** Set when the connection will not come back without user action. */
  stopReason: string | null = null;
  /** Epoch ms of the last frame of any kind (pings included); null until open. */
  lastFrameAt: number | null = null;

  private ws: WebSocket | null = null;
  private backoffMs = BACKOFF_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private deliberate = false;
  /** Serializes message handling — frames arrive sync, injection is async. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ConnectionDeps) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.deliberate = true;
    this.status = "stopped";
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopWatchdog();
    this.ws?.close(1000, "client stopped");
    this.ws = null;
  }

  private startWatchdog(ws: WebSocket): void {
    this.stopWatchdog();
    const staleAfterMs = this.deps.staleAfterMs ?? STALE_AFTER_MS;
    this.watchdog = setInterval(() => {
      const silentMs = Date.now() - (this.lastFrameAt ?? 0);
      if (silentMs < staleAfterMs) return;
      // Drop the socket ourselves; its close event is ignored because
      // this.ws no longer points at it.
      this.stopWatchdog();
      this.ws = null;
      ws.terminate();
      this.scheduleReconnect(`stream silent for ${Math.round(silentMs / 1000)}s — presumed dead`);
    }, this.deps.watchdogTickMs ?? WATCHDOG_TICK_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private connect(): void {
    const { relayUrl, seat } = this.deps;
    const url = `${relayUrl.replace(/^http/, "ws")}/v1/channels/${seat.channel_id}/stream`;
    this.status = "connecting";
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${seat.party_token}` },
    });
    this.ws = ws;

    ws.on("open", () => {
      this.status = "connected";
      this.backoffMs = BACKOFF_BASE_MS;
      this.lastFrameAt = Date.now();
      this.connectedAt = this.lastFrameAt;
      this.streams += 1;
      this.startWatchdog(ws);
    });
    ws.on("message", (raw) => {
      this.lastFrameAt = Date.now();
      let frame: ServerFrame;
      try {
        frame = JSON.parse(rawText(raw)) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (frame.type === "message") {
        this.chain = this.chain.then(() => this.handleMessage(ws, frame.message));
      }
    });
    ws.on("close", (code, reasonBuf) => {
      // Not ours any more: stopped, or the watchdog already replaced it.
      if (this.deliberate || this.ws !== ws) return;
      this.stopWatchdog();
      const reason = reasonBuf.toString();
      // Permanent closes: reconnecting would either fight another process for
      // the same seat (4409) or retry a seat that no longer exists.
      if (code === 4409) {
        this.halt(`stream superseded — another process holds this seat (${reason})`);
        return;
      }
      if (code === 4401 || code === 4404) {
        this.halt(`relay closed the stream (${code} ${reason}) — rejoin with a fresh invite`);
        return;
      }
      this.scheduleReconnect(`stream closed (${code} ${reason || "no reason"})`);
    });
    ws.on("error", (err) => {
      this.fail(String(err instanceof Error ? err.message : err));
      // "close" follows and drives the reconnect.
    });
  }

  private fail(message: string): void {
    this.lastError = message;
    this.lastErrorAt = Date.now();
  }

  private halt(reason: string): void {
    this.status = "stopped";
    this.stopReason = reason;
    this.connectedAt = null;
    this.deps.note(reason);
    this.ws = null;
  }

  private scheduleReconnect(cause: string): void {
    this.status = "backoff";
    this.fail(cause);
    this.connectedAt = null;
    this.ws = null;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private async handleMessage(ws: WebSocket, envelope: MessageEnvelope): Promise<void> {
    const { seat } = this.deps;
    if (envelope.seq <= seat.last_injected_seq) {
      // Already delivered in a previous life (persisted cursor) — this is a
      // replay after a reconnect or restart. Just re-acknowledge.
      this.ack(ws, envelope.seq);
      return;
    }
    try {
      await this.deps.inject(envelope);
    } catch (err) {
      // Ack nothing, close, and let the reconnect replay from the inbox.
      this.fail(`inject failed: ${err instanceof Error ? err.message : String(err)}`);
      try {
        ws.close(1000, "inject failed");
      } catch {
        // already closing
      }
      return;
    }
    this.injected += 1;
    seat.last_injected_seq = envelope.seq;
    // Persist before acking: if we crash between the two, the message is
    // re-delivered and the cursor skips the duplicate injection.
    this.deps.persistSeat(seat);
    this.ack(ws, envelope.seq);
  }

  private ack(ws: WebSocket, seq: number): void {
    try {
      ws.send(JSON.stringify({ type: "ack", seq }));
    } catch {
      // The reconnect replay path re-acks via the cursor.
    }
  }
}
