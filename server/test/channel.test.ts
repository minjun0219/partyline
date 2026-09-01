// SPEC.md §4 — creation, invites, join, names, party list, leave — and
// §8's existence hiding.

import { describe, expect, it } from "vitest";
import type { PartyView } from "../src/protocol.ts";
import { api, bearer, createChannel, join, post, twoParty } from "./helpers.ts";

describe("channel creation and join", () => {
  it("creates a private channel with a bootstrap invite, and creating does not join", async () => {
    const setup = await createChannel("release-work");
    expect(setup.channel_id).toMatch(/^c_/);
    expect(setup.invite.uses_remaining).toBe(1);
    // no parties yet — the creator joins like anyone else
    const joined = await join(setup.channel_id, setup.invite.token, "creator");
    expect(joined.party_id).toMatch(/^p_/);
    expect(joined.party_token).toMatch(/^pt_/);
  });

  it("requires display_name and machine_label", async () => {
    const setup = await createChannel();
    const res = await post(`/v1/channels/${setup.channel_id}/join`, {
      invite_token: setup.invite.token,
      display_name: "ghost",
    });
    expect(res.status).toBe(400);
  });

  it("consumes single-use invites", async () => {
    const setup = await createChannel();
    await join(setup.channel_id, setup.invite.token, "first");
    const reuse = await post(
      `/v1/channels/${setup.channel_id}/join`,
      { invite_token: setup.invite.token, display_name: "second", machine_label: "m" },
      { "CF-Connecting-IP": crypto.randomUUID() },
    );
    expect(reuse.status).toBe(404); // §8: a dead invite does not confirm existence
  });

  it("rejects duplicate display names with 409, never a silent rename", async () => {
    const { channelId, a } = await twoParty();
    const invite = await post(`/v1/channels/${channelId}/invites`, {}, bearer(a.party_token));
    const token = ((await invite.json()) as { invite: { token: string } }).invite.token;
    const res = await post(
      `/v1/channels/${channelId}/join`,
      { invite_token: token, display_name: "alpha", machine_label: "m" },
      { "CF-Connecting-IP": crypto.randomUUID() },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("name_taken");
  });

  it("caps invite ttl and uses", async () => {
    const { channelId, a } = await twoParty();
    const res = await post(
      `/v1/channels/${channelId}/invites`,
      { ttl_seconds: 999999, max_uses: 999 },
      bearer(a.party_token),
    );
    expect(res.status).toBe(201);
    const { invite } = (await res.json()) as {
      invite: { expires_at: string; uses_remaining: number };
    };
    expect(invite.uses_remaining).toBe(16);
    expect(new Date(invite.expires_at).getTime()).toBeLessThanOrEqual(Date.now() + 86400_000);
  });
});

describe("parties", () => {
  it("lists parties with machine label, about, and presence — nothing machine-local", async () => {
    const { channelId, a } = await twoParty();
    const res = await api(`/v1/channels/${channelId}/parties`, {
      headers: bearer(a.party_token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { you: string; parties: PartyView[] };
    expect(body.you).toBe(a.party_id);
    expect(body.parties).toHaveLength(2);
    const alpha = body.parties.find((p) => p.display_name === "alpha");
    expect(alpha?.machine_label).toBe("machine-a");
    expect(alpha?.online).toBe(true);
    for (const p of body.parties) {
      expect(Object.keys(p).sort()).toEqual(
        [
          "about",
          "display_name",
          "joined_at",
          "last_seen_at",
          "machine_label",
          "online",
          "party_id",
        ].filter((k) => k !== "about" || p.about !== undefined),
      );
    }
  });

  it("renames via PATCH me and rejects collisions", async () => {
    const { channelId, a } = await twoParty();
    const ok = await api(`/v1/channels/${channelId}/parties/me`, {
      method: "PATCH",
      body: JSON.stringify({ display_name: "alpha2", about: "renamed" }),
      headers: bearer(a.party_token),
    });
    expect(ok.status).toBe(200);
    const collision = await api(`/v1/channels/${channelId}/parties/me`, {
      method: "PATCH",
      body: JSON.stringify({ display_name: "beta" }),
      headers: bearer(a.party_token),
    });
    expect(collision.status).toBe(409);
  });

  it("leave releases the name and invalidates the token", async () => {
    const { channelId, a, b } = await twoParty();
    const res = await api(`/v1/channels/${channelId}/parties/me`, {
      method: "DELETE",
      headers: bearer(a.party_token),
    });
    expect(res.status).toBe(204);
    const after = await api(`/v1/channels/${channelId}/parties`, {
      headers: bearer(a.party_token),
    });
    expect(after.status).toBe(404); // token is dead, and existence is hidden (§8)
    // the released name is usable again
    const invite = await post(`/v1/channels/${channelId}/invites`, {}, bearer(b.party_token));
    const token = ((await invite.json()) as { invite: { token: string } }).invite.token;
    const rejoin = await join(channelId, token, "alpha");
    expect(rejoin.party_id).not.toBe(a.party_id);
  });
});

describe("existence hiding (SPEC.md §8)", () => {
  it("answers unknown channels and wrong tokens identically", async () => {
    const { channelId } = await twoParty();
    const headers = bearer("pt_definitely-wrong");
    const unknown = await api("/v1/channels/c_doesnotexist/parties", { headers });
    const known = await api(`/v1/channels/${channelId}/parties`, { headers });
    expect(unknown.status).toBe(404);
    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
  });
});
