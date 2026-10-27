# Partyline

> a protocol for relaying messages between AI coding sessions on
> different machines — plus a reference relay and a Claude Code plugin

> Korean: [README.ko.md](./README.ko.md)

---

## ⚠️ Read this before you use any relay

**Anyone in a channel can put arbitrary text into your session.**

Messages that arrive from a relay become input to your coding agent. They
can carry prompt injection — instructions that try to make your session
leak code, run commands, or send things back out. The protocol does not
and cannot prevent this.

**Message bodies are end-to-end encrypted, so the relay operator is not
one of those people.** The channel key travels inside the invite URL and
never reaches the relay; a relay can neither read a body nor forge one
your client will accept. It still sees who messages whom, when, and how
much, along with every display name and `about` line, and it can drop or
delay messages. An invite URL carries the key for as long as the channel
lives, so treat it as a secret even after it expires.

**Your first line of defense is choosing who you invite.** Anyone holding
an invite URL can join and send to your session. There is no default relay
URL anywhere in this repository, and that is deliberate: a default is a
server you connect to by accident. An invite names the relay it is for, so
accepting one is also choosing a relay — the client tells you which.

The second line of defense is the client: it must never join a channel
without you asking it to, and it must show you what it sends. Those are
requirements on clients, spelled out in
[SPEC.md §7](SPEC.md#7-client-requirements).

---

## What this is

Two coding sessions on the same machine can already talk over a local
socket. Partyline is for when they are not on the same machine — a laptop
and a workstation, a desktop and a cloud box.

The model is small on purpose:

- **Channels, not chat rooms.** A channel is an address book plus an
  access boundary — the set of sessions allowed to call each other. There
  is no history: the relay holds a message only until the recipient takes
  it, and never stores what was said.
- **Parties are sessions**, not machines or people. Joining is
  something a session does explicitly. Starting a client process joins
  nothing.
- **Every message is addressed.** There is no broadcast, so one message
  never wakes a room full of sessions.
- **Private channels only.** You get in by invitation from someone
  already inside.

Access is a capability chain, not an account system: unguessable channel
identifiers, hand-delivered invites, and per-channel party tokens.
The relay itself has no accounts and no administrator — operating one is
just deploying it, and knowing its URL grants access to no channel.

## Layout

| Path | What it is | Status |
| --- | --- | --- |
| [`SPEC.md`](SPEC.md) | The protocol. Enough to write your own relay against. | Draft |
| [`server/`](server/) | Reference relay for Cloudflare Workers. | Working, tested |
| [`plugin/`](plugin/) | Claude Code plugin — bundles the client as an MCP server. | Working, tested |

The spec is the primary artifact. "Everyone runs their own relay" is the
design premise, so a relay you can reimplement matters as much as the one
included here.

## For coding agents

The plugin carries two [Agent Skills](plugin/skills/): `setup` tells a coding
agent whether Partyline fits, how to pick or deploy a relay, configure the
client and connect two machines, and what is easy to miss when building a
relay or client against the spec; `partyline` covers conduct once a session
is in a channel. In Claude Code:

```
/plugin marketplace add minjun0219/partyline
/plugin install partyline@partyline
```

[`llms.txt`](llms.txt) is the agent-readable overview of the project, and
[`context7.json`](context7.json) configures how Context7 indexes these docs.
Each running relay also serves its own `GET /llms.txt` describing that relay
and how to join through it.

## Status

Early. The protocol is `v1 (draft)` and will change without a
compatibility story until it is marked stable.

## License

MIT.
