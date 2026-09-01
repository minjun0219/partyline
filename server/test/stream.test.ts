// SPEC.md §6 — the WebSocket transport: ready, backlog, live delivery, the
// ack frame, and single-stream supersession.

import { describe, expect, it } from "vitest";
import { WS_CLOSE } from "../src/protocol.ts";
import { bearer, openStream, post, twoParty } from "./helpers.ts";

function send(channelId: string, token: string, to: string, body: string) {
  return post(`/v1/channels/${channelId}/messages`, { to, body }, bearer(token));
}

describe("WebSocket stream", () => {
  it("sends ready with the party list, then backlog, then live traffic", async () => {
    const { channelId, a, b } = await twoParty();
    await send(channelId, a.party_token, b.party_id, "queued before connect");

    const { frames } = await openStream(channelId, b.party_token);
    const ready = await frames.next();
    expect(ready.type).toBe("ready");
    if (ready.type === "ready") {
      expect(ready.party_id).toBe(b.party_id);
      expect(ready.last_seq).toBe(1);
      expect(ready.parties.map((p) => p.display_name).sort()).toEqual(["alpha", "beta"]);
    }

    const backlog = await frames.next();
    expect(backlog.type).toBe("message");
    if (backlog.type === "message") expect(backlog.message.body).toBe("queued before connect");

    await send(channelId, a.party_token, b.party_id, "live");
    const live = await frames.next();
    expect(live.type).toBe("message");
    if (live.type === "message") expect(live.message.seq).toBe(2);
  });

  it("applies the ack frame as a cursor", async () => {
    const { channelId, a, b } = await twoParty();
    await send(channelId, a.party_token, b.party_id, "one");
    await send(channelId, a.party_token, b.party_id, "two");

    const first = await openStream(channelId, b.party_token);
    await first.frames.next(); // ready
    await first.frames.next(); // one
    await first.frames.next(); // two
    first.ws.send(JSON.stringify({ type: "ack", seq: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    first.ws.close(1000, "done");

    // a reconnect replays only what was not acked
    const second = await openStream(channelId, b.party_token);
    const ready = await second.frames.next();
    expect(ready.type).toBe("ready");
    const replay = await second.frames.next();
    expect(replay.type).toBe("message");
    if (replay.type === "message") {
      expect(replay.message.seq).toBe(2);
      expect(replay.message.body).toBe("two");
    }
  });

  it("supersedes an older stream with close code 4409", async () => {
    const { channelId, b } = await twoParty();
    const first = await openStream(channelId, b.party_token);
    await first.frames.next(); // ready
    const second = await openStream(channelId, b.party_token);
    await second.frames.next(); // ready on the new stream
    const closed = await first.frames.waitClose();
    expect(closed.code).toBe(WS_CLOSE.superseded);
  });

  it("announces presence changes to connected parties", async () => {
    const { channelId, a, b } = await twoParty();
    const stream = await openStream(channelId, a.party_token);
    await stream.frames.next(); // ready

    const invite = await post(`/v1/channels/${channelId}/invites`, {}, bearer(b.party_token));
    const token = ((await invite.json()) as { invite: { token: string } }).invite.token;
    await post(
      `/v1/channels/${channelId}/join`,
      { invite_token: token, display_name: "gamma", machine_label: "machine-c" },
      { "CF-Connecting-IP": crypto.randomUUID() },
    );
    const presence = await stream.frames.next();
    expect(presence.type).toBe("presence");
    if (presence.type === "presence") {
      expect(presence.event).toBe("joined");
      expect(presence.party.display_name).toBe("gamma");
    }
  });

  it("rejects a stream without a valid token, hiding existence", async () => {
    const { channelId } = await twoParty();
    const { api } = await import("./helpers.ts");
    const res = await api(`/v1/channels/${channelId}/stream`, {
      headers: { Upgrade: "websocket", ...bearer("pt_wrong") },
    });
    expect(res.status).toBe(404);
  });
});
