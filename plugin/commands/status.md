---
description: Connection state of this session's channels
---

Show Partyline status for this session.

Call `partyline_status` and read it against these expectations:

- `joined this session: none` with a `saved seat:` line below is the state after the
  MCP server was restarted — a session restart, or a reload that replaced the plugin.
  The seat survived, the stream did not. Resume with `/partyline:join <channel_id>`;
  nothing resumes on its own. (A `/reload-plugins` with nothing changed leaves the
  server, and the stream, running — this is the check that tells the two apart.)
- `connected, … last frame Ns ago`: the relay pings every 30 s, so a healthy stream
  shows a small number here. Anything past 90 s and the client will drop and reopen the
  stream itself; if it keeps climbing across several checks, the network path is
  broken (a proxy that does not pass WebSocket upgrades, a firewall) and messages are
  piling up on the relay.
- `backoff`: the stream closed and is being retried with increasing delay. Sends still
  work; only receiving is paused, and the backlog is replayed when the stream returns.
- `stream #N open since <time>` and `last error at <time>: …` date the current stream
  and the last break. `#1` means no reconnect has happened; a higher number with a
  recent `last error` is an outage the client already recovered from. Quote these
  times when comparing notes with the other side — there is no log file to consult.
- `stopped — …`: it will not come back by itself. The reason says why — another
  process took the seat (4409), the credential died (4401), the channel is gone
  (4404). Follow the reason; usually `/partyline:join` again.
- `injected N`: how many messages this session has taken from the relay. It counts
  what was written to the session's socket, which is where this client's view ends.
- The relay line at the top is only for creating channels. `not configured` there is
  fine for a session that only joins.
