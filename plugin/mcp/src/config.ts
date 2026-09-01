// Configuration and seat persistence. Two rules from SPEC.md §7 are enforced
// here rather than documented elsewhere: the relay URL has NO default (a
// default is a server you connect to by accident), and credentials live in
// files with restrictive permissions, never on command lines.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export interface PartylineConfig {
  /** Relay origin, e.g. https://relay.example.com — null means unconfigured. */
  relay_url: string | null;
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
  return {
    relay_url: fromEnv || (typeof raw.relay_url === "string" ? raw.relay_url : null),
    machine_label:
      typeof raw.machine_label === "string" && raw.machine_label.trim() !== ""
        ? raw.machine_label
        : hostname(),
  };
}

function writeRestricted(path: string, value: unknown, env: NodeJS.ProcessEnv): void {
  mkdirSync(configDir(env), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  chmodSync(path, 0o600); // tokens live here (SPEC.md §7.6)
}

export function saveConfig(config: PartylineConfig, env: NodeJS.ProcessEnv = process.env): void {
  writeRestricted(configFile(env), config, env);
}

export function loadSeats(env: NodeJS.ProcessEnv = process.env): Record<string, Seat> {
  try {
    const raw = JSON.parse(readFileSync(seatsFile(env), "utf8"));
    if (raw && typeof raw === "object") return raw as Record<string, Seat>;
  } catch {
    // none yet
  }
  return {};
}

export function saveSeat(seat: Seat, env: NodeJS.ProcessEnv = process.env): void {
  const seats = loadSeats(env);
  seats[seat.channel_id] = seat;
  writeRestricted(seatsFile(env), seats, env);
}

export function dropSeat(channelId: string, env: NodeJS.ProcessEnv = process.env): void {
  const seats = loadSeats(env);
  delete seats[channelId];
  writeRestricted(seatsFile(env), seats, env);
}
