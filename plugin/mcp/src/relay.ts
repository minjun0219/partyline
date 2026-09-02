// HTTP client for a Partyline relay. Every call takes the relay origin from
// configuration — there is no default and no fallback (SPEC.md §7.1).

import type { ErrorBody, PartyView, RecipientView } from "./types.ts";

export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(relayUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${relayUrl}${path}`, init);
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as ErrorBody & T;
  if (!res.ok) {
    throw new RelayError(res.status, body.error ?? "unknown", body.message ?? res.statusText);
  }
  return body;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// ---- channels -------------------------------------------------------------

export interface InviteInfo {
  token: string;
  expires_at: string;
  uses_remaining: number;
}

export async function createChannel(
  relayUrl: string,
  name: string,
  relayKey: string | null = null,
): Promise<{ channel_id: string; name: string; invite: InviteInfo }> {
  // Unauthenticated by design — the capability chain starts at the invite.
  // A closed relay (SPEC.md §8) wants its key here, and only here.
  return request(relayUrl, "/v1/channels", {
    method: "POST",
    headers: relayKey ? bearer(relayKey) : { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function joinChannel(
  relayUrl: string,
  channelId: string,
  inviteToken: string,
  displayName: string,
  machineLabel: string,
  about?: string,
): Promise<{
  party_id: string;
  party_token: string;
  channel: { channel_id: string; name: string };
  parties: PartyView[];
}> {
  return request(relayUrl, `/v1/channels/${channelId}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      invite_token: inviteToken,
      display_name: displayName,
      machine_label: machineLabel,
      about,
    }),
  });
}

export async function mintInvite(
  relayUrl: string,
  channelId: string,
  partyToken: string,
  ttlSeconds?: number,
  maxUses?: number,
): Promise<{ invite: InviteInfo }> {
  return request(relayUrl, `/v1/channels/${channelId}/invites`, {
    method: "POST",
    headers: bearer(partyToken),
    body: JSON.stringify({ ttl_seconds: ttlSeconds, max_uses: maxUses }),
  });
}

export async function listParties(
  relayUrl: string,
  channelId: string,
  partyToken: string,
): Promise<{ you: string; parties: PartyView[] }> {
  return request(relayUrl, `/v1/channels/${channelId}/parties`, {
    headers: bearer(partyToken),
  });
}

export async function updateMe(
  relayUrl: string,
  channelId: string,
  partyToken: string,
  patch: { display_name?: string; about?: string },
): Promise<{ party: PartyView }> {
  return request(relayUrl, `/v1/channels/${channelId}/parties/me`, {
    method: "PATCH",
    headers: bearer(partyToken),
    body: JSON.stringify(patch),
  });
}

export async function leaveChannel(
  relayUrl: string,
  channelId: string,
  partyToken: string,
): Promise<void> {
  await request(relayUrl, `/v1/channels/${channelId}/parties/me`, {
    method: "DELETE",
    headers: bearer(partyToken),
  });
}

export async function sendMessage(
  relayUrl: string,
  channelId: string,
  partyToken: string,
  to: string,
  body: string,
  replyTo?: string,
): Promise<{ message_id: string; seq: number; recipient: RecipientView }> {
  return request(relayUrl, `/v1/channels/${channelId}/messages`, {
    method: "POST",
    headers: bearer(partyToken),
    body: JSON.stringify({ to, body, reply_to: replyTo }),
  });
}

/** SPEC.md §4: any party may destroy the channel — the remedy for a
 * leaked invite or misplaced trust. Irreversible. */
export async function destroyChannel(
  relayUrl: string,
  channelId: string,
  partyToken: string,
): Promise<void> {
  await request(relayUrl, `/v1/channels/${channelId}`, {
    method: "DELETE",
    headers: bearer(partyToken),
  });
}

export async function ackInbox(
  relayUrl: string,
  channelId: string,
  partyToken: string,
  seq: number,
): Promise<void> {
  await request(relayUrl, `/v1/channels/${channelId}/inbox/ack`, {
    method: "POST",
    headers: bearer(partyToken),
    body: JSON.stringify({ seq }),
  });
}
