// SPEC.md §5 (addressed send, recipient block) and §6 (long poll, ack cursor).

import { describe, expect, it } from "vitest";
import type { MessageEnvelope, RecipientView } from "../src/protocol.ts";
import { api, bearer, post, twoParty } from "./helpers.ts";

function send(channelId: string, token: string, to: string, body: string, replyTo?: string) {
  return post(`/v1/channels/${channelId}/messages`, { to, body, reply_to: replyTo }, bearer(token));
}

async function poll(channelId: string, token: string, query = "") {
  const res = await api(`/v1/channels/${channelId}/inbox${query}`, { headers: bearer(token) });
  expect(res.status).toBe(200);
  return (await res.json()) as { messages: MessageEnvelope[]; last_seq: number };
}

describe("sending", () => {
  it("delivers an addressed message and reports the recipient's liveness", async () => {
    const { channelId, a, b } = await twoParty();
    const res = await send(channelId, a.party_token, b.party_id, "hello beta");
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      message_id: string;
      seq: number;
      recipient: RecipientView;
    };
    expect(body.message_id).toMatch(/^x_/);
    expect(body.seq).toBe(1);
    // §5: "queued" alone hides a misaddressed send — who got it must come back
    expect(body.recipient.party_id).toBe(b.party_id);
    expect(body.recipient.display_name).toBe("beta");
    expect(typeof body.recipient.online).toBe("boolean");
  });

  it("requires `to` — there is no broadcast", async () => {
    const { channelId, a } = await twoParty();
    const res = await post(
      `/v1/channels/${channelId}/messages`,
      { body: "hi" },
      bearer(a.party_token),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a `to` that is not a current party", async () => {
    const { channelId, a } = await twoParty();
    const res = await send(channelId, a.party_token, "p_nobody", "hi");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("no_such_recipient");
  });

  it("rejects oversized bodies with 413", async () => {
    const { channelId, a, b } = await twoParty();
    const res = await send(channelId, a.party_token, b.party_id, "x".repeat(70000));
    expect(res.status).toBe(413);
  });

  it("rate-limits senders", async () => {
    const { channelId, a, b } = await twoParty();
    let limited = false;
    for (let i = 0; i < 125; i++) {
      const res = await send(channelId, a.party_token, b.party_id, `m${i}`);
      if (res.status === 429) {
        limited = true;
        break;
      }
      expect(res.status).toBe(202);
    }
    expect(limited).toBe(true);
  });
});

describe("long poll and ack", () => {
  it("returns queued messages in seq order with full envelopes", async () => {
    const { channelId, a, b } = await twoParty();
    await send(channelId, a.party_token, b.party_id, "one");
    await send(channelId, a.party_token, b.party_id, "two", "x_earlier");
    const { messages, last_seq } = await poll(channelId, b.party_token);
    expect(messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(last_seq).toBe(2);
    const first = messages[0];
    expect(first?.v).toBe(1);
    expect(first?.channel_id).toBe(channelId);
    expect(first?.from.display_name).toBe("alpha");
    expect(first?.to).toBe(b.party_id);
    expect(first?.body).toBe("one");
    expect(first?.reply_to).toBeNull();
    expect(messages[1]?.reply_to).toBe("x_earlier");
  });

  it("redelivers until acked; the ack cursor is idempotent", async () => {
    const { channelId, a, b } = await twoParty();
    for (const text of ["one", "two", "three"]) {
      await send(channelId, a.party_token, b.party_id, text);
    }
    // reading deletes nothing
    await poll(channelId, b.party_token);
    const again = await poll(channelId, b.party_token);
    expect(again.messages).toHaveLength(3);

    const ack = await post(
      `/v1/channels/${channelId}/inbox/ack`,
      { seq: 2 },
      bearer(b.party_token),
    );
    expect(ack.status).toBe(204);
    const after = await poll(channelId, b.party_token);
    expect(after.messages.map((m) => m.seq)).toEqual([3]);

    // acking below the cursor changes nothing
    await post(`/v1/channels/${channelId}/inbox/ack`, { seq: 1 }, bearer(b.party_token));
    const still = await poll(channelId, b.party_token);
    expect(still.messages.map((m) => m.seq)).toEqual([3]);
  });

  it("filters with after_seq without acknowledging", async () => {
    const { channelId, a, b } = await twoParty();
    await send(channelId, a.party_token, b.party_id, "one");
    await send(channelId, a.party_token, b.party_id, "two");
    const filtered = await poll(channelId, b.party_token, "?after_seq=1");
    expect(filtered.messages.map((m) => m.seq)).toEqual([2]);
    const everything = await poll(channelId, b.party_token);
    expect(everything.messages).toHaveLength(2);
  });

  it("holds an empty poll until a message arrives", async () => {
    const { channelId, a, b } = await twoParty();
    const held = poll(channelId, b.party_token, "?wait=10");
    // give the poll a moment to register, then send
    await new Promise((resolve) => setTimeout(resolve, 100));
    await send(channelId, a.party_token, b.party_id, "wake up");
    const result = await held;
    expect(result.messages.map((m) => m.body)).toEqual(["wake up"]);
  });
});
