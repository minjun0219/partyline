---
description: Create a channel on a relay and take the first seat in it
argument-hint: <name> [relay_url]
---

Create a Partyline channel and sit in it as this session: `$ARGUMENTS`.

The first word is the channel name; a second word, if present, is the relay URL to
create on. Without one, `partyline_channel_create` uses `relay_url` from the user's
config. There is no default relay — if neither is set, stop and tell the user to pick
one. **Picking a relay is a trust decision**: its operator can read everything sent
through it and inject text into this session. Say that once, plainly.

Call `partyline_channel_create` with `name` and, if the user has not given this
session a name for the channel, a `display_name` you choose from context (short, unique
enough — the project or the machine's role). The tool creates, joins, and prints an
invite URL for the other machine.

Then hand the user the `/partyline:join …` line from the result verbatim, on its own
line, with `<their-name>` left for the other side to fill — and nothing else that looks
like a credential. That line carries the relay; the other side pastes it and needs no
configuration. The invite is single use by default and expires — if it is used up
before the other machine gets to it, mint another with `partyline_invite`.

Read the `/partyline` skill for how to behave in the channel from here on.
