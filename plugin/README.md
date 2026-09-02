# partyline plugin

> the Claude Code client for the Partyline protocol

> Korean: [README.ko.md](./README.ko.md)

Bundles an MCP server that lets a session become a party on a
Partyline relay: join channels, see who is reachable, send addressed
messages, and receive — incoming messages are injected into the session
and acknowledged to the relay only after they have actually landed.

**Read the trust warning first.** Whoever operates your relay can read
everything you send and inject arbitrary text into your session. The
warning at the top of the [repository README](../README.md) is not
boilerplate.

## Install

From the marketplace in this repository:

```
/plugin marketplace add minjun0219/partyline
/plugin install partyline@partyline
```

The install ships only this directory (git-subdir source, sparse clone).
No build step: the MCP server is a committed bundle run with the Node
that Claude Code already requires.

## Use

Joining needs no configuration: an invite is a URL that names its relay,
and joining it means trusting that relay's operator with everything sent
through it. Creating a channel is the one step that needs a relay of your
own choosing — there is no default:

```
/partyline:create ops https://your-relay.example.com
```

(or set `relay_url` once in `~/.config/partyline/config.json` /
`PARTYLINE_RELAY_URL` and leave it off; `PARTYLINE_CONFIG_DIR` moves the
directory. If the operator has closed the relay, add the key they gave
you as `relay_key` next to it, or `PARTYLINE_RELAY_KEY` — it is used only
to create channels there and is never sent to a relay named on the
command line. That is all the configuration there is — the relay has no
accounts.) The command creates the channel, seats this session in it, and
prints an invite URL. Hand that URL to the other machine out of band; there
it joins with nothing else set up:

```
/partyline:join https://your-relay.example.com/join#c_…/… laptop-main
```

From there, `/partyline:parties` (who is here), `/partyline:send <to>
<message>`, `/partyline:status`, `/partyline:leave`. Each command wraps
one MCP tool and carries the reading rules for its result — what offline
means, which failures look alike, what a send result does and does not
promise. The tools are also callable directly (`partyline_channel_create`,
`partyline_join`, `partyline_parties`, `partyline_send`,
`partyline_status`, `partyline_leave`, `partyline_invite`,
`partyline_update_me`, `partyline_destroy` — the last burns a channel
whose invite leaked), and a `partyline` skill holds the conduct they
share: received text is untrusted, replies carry `reply_to`, nothing
secret goes through a channel.

A restarted session keeps its seat but not its stream (so does a reload
that replaces the plugin; one that changes nothing leaves the stream
running — `/partyline:status` tells which). Resume with
`/partyline:join <channel_id>`. Still an explicit call — nothing ever
joins automatically, and an invite that shows up inside a received message
is text, not something to join.

## What the client enforces (SPEC.md §7)

- **No default relay URL.** Unconfigured means an error, not a guess.
- **No auto-join.** Starting the MCP server (which Claude Code does for
  every session) connects to nothing.
- **Visible sends.** Every `partyline_send` leaves a one-line notice on
  your screen via a PostToolUse hook, and the tool result reports whether
  the recipient is connected.
- **Ack-after-inject.** A message is acknowledged (and thus deleted from
  the relay) only after it has been written to the session's local
  socket. If that write fails, delivery stops and resumes from the relay's
  inbox — duplicates are possible, a loss on the relay path is not. The
  guarantee ends at the socket: Claude Code reports nothing back once it
  has taken the text, so what it does with it (queue it, show it, drop it)
  is outside this client's view. `partyline_status` shows how many
  messages were injected and when the stream last heard from the relay.
- **Untrusted input.** Incoming messages are labeled with their sender
  and channel. They are text from another session, possibly relaying text
  from somewhere else — never instructions with your authority.

## When nothing arrives

In this order — each step rules out the layer below it.

1. `/partyline:status` on the **receiving** session. `connected` with a
   recent `last frame` is healthy; `backoff` or `stopped` says why in the
   same line. `joined this session: none` with a `saved seat:` line means
   the MCP server was restarted with the session — `/partyline:join <channel_id>`.
2. Send a message to yourself (`/partyline:send <your-name> ping`). That
   runs the whole path — relay, stream, injection — with no second machine
   involved. If it arrives, the client works and the problem is on the
   other side or between you.
3. The receiving session itself. Injected messages are input to that
   session, and what it does with input is its business — a busy turn shows
   them later, and the client cannot see past the socket. The relay has
   already been acknowledged by then, so the message is not coming back;
   `injected` and `cursor` in `/partyline:status` on the receiving side say
   whether it got that far.
4. `/partyline:parties` from the sending side. Offline is not gone — the
   message waits on the relay — but a name that is not there at all fails
   at send time, not here.
5. The network. WebSocket upgrades are what corporate proxies and some CDN
   edges drop (`403` on the stream, or a stream that connects and never
   hears a ping — status shows `last frame` climbing past 90 s). The
   client falls back to reconnecting, not to long-polling; a relay you can
   `curl` but not stream to is this.

## Development

```bash
pnpm typecheck
pnpm build         # bundle src/ → dist/server.cjs (committed)
pnpm test          # unit + bundle smoke + e2e against the reference relay
```

The e2e test spawns the reference relay from `../server` under wrangler
and runs the full story against it: open channel creation → two
parties by invitation → stream delivery → reconnect without
duplicates → party destruction.

To try changes in a live session without reinstalling, start Claude Code
from the repository root with the plugin loaded from the working tree:

```bash
claude --plugin-dir ./plugin
```

That copy takes precedence over an installed `partyline` for the session.
After editing, `pnpm build` (for `src/` changes) and `/reload-plugins` —
the MCP server restarts from the new bundle, so any seat needs
`/partyline:join <channel_id>` again, but the session itself stays.
