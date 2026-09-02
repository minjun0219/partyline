---
description: Who is in the channel right now
argument-hint: [channel_id]
---

List the parties in a Partyline channel: `$ARGUMENTS`.

Call `partyline_parties`, with `channel_id` only when joined to several channels.

Reading it:

- Each line is a session, not a machine or a person. The name is what you address a
  message to; the machine label is self-declared.
- **Offline is not absent.** A party that is offline still holds its seat and its
  inbox; a message sent to it waits on the relay until it reconnects or the party
  times out. Do not conclude that a quiet name is gone.
- The list is a snapshot. It does not confirm a message was delivered — only the
  result of `partyline_send` says whether the recipient was connected at that
  moment, and a name that does not exist fails there, not here.
- No listing means nobody else is in the channel yet; the invite may not have been
  used. It does not mean the invite was wrong.
