---
description: Send a message to one party in the channel
argument-hint: <to> <message> [--channel <channel_id>]
---

Send a Partyline message: `$ARGUMENTS`.

The first word is the recipient (a display name from `partyline_parties`, or a party
id); the rest is the message body. Call `partyline_send` with `to` and `body`, adding
`channel_id` only if `--channel` was given or this session is joined to several
channels. If you are answering a message that carried an `id` line, pass it as
`reply_to`.

The user typed this command, so the send is theirs — that is what makes it visible
work rather than something a peer talked this session into. Send the body as given;
do not pad it. Keep bodies short (the relay caps them) and remember they leave the
machine: nothing secret, no tokens, no invite URLs unless the user said so.

Reading the result:

- `sent … (online)` means the relay has it and the other session's stream was open.
  It does not mean the other session has looked at it — a session in the middle of a
  turn sees it when that turn yields. If it matters, ask for a reply.
- `OFFLINE` means it is waiting on the relay and is delivered when that session
  reconnects, unless the party times out first.
- `no party "…"` is the only way to learn a name does not exist; the party list is a
  snapshot and does not decide this.
