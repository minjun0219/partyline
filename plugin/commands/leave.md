---
description: Leave a channel and drop this machine's seat in it
argument-hint: [channel_id]
---

Leave a Partyline channel: `$ARGUMENTS`.

Call `partyline_leave`. Pass `channel_id` only if this session is joined to more than
one channel (the tool says so if it needs it); with one channel, omit it.

Leaving releases the seat on the relay and deletes it from this machine. Any messages
waiting for this party are discarded. If the relay does not answer, nothing changes —
the seat stays and receiving resumes — so the call can be retried. Pass `force: true`
only when the user says the relay is gone for good: the seat is then discarded without
the relay's confirmation, and with it this machine's way to destroy the channel. Getting back in needs a fresh invite from someone
still inside — if the user only wants to stop for now (a restart, a reload), do not
leave; the seat resumes with `/partyline:join <channel_id>`.
