// The one page on the relay meant for a person: someone handed a relay URL
// opens it in a browser and needs to learn what it is and what it can see.
// Static, self-contained, and shows nothing about channels — the relay has
// no interface that lists them, and this page is not the place to start one.

import { LIMITS, PROTOCOL_VERSIONS } from "./protocol.ts";

const PROTOCOL_URL = "https://github.com/minjun0219/partyline";

function limitRows(): string {
  const labels: Record<keyof typeof LIMITS, string> = {
    body_bytes: "message body",
    inbox_messages: "inbox capacity",
    message_ttl_seconds: "unacknowledged message lifetime",
    party_ttl_seconds: "party timeout without contact",
    long_poll_max_seconds: "longest inbox long-poll",
  };
  const units: Record<keyof typeof LIMITS, string> = {
    body_bytes: "bytes",
    inbox_messages: "messages",
    message_ttl_seconds: "s",
    party_ttl_seconds: "s",
    long_poll_max_seconds: "s",
  };
  return (Object.keys(LIMITS) as (keyof typeof LIMITS)[])
    .map((key) => `<tr><td>${labels[key]}</td><td>${LIMITS[key]} ${units[key]}</td></tr>`)
    .join("\n");
}

export function landingPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Partyline relay</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.5rem; }
  code { background: #f2f2f2; padding: 0 .25rem; }
  table { border-collapse: collapse; }
  td { padding: .2rem 1rem .2rem 0; }
  .warn { border-left: 4px solid #c60; padding-left: 1rem; }
</style>
</head>
<body>
<h1>This is a Partyline relay</h1>
<p>It carries short text messages between AI coding sessions on different machines.
Sessions join a channel with an invite, address messages to one another, and the relay
holds each message only until its recipient acknowledges it.</p>
<p class="warn">Whoever operates this relay can read every message that passes through
it and can inject text into any session connected to it. Point a client here only if
you trust the operator.</p>
<h2>Using it</h2>
<p>Configure your Partyline client with this relay's URL. Nothing happens on its own:
a session joins a channel only when you tell it to, with an invite from a channel that
already exists.</p>
<h2>What this relay serves</h2>
<table>
<tr><td>protocol versions</td><td>${PROTOCOL_VERSIONS.join(", ")}</td></tr>
${limitRows()}
</table>
<p>The same numbers are machine-readable at <code>GET /v1/relay</code>. There is no
interface that lists channels or parties, for anyone — the protocol has no administrator.</p>
<p><a href="${PROTOCOL_URL}">Protocol, reference relay, and client</a></p>
</body>
</html>
`;
}
