// Leaving and destroying end this party's seat at the relay. The local seat is
// the only credential this machine holds for the channel — for destroy, the
// only way left to burn it — so it is discarded once the relay has let go of
// it, never on the way to asking.

import { deadCredential, RelayError } from "./relay.ts";

/** The part of a ChannelConnection that teardown drives. */
export interface Receiver {
  readonly status: string;
  start(): void;
  stop(): void;
}

export type TeardownResult =
  /** The relay ended the seat. */
  | { outcome: "ended" }
  /** `gone`: the channel had already been destroyed. */
  | { outcome: "channel_gone" }
  /** `not_found`: the relay no longer accepts this seat — it left or was dropped.
   * The channel itself may still be live with other parties. */
  | { outcome: "seat_invalid" }
  /** The relay never confirmed, and the caller asked to discard the seat anyway. */
  | { outcome: "unconfirmed"; error: unknown };

const inFlight = new WeakSet<Receiver>();

/**
 * Run a call that ends this party's seat (leave or destroy), and `release` the
 * local seat only once the relay has let go of it: after a success, or when
 * the relay itself answers that the seat leads nowhere (SPEC.md §2). Any other
 * failure — the network, a 5xx, a timeout, an answer from something in front
 * of the relay — is rethrown with everything kept and receiving resumed, so
 * the call can be retried. `force` releases on those failures too, for a relay
 * that is gone for good.
 */
export async function endSeat(
  receiver: Receiver,
  call: () => Promise<void>,
  release: () => void,
  force = false,
): Promise<TeardownResult> {
  if (inFlight.has(receiver)) {
    throw new RelayError(0, "busy", "a leave or destroy for this channel is already in progress");
  }
  inFlight.add(receiver);
  // Receiving pauses while the relay is asked. Destroy is how an unwanted
  // party is cut off, so its messages should stop now, not after the round
  // trip; and the relay closes a leaving party's stream with 1000, which a
  // live connection would take for a drop and reconnect to.
  const wasReceiving = receiver.status !== "stopped";
  receiver.stop();
  try {
    let result: TeardownResult;
    try {
      await call();
      result = { outcome: "ended" };
    } catch (err) {
      const dead = deadCredential(err);
      if (dead === "gone") result = { outcome: "channel_gone" };
      else if (dead === "not_found") result = { outcome: "seat_invalid" };
      else if (force) result = { outcome: "unconfirmed", error: err };
      else {
        // A halted connection (superseded, refused) stays halted.
        if (wasReceiving) receiver.start();
        throw err;
      }
    }
    release();
    return result;
  } finally {
    inFlight.delete(receiver);
  }
}
