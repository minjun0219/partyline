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
- The sealed message carries the sender's machine label (`from_label`), and the injected
  header takes name and machine from the ciphertext only. A message whose relay-assigned
  `message_id` or `reply_to` is not a plain identifier (1–64 of `A-Z a-z 0-9 _ -`,
  SPEC.md §5) is refused, so no relay-written text reaches the session.

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

### Fixed

- `partyline_destroy` and `partyline_leave` call the relay first and discard the local
  seat only after it answers. A failed call (network error, relay down, 5xx) used to drop
  the seat anyway, so a channel meant to be burned stayed open and this session could no
  longer destroy it, and a failed leave kept the display name taken until the party timed
  out. Now the seat stays, receiving resumes, and the result says the call can be
  retried. The relay's own `gone` and `not_found` answers discard the seat; a 404 from
  something in front of the relay does not. A destroy answered `not_found` says the
  channel may still be live, since only this seat is known to be invalid.
- Both calls give up after 15 seconds instead of waiting out the fetch default, and
  receiving pauses while they run, so a party being cut off by a destroy stops arriving
  at once. A second leave or destroy on the same channel is refused while one runs.
- `partyline_leave` takes `force`, to discard the seat when the relay is gone for good;
  the party then stays at the relay until it times out.
- A message injected while its channel was being left no longer writes the discarded
  seat back to disk.
