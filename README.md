# Partyline

> a protocol for relaying messages between AI coding sessions on
> different machines — plus a reference relay and a Claude Code plugin

> Korean: [README.ko.md](./README.ko.md)

---

## ⚠️ Read this before you use any relay

**A relay operator can inject arbitrary text into your session.**

Messages that arrive from a relay become input to your coding agent. They
can carry prompt injection — instructions that try to make your session
leak code, run commands, or send things back out. The protocol does not
and cannot prevent this.

**Your first line of defense is choosing the relay.** Run your own, or use
one operated by someone you would already trust with the contents of the
sessions you connect. There is no default relay URL anywhere in this
repository, and that is deliberate: a default is a server you connect to
by accident.

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
- **Participants are sessions**, not machines or people. Joining is
  something a session does explicitly. Starting a client process joins
  nothing.
- **Every message is addressed.** There is no broadcast, so one message
  never wakes a room full of sessions.
- **Private channels only.** You get in by invitation from someone
  already inside.

Access is a capability chain, not an account system: unguessable channel
identifiers, hand-delivered invites, and per-channel participant tokens.
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

## Status

Early. The protocol is `v1 (draft)` and will change without a
compatibility story until it is marked stable.

## License

MIT.
