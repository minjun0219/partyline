// End-to-end encryption of message bodies (SPEC.md §6, "Encrypted bodies").
// The channel key travels only in invite URL fragments, so the relay carries
// ciphertext it cannot read and cannot forge. What it still sees — who
// addresses whom, when, and how much — is metadata this cannot hide.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";

const PREFIX = "pl1.";
const INFO = "partyline e2e v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** What the ciphertext carries. The sender's own word, not the relay's. */
export interface SealedMessage {
  /** Sender-chosen, random — the replay guard keys on it. */
  id: string;
  from: string;
  from_name: string;
  /** The sender's machine label. Sealed so the relay cannot rewrite it. */
  from_label: string;
  to: string;
  sent_at: string;
  body: string;
}

/** A fresh channel key, base64url without padding (43 characters). */
export function generateChannelKey(): string {
  return randomBytes(KEY_BYTES).toString("base64url");
}

/** Null unless value decodes to exactly 32 bytes. */
export function decodeChannelKey(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const raw = Buffer.from(value, "base64url");
  return raw.length === KEY_BYTES ? raw : null;
}

function messageKey(channelKey: string, channelId: string): Buffer {
  const raw = decodeChannelKey(channelKey);
  if (!raw) throw new Error("invalid channel key");
  return Buffer.from(hkdfSync("sha256", raw, channelId, INFO, KEY_BYTES));
}

function aad(channelId: string): Buffer {
  return Buffer.from(`${INFO}\n${channelId}`, "utf8");
}

export function isSealed(body: string): boolean {
  return body.startsWith(PREFIX);
}

export function seal(
  channelKey: string,
  channelId: string,
  message: Omit<SealedMessage, "id" | "sent_at">,
  now: Date = new Date(),
): string {
  const plain: SealedMessage = {
    id: randomUUID(),
    from: message.from,
    from_name: message.from_name,
    from_label: message.from_label,
    to: message.to,
    sent_at: now.toISOString(),
    body: message.body,
  };
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", messageKey(channelKey, channelId), nonce);
  cipher.setAAD(aad(channelId));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(plain), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return PREFIX + Buffer.concat([nonce, ciphertext]).toString("base64url");
}

/** Null for anything that is not a sealed body this key opens. */
export function open(channelKey: string, channelId: string, body: string): SealedMessage | null {
  if (!isSealed(body)) return null;
  const raw = Buffer.from(body.slice(PREFIX.length), "base64url");
  if (raw.length < NONCE_BYTES + TAG_BYTES) return null;
  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ciphertext = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
  let text: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", messageKey(channelKey, channelId), nonce);
    decipher.setAAD(aad(channelId));
    decipher.setAuthTag(tag);
    text = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
  let parsed: Partial<SealedMessage>;
  try {
    parsed = JSON.parse(text) as Partial<SealedMessage>;
  } catch {
    return null;
  }
  const fields = ["id", "from", "from_name", "from_label", "to", "sent_at", "body"] as const;
  if (!parsed || fields.some((f) => typeof parsed[f] !== "string")) return null;
  return parsed as SealedMessage;
}

/** How long a sealed message stays acceptable: the relay's message_ttl (SPEC.md §6). */
const MAX_AGE_MS = 86_400_000;
/** Clock skew tolerated between sender and recipient. */
const SKEW_MS = 5 * 60_000;
/** What a relay-assigned id may look like (SPEC.md §5). It reaches the session
 * in the injected header, so anything wider is relay text in the session. */
const RELAY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type Verdict = { ok: true; message: SealedMessage } | { ok: false; reason: string };

/**
 * The checks before a body reaches the session (SPEC.md §7.3). A relay
 * without the key can still hand over plaintext, reroute a sealed message to
 * another party, deliver an old one again, or dress its own ids up as text
 * for the session; each is refused here. `seen`
 * maps the ids already injected to when they may be forgotten; it is pruned
 * in place, and the caller records an id with remember() only once the
 * message has reached the session — an id recorded before a failed inject
 * would turn the relay's redelivery into a refused "replay".
 */
export function verify(
  channelKey: string,
  channelId: string,
  self: string,
  envelope: {
    message_id: string;
    from: { party_id: string };
    to: string;
    body: string;
    reply_to: string | null;
  },
  seen: Record<string, number>,
  now: number = Date.now(),
): Verdict {
  for (const [id, until] of Object.entries(seen)) {
    if (until <= now) delete seen[id];
  }
  if (
    !RELAY_ID.test(envelope.message_id) ||
    (envelope.reply_to !== null && !RELAY_ID.test(envelope.reply_to))
  ) {
    return { ok: false, reason: "relay-assigned id is not a plain identifier" };
  }
  if (!isSealed(envelope.body)) return { ok: false, reason: "plaintext body" };
  const message = open(channelKey, channelId, envelope.body);
  if (!message) return { ok: false, reason: "does not decrypt with the channel key" };
  if (message.to !== self || envelope.to !== self) {
    return { ok: false, reason: "sealed for another party" };
  }
  if (message.from !== envelope.from.party_id) {
    return { ok: false, reason: "sender does not match the envelope" };
  }
  const sentAt = Date.parse(message.sent_at);
  if (Number.isNaN(sentAt) || sentAt > now + SKEW_MS || sentAt < now - MAX_AGE_MS - SKEW_MS) {
    return { ok: false, reason: "sent_at outside the accepted window" };
  }
  if (message.id in seen) return { ok: false, reason: "replayed message" };
  return { ok: true, message };
}

/** Record an injected message so a later copy of it is refused as a replay. */
export function remember(seen: Record<string, number>, message: SealedMessage): void {
  seen[message.id] = Date.parse(message.sent_at) + MAX_AGE_MS + SKEW_MS;
}
