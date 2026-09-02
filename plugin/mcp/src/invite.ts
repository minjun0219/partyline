// Invite URLs (SPEC.md §3): <relay_url>/join#<channel_id>/<invite_token>.
// The invite is complete on its own — a session that never configured a
// relay can join with nothing else — which is also why joining one is
// choosing a relay, and the caller has to say so.

export interface Invite {
  relay_url: string;
  channel_id: string;
  invite_token: string;
}

const JOIN_PATH = "/join";

export function formatInviteUrl(invite: Invite): string {
  return `${invite.relay_url.replace(/\/+$/, "")}${JOIN_PATH}#${invite.channel_id}/${invite.invite_token}`;
}

/** Null for anything that is not an invite URL — callers decide what to say. */
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
  const slash = fragment.indexOf("/");
  if (slash <= 0) return null;
  const channel_id = fragment.slice(0, slash);
  const invite_token = fragment.slice(slash + 1);
  if (!channel_id || !invite_token) return null;
  return { relay_url, channel_id, invite_token };
}
