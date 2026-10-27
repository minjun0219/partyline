// Invite URLs (SPEC.md §3): <relay_url>/join#<channel_id>/<invite_token>/<channel_key>.
// The invite is complete on its own — a session that never configured a
// relay can join with nothing else — which is also why joining one is
// choosing a relay, and the caller has to say so. The channel key rides in
// the fragment and is never sent to the relay.

import { decodeChannelKey } from "./e2e.ts";

export interface Invite {
  relay_url: string;
  channel_id: string;
  invite_token: string;
  channel_key: string;
}

const JOIN_PATH = "/join";

export function formatInviteUrl(invite: Invite): string {
  return `${invite.relay_url.replace(/\/+$/, "")}${JOIN_PATH}#${invite.channel_id}/${invite.invite_token}/${invite.channel_key}`;
}

/**
 * Null for anything that is not an invite URL — callers decide what to say.
 * An invite without a channel key is not one: every channel is encrypted.
 */
export function parseInviteUrl(value: string): Invite | null {
  const hash = value.indexOf("#");
  if (hash < 0) return null;
  const base = value.slice(0, hash);
  const fragment = value.slice(hash + 1);
  if (!base.endsWith(JOIN_PATH)) return null;
  const relay_url = base.slice(0, -JOIN_PATH.length);
  let origin: URL;
  try {
    origin = new URL(relay_url);
  } catch {
    return null;
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") return null;
  if (origin.search || origin.hash) return null;
  // The key is the last segment and has a fixed alphabet; the token between
  // is the relay's and is taken as it stands.
  const first = fragment.indexOf("/");
  const last = fragment.lastIndexOf("/");
  if (first <= 0 || last <= first) return null;
  const channel_id = fragment.slice(0, first);
  const invite_token = fragment.slice(first + 1, last);
  const channel_key = fragment.slice(last + 1);
  if (!invite_token || !decodeChannelKey(channel_key)) return null;
  return { relay_url, channel_id, invite_token, channel_key };
}
