// Wire-level types and relay limits, mirroring SPEC.md. Field names here are
// the field names on the wire — do not rename one side without the other.

/** Published via GET /v1/relay and enforced throughout (SPEC.md §2, §8). */
export const LIMITS = {
  body_bytes: 65536,
  inbox_messages: 256,
  message_ttl_seconds: 86400,
  party_ttl_seconds: 900,
  long_poll_max_seconds: 60,
} as const;

export const PROTOCOL_VERSIONS = ["1"] as const;

export const INVITE_TTL_MS = 3600 * 1000;
export const INVITE_TTL_MAX_MS = 86400 * 1000;
export const INVITE_MAX_USES = 16;
export const CHANNEL_GRACE_MS = 300 * 1000;
export const PRESENCE_GRACE_MS = 90 * 1000;
/** SPEC.md §6: the relay pings at least every 30 s. */
export const WS_PING_INTERVAL_MS = 30 * 1000;

export interface PartyView {
  party_id: string;
  display_name: string;
  machine_label: string;
  about?: string;
  online: boolean;
  joined_at: string;
  last_seen_at: string;
}

export interface MessageEnvelope {
  v: 1;
  message_id: string;
  channel_id: string;
  seq: number;
  from: {
    party_id: string;
    display_name: string;
    machine_label: string;
  };
  to: string;
  body: string;
  sent_at: string;
  reply_to: string | null;
}

/** SPEC.md §5: returned on every send so a misaddressed message is visible. */
export interface RecipientView {
  party_id: string;
  display_name: string;
  online: boolean;
  last_seen_at: string;
}

// WebSocket frames (SPEC.md §6). Server → client unless noted.
export type ServerFrame =
  | { type: "ready"; party_id: string; last_seq: number; parties: PartyView[] }
  | { type: "message"; message: MessageEnvelope }
  | { type: "presence"; event: "joined" | "left" | "updated"; party: PartyView }
  | { type: "ping" }
  | { type: "error"; error: string; message: string };

export type ClientFrame = { type: "ack"; seq: number } | { type: "pong" };

// WebSocket close codes (SPEC.md §6).
export const WS_CLOSE = {
  unauthorized: 4401,
  gone: 4404,
  superseded: 4409,
  rate_limited: 4429,
} as const;

export function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}
