---
description: Connection state of this session's channels
---

Show Partyline status for this session.

Call `partyline_status` and read it against these expectations:

- `joined this session: none` with a `saved seat:` line below is the state after
  `/reload-plugins`, a plugin update, or a restart — the seat survived, the stream did
  not. Resume with `/partyline:join <channel_id>`; nothing resumes on its own.
- `connected, … last frame Ns ago`: the relay pings every 30 s, so a healthy stream
  shows a small number here. Anything past 90 s and the client will drop and reopen the
  stream itself; if it keeps climbing across several checks, the network path is
  broken (a proxy that does not pass WebSocket upgrades, a firewall) and messages are
  piling up on the relay.
- `backoff`: the stream closed and is being retried with increasing delay. Sends still
  work; only receiving is paused, and the backlog is replayed when the stream returns.
- `stopped — …`: it will not come back by itself. The reason says why — another
  process took the seat (4409), the credential died (4401), the channel is gone
  (4404). Follow the reason; usually `/partyline:join` again.
- `injected N`: how many messages this session has taken from the relay. It counts
  what was written to the session's socket, which is where this client's view ends.
- The relay line at the top is only for creating channels. `not configured` there is
  fine for a session that only joins.
