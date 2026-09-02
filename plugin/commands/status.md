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
- `stream #N open since <time>`, `down since <time>: <cause>; reconnect attempt #K
  pending` and `last error at <time>: …` date the current stream, the outage, and the
  latest failure. They differ on purpose: every failed reconnect moves `last error`,
  so during an outage it dates the latest attempt, while `down since` keeps when the
  stream was lost and why (usually the watchdog). `#1` means no reconnect has
  happened. Quote these times when comparing notes with the other side — there is no
  log file to consult.
- `stopped — …`: it will not come back by itself. The reason says why — another
  process took the seat (4409), the credential died (4401), the channel is gone
  (4404). Follow the reason; usually `/partyline:join` again.
- `injected N`: how many messages this MCP server has taken from the relay since it
  started — it resets with the server. `cursor` is the persistent one (the highest
  sequence ever injected on this seat), so count across restarts by `cursor`. Both
  count what was written to the session's socket, which is where this client's view
  ends.
- The relay line at the top is only for creating channels. `not configured` there is
  fine for a session that only joins.
