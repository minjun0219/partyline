// Client-side copies of the wire shapes in SPEC.md. The spec is canonical;
// these are duplicated here (not imported from the server) so the plugin
// directory is self-contained — a git-subdir install ships only plugin/.

export interface PartyView {
  party_id: string;
  display_name: string;
  machine_label: string;
  about?: string;
  online: boolean;
  joined_at: string;
  last_seen_at: string;
}

export interface MessageEnvelope {
  v: 1;
  message_id: string;
  channel_id: string;
  seq: number;
  from: {
    party_id: string;
    display_name: string;
    machine_label: string;
  };
  to: string;
  body: string;
  sent_at: string;
  reply_to: string | null;
}

export interface RecipientView {
  party_id: string;
  display_name: string;
  online: boolean;
  last_seen_at: string;
}

export type ServerFrame =
  | { type: "ready"; party_id: string; last_seq: number; parties: PartyView[] }
  | { type: "message"; message: MessageEnvelope }
  | { type: "presence"; event: "joined" | "left" | "updated"; party: PartyView }
  | { type: "ping" }
  | { type: "error"; error: string; message: string };

export interface ErrorBody {
  error?: string;
  message?: string;
}
