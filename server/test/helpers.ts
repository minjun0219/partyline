import { SELF } from "cloudflare:test";
import type { ServerFrame } from "../src/protocol.ts";

export const BASE = "https://relay.test";

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(BASE + path, init);
}

export function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return api(path, { method: "POST", body: JSON.stringify(body), headers });
}

export interface ChannelSetup {
  channel_id: string;
  invite: { token: string; expires_at: string; uses_remaining: number };
}

/** Creation is unauthenticated; a random source keeps per-IP rate limits
 * (SPEC.md §8) from coupling unrelated tests. */
export async function createChannel(name = "test-channel"): Promise<ChannelSetup> {
  const res = await post("/v1/channels", { name }, { "CF-Connecting-IP": crypto.randomUUID() });
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return (await res.json()) as ChannelSetup;
}

export interface Joined {
  party_id: string;
  party_token: string;
}

export async function join(
  channelId: string,
  inviteToken: string,
  displayName: string,
  machineLabel = "machine-a",
  about?: string,
): Promise<Joined> {
  const res = await post(
    `/v1/channels/${channelId}/join`,
    { invite_token: inviteToken, display_name: displayName, machine_label: machineLabel, about },
    { "CF-Connecting-IP": crypto.randomUUID() },
  );
  if (res.status !== 201) throw new Error(`join failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as Joined;
}

/** Channel + two joined parties — the standard fixture. */
export async function twoParty() {
  const setup = await createChannel();
  const a = await join(setup.channel_id, setup.invite.token, "alpha", "machine-a");
  const inviteRes = await post(
    `/v1/channels/${setup.channel_id}/invites`,
    {},
    bearer(a.party_token),
  );
  const invite = ((await inviteRes.json()) as { invite: { token: string } }).invite;
  const b = await join(setup.channel_id, invite.token, "beta", "machine-b");
  return { channelId: setup.channel_id, a, b };
}

export async function openStream(channelId: string, partyToken: string) {
  const res = await api(`/v1/channels/${channelId}/stream`, {
    headers: { Upgrade: "websocket", ...bearer(partyToken) },
  });
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`stream failed: ${res.status}`);
  }
  const ws = res.webSocket;
  ws.accept();
  return { ws, frames: frameCollector(ws) };
}

export function frameCollector(ws: WebSocket) {
  const queue: ServerFrame[] = [];
  const waiters: ((frame: ServerFrame) => void)[] = [];
  let closed: { code: number; reason: string } | null = null;
  const closeWaiters: ((info: { code: number; reason: string }) => void)[] = [];
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data as string) as ServerFrame;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queue.push(frame);
  });
  ws.addEventListener("close", (event) => {
    closed = { code: event.code, reason: event.reason };
    for (const waiter of closeWaiters.splice(0)) waiter(closed);
  });
  return {
    next(timeoutMs = 2000): Promise<ServerFrame> {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for frame")), timeoutMs);
        waiters.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
    },
    waitClose(timeoutMs = 2000): Promise<{ code: number; reason: string }> {
      if (closed) return Promise.resolve(closed);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs);
        closeWaiters.push((info) => {
          clearTimeout(timer);
          resolve(info);
        });
      });
    },
  };
}
