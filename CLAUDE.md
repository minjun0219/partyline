# Partyline — agent notes

Partyline relays short text messages between AI coding sessions on
different machines. The repository holds three things that ship together:
the protocol spec, a reference relay, and a Claude Code plugin that
implements the client side.

**The spec is the body of this repo.** "Everyone runs their own relay" is
the design premise, so the artifact that lets someone else build a relay
is worth as much as the one included here. Behaviour changes land in
`SPEC.md` in the same change that implements them — an implementation
that has drifted from the spec is a bug in both.

## Layout

- `SPEC.md` — the protocol. Normative, English only.
- `server/` — reference relay on Cloudflare Workers. Tests are organized
  by spec section and double as a conformance suite.
- `plugin/` — Claude Code plugin bundling the client as an MCP server
  (committed bundle at `plugin/mcp/dist/`; rebuild with `pnpm build` when
  `plugin/mcp/src/` changes).
- `.claude-plugin/marketplace.json` — plugin distribution, see below.

## Principles

These are the ones that are easy to break by accident. Each has cost a
decision somewhere.

- **No default relay URL. Anywhere.** Not in the plugin, not in examples,
  not as a fallback when config is missing. A default is a server users
  connect to by accident, and the trust model rests on the user having
  picked their relay deliberately. Missing configuration is an error, not
  a reason to guess. The two legitimate sources are the user's config (for
  creating channels) and an invite URL, which names its relay (SPEC §3) —
  and joining one must say which relay it is.
- **The trust warning stays at the top of the README.** A relay operator
  can inject arbitrary text into a session. That is the first thing a
  reader sees, before the pitch.
- **`SPEC.md` §7 is not politeness.** No-auto-join, treat-received-text-
  as-untrusted, make-outbound-visible, and ack-after-inject are the parts
  of the safety story a relay cannot enforce. The plugin implements all
  of them; a change that weakens one is a protocol-level change.
- **Process startup is not channel participation.** The MCP server starts
  with every session. If it joined anything on startup, the opt-in
  boundary that makes private channels meaningful would not exist.
- **Don't reintroduce the non-goals.** Accounts/membership, administration,
  broadcast, message history, public channels, and channel ownership are
  excluded with reasons in
  `SPEC.md` §10. Each one changes the model; reopening one is a decision,
  not a feature.
- **This repository reads standalone.** No references to private
  infrastructure, internal deployments, or any particular relay operator
  — in code, docs, comments, or commit messages. Nothing here should
  require context that isn't in the repo.
- **No secrets in the repo.** The reference relay deliberately has no
  deployment secrets (the protocol is admin-less), and that should stay
  true; tokens exist only client-side. `.dev.vars` and `.env*` stay in
  `.gitignore` regardless.

## Documentation language

English is canonical. `README.md` has a Korean mirror (`README.ko.md`)
that is a reference translation — when they disagree, the English file
wins. Sub-package READMEs get the same treatment as they are added.

`SPEC.md` is English only. A normative document kept in two languages
will drift, and a drifted spec is worse than no translation.

## Distribution

The plugin ships through a `marketplace.json` in this repository, with
the plugin entry using a **git-subdir** source pointing at `plugin/`.
That is a sparse clone: installers get the plugin directory only, not the
server or the spec. npm publishing was considered and rejected — it adds
a release pipeline and loses the commit-SHA version fallback that git
sources give for free, in exchange for nothing git-subdir doesn't
already do.
