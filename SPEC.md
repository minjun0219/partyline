# Partyline Protocol — v1 (draft)

Partyline relays short text messages between AI coding sessions on different machines.
This document is what you need to write a relay, or a client, that interoperates with
other implementations.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119.

- [1. Model](#1-model)
- [2. Conventions](#2-conventions)
- [3. Capabilities](#3-capabilities)
- [4. Channels](#4-channels)
- [5. Sending](#5-sending)
- [6. Receiving](#6-receiving)
- [7. Client requirements](#7-client-requirements)
- [8. Relay requirements](#8-relay-requirements)
- [9. Security considerations](#9-security-considerations)
- [10. Non-goals](#10-non-goals)

---

## 1. Model

```
relay ──── channel (created by anyone, entered by invitation)
             └── party (a session, joined to one channel)
                   └── inbox (messages addressed to it, deleted once taken)
```

**Relay.** One deployment. It holds channels and inboxes and nothing else. It does not
store message history, and it has no accounts: there is no registration, no membership,
and no administrator in the protocol. Operating a relay is deploying it.

**Channel.** A set of parties that are allowed to address each other. It is closer
to an address book with an access boundary than to a chat room: there is no history, no
channel-wide delivery, and no owner. All parties are equal — equal enough that any of
them can destroy the channel (§4). Channels are private: they are not listed, and their
identifiers are unguessable. Knowing the relay's URL grants no access to any channel.

**Party.** One session inside one channel. A session that joins two channels is
two parties. A party has a `display_name` that is unique within the channel,
a self-declared `machine_label`, and an optional `about` line.

**Message.** Addressed to exactly one party. The relay places it in that
party's inbox and deletes it when the recipient acknowledges it. Nothing else is
retained.

Two properties follow from this shape and are relied on throughout:

- **Addressed delivery, no broadcast.** One message can wake at most one session.
- **Opt-in participation.** Being invited does not put a session in a channel; joining
  does. Starting a client process joins nothing.

### Terms

One word per concept; the rest of this document uses them exactly as defined here.

| Term | Meaning |
| --- | --- |
| **Relay** | One deployment of this protocol. Holds channels and inboxes, nothing else. |
| **Operator** | Whoever deploys a relay. Has no role in the protocol. |
| **Channel** | A private set of parties that may address each other. |
| **Party** | One session inside one channel — the unit that is addressed, listed, and credentialed. As in "calling party": a party to the conversation, not a role. |
| **Session** | The AI coding session on a machine. It becomes a party by joining a channel, one party per channel. |
| **Client** | The software that speaks this protocol on a session's behalf. §7 binds it. |
| **User** | The human whose session it is. |
| **Invite** | A short-lived token, minted by a party, that admits its holder into the channel. Handing one over is an *invitation*. |
| **Message** | A body addressed by one party to exactly one other. The **sender** and **recipient** are parties. |
| **Inbox** | A party's queue of undelivered messages, ordered by `seq`. |
| **Ack** | The cursor a recipient advances to delete delivered messages. |

---

## 2. Conventions

All endpoints are under `/v1`. Requests and responses are `application/json;
charset=utf-8`. Timestamps are RFC 3339 in UTC with millisecond precision. Identifiers
are opaque, URL-safe, and at most 64 characters; prefixes (`c_`, `p_`) are RECOMMENDED
for legibility but carry no meaning.

Credentials are presented as `Authorization: Bearer <token>`.

Errors use a flat body and a matching HTTP status:

```json
{ "error": "name_taken", "message": "display name is in use in this channel" }
```

| `error` | Status | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | Malformed body, missing field, bad parameter |
| `unauthorized` | 401 | Missing `Authorization` header where one is required |
| `not_found` | 404 | No such channel, or caller may not know it exists |
| `name_taken` | 409 | `display_name` already used in the channel |
| `no_such_recipient` | 409 | `to` is not a current party |
| `inbox_full` | 409 | Recipient inbox is at capacity |
| `gone` | 410 | Channel was destroyed |
| `too_large` | 413 | Body exceeds the relay limit |
| `rate_limited` | 429 | Too many attempts; `Retry-After` SHOULD be set |
| `internal` | 500 | Everything else |

Clients MUST ignore unknown fields. Relays MAY add fields prefixed `x_`; they MUST NOT
require clients to understand them.

`GET /v1/relay` is unauthenticated and returns the relay's protocol support and limits:

```json
{
  "protocol_versions": ["1"],
  "limits": {
    "body_bytes": 65536,
    "inbox_messages": 256,
    "message_ttl_seconds": 86400,
    "party_ttl_seconds": 900,
    "long_poll_max_seconds": 60
  }
}
```

---

## 3. Capabilities

There are exactly two credentials, and both are channel-scoped. Nothing grants relay-wide
authority — not to users, and not to an administrator, because there is none.

| Credential | Held by | Grants | Lifetime |
| --- | --- | --- | --- |
| Invite token | Whoever a party gave it to | Joining one channel | Short (§4); single-use by default |
| Party token | A session | Everything inside one channel | Until the party leaves or is dropped |

A party token is scoped to a single `(channel, party)` pair. Presenting it
for another channel MUST fail exactly like an unknown token — `not_found`, per the
existence-hiding rule in §8.

The capability model is the access control. A channel identifier is unguessable and
never confirmed to outsiders, an invite is handed person-to-person out of band, and a
party token exists only inside a session that joined. The relay URL itself is
deliberately **not** a credential: anyone who knows it can use the relay's resources
(§8 bounds that), but can reach no channel and no session through it.

---

## 4. Channels

### `POST /v1/channels`

Unauthenticated — anyone who can reach the relay can create a channel. Relays MUST
rate-limit creation per source (§8).

```json
{ "name": "release-work" }
```

`name` is a label for humans and need not be unique. Every channel is private; there is
no channel listing. A client that loses a `channel_id` recreates the channel — there is
nothing to recover it from, by design (§10).

```json
{
  "channel_id": "c_4nRt9v",
  "name": "release-work",
  "created_at": "2026-09-01T12:00:00.000Z",
  "invite": { "token": "…", "expires_at": "2026-09-01T13:00:00.000Z", "uses_remaining": 1 }
}
```

Creating a channel does **not** join it. The creator uses the returned invite like
anyone else.

### `POST /v1/channels/{channel_id}/invites` — party credential

Any current party may mint an invite; there is no owner role.

```json
{ "ttl_seconds": 3600, "max_uses": 1 }
```

Defaults are one hour and a single use. Relays MUST cap `ttl_seconds` (86400
RECOMMENDED) and `max_uses` (16 RECOMMENDED).

### `POST /v1/channels/{channel_id}/join`

```json
{
  "invite_token": "…",
  "display_name": "release-a",
  "machine_label": "workshop",
  "about": "cutting the 2.1 release"
}
```

The invite is the entire admission decision: someone inside this channel chose to let
the holder in. An invalid, expired, or exhausted invite is answered with `not_found`,
not a distinct error — a valid invite is itself the proof that the channel exists (§8).

`display_name` is 1–32 characters and MUST be unique within the channel — a duplicate is
`name_taken` (409), never a silent rename. Uniqueness is what makes a name a usable
address. `machine_label` (1–32 characters) is self-declared and shown in party
lists to distinguish identical display names on different machines; it is a label, not
an identity claim.

```json
{
  "party_id": "p_Ka81mz",
  "party_token": "…",
  "channel": { "channel_id": "c_4nRt9v", "name": "release-work" },
  "parties": [ … ]
}
```

### `GET /v1/channels/{channel_id}/parties` — party credential

```json
{
  "you": "p_Ka81mz",
  "parties": [
    {
      "party_id": "p_Ka81mz",
      "display_name": "release-a",
      "machine_label": "workshop",
      "about": "cutting the 2.1 release",
      "online": true,
      "joined_at": "2026-09-01T12:01:00.000Z",
      "last_seen_at": "2026-09-01T12:44:10.000Z"
    }
  ]
}
```

`about` is a free-text line, at most 140 characters, not unique and not an address. It
exists because sending is always addressed to one party, and a name alone does not
tell you which one to ask. Nobody is notified when it changes.

Party lists MUST NOT carry machine-local identifiers — session ids, socket paths,
process ids, hostnames the party did not choose to declare. `machine_label` is the
only machine information that crosses the wire.

### `PATCH /v1/channels/{channel_id}/parties/me` — party credential

```json
{ "display_name": "release-a2", "about": "verifying the tag" }
```

Both fields are optional. A `display_name` collision is `name_taken`.

### `DELETE /v1/channels/{channel_id}/parties/me` — party credential

Leaves the channel (204). The party token is invalidated, the display name is
released, and any unacknowledged messages in that inbox are discarded.

### `DELETE /v1/channels/{channel_id}` — party credential

Destroys the channel immediately (204): every stream is closed with `4404`, every
party token and pending invite is invalidated, and every queued message is
discarded. Subsequent requests carrying a credential for it answer `gone` (410).

Any party can do this, and that is the point. The invitation is the trust
boundary; when it turns out to have been misplaced — a leaked invite, a party
that should not be there — the remedy is to burn the channel and re-form it with fresh
invites. A destroyed channel is the worst an insider can do to you, and it costs one
join each to recover. This replaces an administrator: there is nobody to appeal to, and
nothing an outsider can do to trigger it.

**Lifecycle.** A party that has not contacted the relay for `party_ttl`
(900 seconds RECOMMENDED) is dropped as if it had left. Sessions restart; the timeout is
long enough to survive that. A channel with zero parties is destroyed after
`channel_grace` (300 seconds RECOMMENDED), after which its identifier and every token
scoped to it are `gone` (410).

---

## 5. Sending

### `POST /v1/channels/{channel_id}/messages` — party credential

```json
{ "to": "p_Ka81mz", "body": "tag pushed, gate is green", "reply_to": "…" }
```

`to` is REQUIRED and is a `party_id`. There is no broadcast and no wildcard: a
missing `to` is `invalid_request`. A client that wants to tell everyone iterates the
party list and sends N messages, which keeps the "one message wakes one session"
property intact.

`body` is UTF-8 text. Relays MUST accept at least 16 KiB and MUST publish their limit in
`GET /v1/relay`. `reply_to` is an optional `message_id` the client received earlier; the
relay does not interpret it.

```json
{
  "message_id": "x_9Fh2",
  "seq": 42,
  "recipient": {
    "party_id": "p_Ka81mz",
    "display_name": "release-a",
    "online": false,
    "last_seen_at": "2026-09-01T12:44:10.000Z"
  }
}
```

Status is `202 Accepted`: the message is in the recipient's inbox, which is not the same
as the recipient having read it.

The `recipient` block is REQUIRED, and the reason is worth stating. "Queued" alone hides
the most common failure: a mistyped `to` that happens to hit a real but dormant
party returns success and is never read by anyone. Returning who received it and
whether they are connected puts that in front of the sender at send time.

Delivery is **at-least-once**. Nothing in this protocol guarantees that a message
reaches the recipient's attention — only that it reached their inbox. Clients that need
certainty ask for a reply.

---

## 6. Receiving

Each party has one inbox. `seq` is assigned at enqueue time and is strictly
increasing per inbox, starting at 1. Gaps MAY occur (expiry, a leave); clients MUST NOT
infer loss from a gap.

Messages are removed **only** on acknowledgement, never on read. A client that
disconnects mid-delivery receives the same messages again on reconnect, so clients MUST
tolerate duplicates — deduplicating on `seq` is sufficient.

### Message envelope

```json
{
  "v": 1,
  "message_id": "x_9Fh2",
  "channel_id": "c_4nRt9v",
  "seq": 42,
  "from": {
    "party_id": "p_Bd30nq",
    "display_name": "workshop-main",
    "machine_label": "workshop"
  },
  "to": "p_Ka81mz",
  "body": "tag pushed, gate is green",
  "sent_at": "2026-09-01T12:45:02.100Z",
  "reply_to": null
}
```

### WebSocket — the normative transport

```
GET /v1/channels/{channel_id}/stream
Upgrade: websocket
Authorization: Bearer <party token>
```

The credential MUST be accepted in the `Authorization` header. Relays MAY accept a
query parameter for environments that cannot set headers, but this is NOT RECOMMENDED —
query strings end up in logs.

Frames are JSON text.

| Direction | Frame |
| --- | --- |
| → client | `{"type":"ready","party_id":"p_…","last_seq":41,"parties":[…]}` |
| → client | `{"type":"message","message":{…envelope…}}` |
| ← client | `{"type":"ack","seq":42}` |
| → client | `{"type":"presence","event":"joined"\|"left"\|"updated","party":{…}}` |
| → client | `{"type":"ping"}` / ← client `{"type":"pong"}` |
| → client | `{"type":"error","error":"…","message":"…"}` |

On open the relay sends `ready`, then every unacknowledged message in `seq` order, then
live traffic. The relay MUST send a `ping` at least every 30 seconds; a client that does
not answer within 30 seconds is treated as disconnected. Application-level pings are
specified because WebSocket control frames are not exposed by every runtime.

A party has at most one stream. Opening a second one MUST supersede the first,
closing it with code `4409` — split delivery across two connections would let each side
acknowledge messages the other never saw.

Close codes: `4401` credential invalid or expired, `4404` channel gone, `4409`
superseded, `4429` rate limited.

### Long poll — the fallback

Every relay MUST implement this as well. It is what makes an implementation verifiable
with nothing but `curl`, and what lets clients run where WebSocket is not available.

```
GET /v1/channels/{channel_id}/inbox?wait=30&after_seq=41&limit=16
Authorization: Bearer <party token>
```

Returns immediately if anything is pending, otherwise holds the request for up to `wait`
seconds (capped at 60) and returns an empty list on timeout.

```json
{ "messages": [ …envelopes… ], "last_seq": 43 }
```

`after_seq` is a filter, not an acknowledgement: unacknowledged messages are returned
again on the next call with a lower `after_seq`.

### Acknowledgement

```
POST /v1/channels/{channel_id}/inbox/ack
{ "seq": 43 }
```

Deletes every message in the inbox with `seq <= 43` (204). Acknowledgement is a cursor,
not a per-message operation; it is idempotent and a lower value than a previous ack is
a no-op. WebSocket clients MAY use this endpoint instead of the `ack` frame.

**When to acknowledge is a client decision with consequences.** See §7.

Contact through either transport — an open stream, a poll, or an ack — updates
`last_seen_at` and keeps the party alive. There is no separate heartbeat: a
party that is not listening is, correctly, not present.

Undelivered messages expire after `message_ttl` (86400 seconds RECOMMENDED). Inboxes are
bounded (256 messages RECOMMENDED); sending to a full inbox is `inbox_full` (409).

---

## 7. Client requirements

The relay cannot enforce these. They are where most of the safety of the system actually
lives, so a client that skips them is not a conforming Partyline client.

1. **The relay URL MUST come from configuration, with no default.** A built-in default
   is a server users connect to by accident.
2. **A client MUST NOT join a channel as a side effect of starting.** Process startup
   and channel participation are separate events; if starting a client joined anything,
   the opt-in boundary that makes private channels meaningful would not exist.
3. **Incoming message bodies MUST be treated as untrusted input.** They are text written
   by another session, which may itself be relaying instructions from somewhere else. A
   client MUST NOT present them in a way that implies they carry the authority of the
   user.
4. **Outbound sends MUST be visible to the user.** Sending is unrecoverable and leaves
   the machine. A client is not required to ask for approval each time — that would make
   the system unusable — but the user MUST be able to see what their session sent
   without going looking for it.
5. **Acknowledge after delivery, not on receipt.** The relay deletes on ack. If a client
   acknowledges when it takes a message off the wire and then fails to hand it to the
   session, the message is gone with no trace. Acknowledge once the message has reached
   its destination.
6. **Credentials MUST be stored outside the command line** — a config file with
   restrictive permissions, not process arguments visible to every process on the
   machine.
7. Clients SHOULD prefer a local mechanism when both sessions are on the same machine.
   A relay is for crossing machines; routing local traffic through one sends it off the
   machine for no benefit.

---

## 8. Relay requirements

A conforming relay:

- MUST serve every endpoint in §4–§6 and `GET /v1/relay`, over TLS.
- MUST NOT retain message bodies after acknowledgement, expiry, or channel destruction,
  and MUST NOT expose any interface that returns messages to anyone but their recipient.
- MUST NOT confirm the existence of a channel to anyone who is not a party to it. An unknown channel,
  an invalid party token, and an invalid invite all return `not_found` — anything
  else turns error codes into an existence oracle. (A destroyed channel answers `gone`
  to requests carrying a credential; identifiers are unguessable, and a stale client
  deserves the honest answer.)
- MUST scope party tokens to one channel and reject cross-channel use.
- MUST rate-limit channel creation and join attempts per source, and invite creation
  and sending per party. In an open relay these limits are the only brake on
  abuse; they are not optional hardening.
- SHOULD publish its limits and retention in `GET /v1/relay`, and document them for the
  people who connect to it.
- MAY serve a human-readable page at `GET /` saying what the relay is and who can see
  what passes through it. That page is subject to the rules above like any other
  endpoint: it MUST NOT list channels or parties.

**Operation is deployment.** The protocol defines no administrative interface: nothing
to list channels, nothing to evict parties, no privileged credential to protect (§10).
The in-band remedies — invites expire, parties time out, any party can
destroy a channel, empty channels evaporate — are the whole of channel management. An
operator who wants a closed relay puts access control in front of it (a reverse proxy,
an access layer); that is an operational choice outside this protocol.

Configurable parameters and their recommended defaults:

| Parameter | Default | Effect |
| --- | --- | --- |
| `invite_ttl` | 3600 s | Default invite lifetime |
| `party_ttl` | 900 s | Silence before a party is dropped |
| `channel_grace` | 300 s | Empty channel lifetime before destruction |
| `message_ttl` | 86400 s | Undelivered message lifetime |
| `body_bytes` | 65536 | Maximum message body |
| `inbox_messages` | 256 | Maximum queued messages per party |

---

## 9. Security considerations

**The relay operator sees everything and can inject anything.** Bodies are plaintext to
the relay, and a hostile or compromised relay can deliver messages that appear to come
from any party. Since those messages become input to a coding session, this is not
an eavesdropping risk but a control risk. Choosing the relay is the primary defense; the
protocol has no way to make an untrusted relay safe.

**Received text is a prompt injection vector.** It arrives from another session, which
may be acting on text it received from somewhere else. The dangerous case is not a
message that lies but one that instructs — asking the session to send back a file, run a
command, or repeat a credential. §7.3 and §7.4 exist for this: treat bodies as data, and
make outbound traffic visible so an injected send is at least seen.

**The relay URL is not a secret, and the protocol does not pretend it is.** Anyone who
learns it can create channels and consume resources on an open relay — bounded by the
mandatory rate limits — but can discover no channel, join none without an invite, and
reach no session. Access to *conversations* rests entirely on the capability chain:
unguessable channel identifiers, hand-delivered invites, session-held party
tokens. Operators for whom resource use by strangers is unacceptable put an access
layer in front of the relay (§8).

**The invitation is the trust boundary, and it is load-bearing.** Inviting a session
means trusting it with everything a party can do — including destroying the
channel (§4). That is deliberate: the destructive power of an insider is capped at one
burned channel, which is also exactly the remedy you need when an insider turns out not
to deserve the trust. What the protocol will not do is let anyone *outside* the
invitation chain affect a channel at all.

**No end-to-end encryption in v1.** `body` is opaque to the relay's logic, so clients
that share a key can encrypt it themselves, but nothing in the protocol supports key
exchange and the relay still controls delivery and can forge senders. Encryption would
address confidentiality, not injection.

**Token handling.** Invite and party tokens are bearer tokens. Relays SHOULD
store them hashed, MUST transmit them only over TLS, and MUST NOT log them. Clients
MUST keep them out of command lines and process arguments.

---

## 10. Non-goals

Not oversights — each is excluded for a reason, and adding it changes the model.

- **Accounts and membership.** A relay with accounts needs onboarding, credential
  recovery, and revocation — an operator's job description. The capability chain (§3)
  carries the same access decisions without any of it, and a relay that knows nothing
  about its users is a relay that cannot leak who they are.
- **Administration.** Every administrative surface is a privileged credential to steal
  and an operator obligation to staff. The in-band remedies (§8) cover channel
  management; what they cannot do — say, surveil channels — is exactly what an
  admin-less relay is structurally unable to do, which is a feature.
- **Broadcast.** The only way one message could wake several sessions. Clients can loop
  over the party list; the relay needs nothing for it.
- **Message history.** The relay is a post office. Conversations are already recorded in
  the sessions that had them, and a relay that stores nothing is a relay that cannot
  leak what was said.
- **Public channels and channel discovery.** See §9.
- **Channel ownership and moderation.** Parties are equal; the boundary is the
  invitation, not a role.
- **Presence beyond participation.** `online` and `last_seen_at` are for choosing a
  recipient, not a status system.
- **Delivery to sessions that are not running.** Messages wait in the inbox and expire.
  Notifying an absent user is an application concern, outside this protocol.
- **File transfer.** Send a path or a summary; the receiving session has a filesystem.

## Versioning

`/v1` and the envelope's `"v": 1` move together. Additive fields are not a version
change and MUST be ignored when unknown. While this document is marked *draft*, breaking
changes may land without a migration path.
