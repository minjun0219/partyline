// Configuration and seat persistence. Two rules from SPEC.md §7 are enforced
// here rather than documented elsewhere: the relay URL has NO default (a
// default is a server you connect to by accident), and credentials live in
// files with restrictive permissions, never on command lines.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export interface PartylineConfig {
  /**
   * Relay used to create channels, e.g. https://relay.example.com — null
   * means unconfigured. Joining needs no configuration: an invite names its
   * relay (SPEC.md §3).
   */
  relay_url: string | null;
  /**
   * Key of a closed relay (SPEC.md §8), needed only to create channels.
   * Paired with relay_url above and sent nowhere else (SPEC.md §9).
   */
  relay_key: string | null;
  /** Self-declared, shown in party lists (SPEC.md §4). */
  machine_label: string;
}

/**
 * A seat is this machine's standing in one channel. Persisted so that a
 * restarted session can resume the same party (the relay keeps the
 * party alive for party_ttl) instead of needing a fresh invite.
 * Resuming still requires an explicit partyline_join call — persistence does
 * not create auto-join (SPEC.md §7.2).
 */
export interface Seat {
  /** The relay this seat lives on — from the invite that created it (SPEC.md §3). */
  relay_url: string;
  channel_id: string;
  channel_name: string;
  party_id: string;
  party_token: string;
  display_name: string;
  /** Highest seq already injected into a session — the dedupe cursor. */
  last_injected_seq: number;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PARTYLINE_CONFIG_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".config", "partyline");
}

function configFile(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), "config.json");
}

function seatsFile(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), "seats.json");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PartylineConfig {
  let raw: Partial<PartylineConfig> = {};
  try {
    raw = JSON.parse(readFileSync(configFile(env), "utf8")) as Partial<PartylineConfig>;
  } catch {
    // missing or unreadable — unconfigured
  }
  const fromEnv = env.PARTYLINE_RELAY_URL?.trim();
  const keyFromEnv = env.PARTYLINE_RELAY_KEY?.trim();
  const keyFromFile = typeof raw.relay_key === "string" ? raw.relay_key.trim() : "";
  return {
    relay_url: fromEnv || (typeof raw.relay_url === "string" ? raw.relay_url : null),
    // The file's key belongs to the file's relay. When the environment points
    // at a different relay, that key must not follow (SPEC.md §9).
    relay_key: keyFromEnv || (fromEnv ? null : keyFromFile || null),
    machine_label:
      typeof raw.machine_label === "string" && raw.machine_label.trim() !== ""
        ? raw.machine_label
        : hostname(),
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The relay to create a channel on: the explicit argument, else config, never
 * a default (null = unconfigured). The relay key travels only to the
 * configured relay — a URL given at call time may have arrived in relayed
 * text, and a key sent there is a key leaked (SPEC.md §9).
 */
export function relayForCreate(
  config: PartylineConfig,
  explicit: string | undefined,
): { url: string; key: string | null } | null {
  const url = explicit?.trim() || config.relay_url;
  if (!url) return null;
  const configured = config.relay_url ? trimSlash(config.relay_url) : null;
  const chosen = trimSlash(url);
  return { url: chosen, key: chosen === configured ? config.relay_key : null };
}

function writeRestricted(path: string, value: unknown, env: NodeJS.ProcessEnv): void {
  mkdirSync(configDir(env), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  chmodSync(path, 0o600); // tokens live here (SPEC.md §7.6)
}

export function saveConfig(config: PartylineConfig, env: NodeJS.ProcessEnv = process.env): void {
  writeRestricted(configFile(env), config, env);
}

/** The file as written — entries this version does not understand included. */
function readRawSeats(env: NodeJS.ProcessEnv): Record<string, Partial<Seat>> {
  try {
    const raw = JSON.parse(readFileSync(seatsFile(env), "utf8")) as unknown;
    if (raw && typeof raw === "object") return raw as Record<string, Partial<Seat>>;
  } catch {
    // none yet
  }
  return {};
}

/**
 * The seats this version can resume. A read-side view: what it leaves out
 * stays in the file (saveSeat/dropSeat merge into the raw file, never write
 * this view back), so a stricter reader is not a destructive migration.
 */
export function loadSeats(env: NodeJS.ProcessEnv = process.env): Record<string, Seat> {
  // Seats written before invites carried a relay have no relay_url. Back
  // then config held the only relay there was, so filling it in from config
  // is a fact about that seat, not a default. Without config the seat cannot
  // be resumed and is left out of the view — not out of the file.
  const legacyRelay = loadConfig(env).relay_url;
  const seats: Record<string, Seat> = {};
  for (const [id, seat] of Object.entries(readRawSeats(env))) {
    if (typeof seat.relay_url === "string") seats[id] = seat as Seat;
    else if (legacyRelay) seats[id] = { ...(seat as Seat), relay_url: legacyRelay };
  }
  return seats;
}

export function saveSeat(seat: Seat, env: NodeJS.ProcessEnv = process.env): void {
  const seats = readRawSeats(env);
  seats[seat.channel_id] = seat;
  writeRestricted(seatsFile(env), seats, env);
}

export function dropSeat(channelId: string, env: NodeJS.ProcessEnv = process.env): void {
  const seats = readRawSeats(env);
  delete seats[channelId];
  writeRestricted(seatsFile(env), seats, env);
}
