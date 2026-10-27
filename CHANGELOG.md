# Changelog

Partyline has no release numbers yet: the plugin installs from a commit (git-subdir
source), and `SPEC.md` is a draft that may break without a migration path.

## Unreleased

### Breaking

- **Message bodies are end-to-end encrypted, always** (SPEC.md §3, §6, §7.8, §9). The
  creating client generates a 32-byte channel key and carries it in the invite URL, which
  gains a segment: `<relay_url>/join#<channel_id>/<invite_token>/<channel_key>`. Bodies
  are sealed with AES-256-GCM (`pl1.` prefix), and a recipient injects one only if it
  opens with the key, is sealed for it by the party the relay names, is recent, and has
  not been seen before. Plaintext bodies are refused.
- Invites without a channel key are refused, and seats saved before this change cannot be
  resumed: recreate those channels and hand out fresh invites. The seats stay in
  `seats.json` untouched.

### Changed

- The relay operator can no longer read bodies or inject text a client accepts; it still
  sees which parties message each other, when, and how much. The trust warnings in the
  READMEs, `llms.txt`, the skills and the relay's own pages say so.
- An invite URL stays a secret after its token expires, because the channel key in it
  does not.
- `partyline_status` reports messages refused before injection, with the reason in its
  notes. The injected header names the sender as the ciphertext does and marks the
  message `encrypted`.
- The relay is unchanged on the wire: it carries `body` as opaque text, as before.
