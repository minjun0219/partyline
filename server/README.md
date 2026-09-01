# partyline-server

> the reference relay for the Partyline protocol, on Cloudflare Workers

> Korean: [README.ko.md](./README.ko.md)

Implements every normative requirement of [`SPEC.md`](../SPEC.md): the
capability model (§3), private channels with invites and party-
initiated destruction (§4), addressed delivery with the recipient block
(§5), both receive transports and the ack cursor (§6), and the relay
requirements (§8). The test suite is organized by spec section and
doubles as a conformance suite.

## Layout

- `src/index.ts` — HTTP surface (Hono). Thin: parsing, source rate limits
  for the unauthenticated doors, status mapping.
- `src/channel.ts` — one Durable Object per channel: parties,
  invites, inboxes, WebSocket streams, long polls, the sweep alarm,
  destruction.
- `src/gate.ts` — one Durable Object per relay: per-source rate limiting
  for channel creation and join attempts.
- `test/` — conformance-style tests, named by spec section.

## Run your own

```bash
pnpm install
pnpm test          # conformance suite (local, no account)
wrangler deploy
```

That is the whole of it — the relay is admin-less by design (SPEC §8), so
there are no secrets to set and no accounts to manage. Onboarding another
machine is handing it your relay URL and a channel invite.

Anyone who learns the URL can create channels on your relay (bounded by
per-source rate limits) but can reach no channel and no session without
an invite. If that resource exposure is unacceptable, put an access layer
in front of the Worker — that is an operational choice the protocol
deliberately leaves outside itself.

There is no default relay URL anywhere in this repository; clients are
pointed at your deployment explicitly. Before you invite anyone, read the
trust warning in the [repository README](../README.md).

## Development

```bash
pnpm dev        # local relay on workerd
pnpm typecheck
pnpm test
```

Tests run inside the Workers runtime via `@cloudflare/vitest-pool-workers`
with isolated per-test storage — no Cloudflare account needed.
