#!/usr/bin/env node
// Outbound visibility (SPEC.md §9.4) — awareness, not a gate. After a
// successful partyline_send, leave one line on the user's screen saying what
// left the machine and for whom. A send that is completely silent is one the
// user never gets the chance to notice; this hook is the cheapest layer that
// fixes that. It never blocks: PostToolUse fires after the send, and any
// failure here just skips the notice.

import { exit, stdin, stdout } from "node:process";

let raw = "";
try {
  for await (const chunk of stdin) raw += chunk;
  const input = JSON.parse(raw);
  const to = String(input?.tool_input?.to ?? "");
  const body = String(input?.tool_input?.body ?? "");
  if (to && body) {
    const firstLine = (body.split("\n").find((l) => l.trim()) ?? "").trim();
    const summary = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
    stdout.write(`${JSON.stringify({ systemMessage: `partyline → ${to}: "${summary}"` })}\n`);
  }
} catch {
  // never block the send that already happened
}
exit(0);
