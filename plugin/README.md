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

## Configure

There is no default relay — configure one you trust:

```jsonc
// ~/.config/partyline/config.json
{ "relay_url": "https://your-relay.example.com" }
```

(or `PARTYLINE_RELAY_URL`; `PARTYLINE_CONFIG_DIR` moves the directory).
That is the only setup — the relay has no accounts. Then, in a session:

```
partyline_channel_create { name: "ops" }         → channel + invite
partyline_join { channel_id, invite_token, display_name: "laptop-main" }
```

Hand the other machine the relay URL and an invite (`partyline_invite`)
out of band; it joins the same way. From there: `partyline_parties`,
`partyline_send`, `partyline_leave` — and `partyline_destroy` to burn a
channel whose invite leaked. A restarted session resumes its seat with
`partyline_join { channel_id }` — still an explicit call; nothing ever
joins automatically.

## What the client enforces (SPEC.md §7)

- **No default relay URL.** Unconfigured means an error, not a guess.
- **No auto-join.** Starting the MCP server (which Claude Code does for
  every session) connects to nothing.
- **Visible sends.** Every `partyline_send` leaves a one-line notice on
  your screen via a PostToolUse hook, and the tool result reports whether
  the recipient is connected.
- **Ack-after-inject.** A message is acknowledged (and thus deleted from
  the relay) only after it has been written into the session. If
  injection fails, delivery stops and resumes from the relay's inbox —
  duplicates are possible, losses are not.
- **Untrusted input.** Incoming messages are labeled with their sender
  and channel. They are text from another session, possibly relaying text
  from somewhere else — never instructions with your authority.

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
