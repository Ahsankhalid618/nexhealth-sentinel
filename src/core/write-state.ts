export const WRITE_STATUSES = [
  "requested",
  "accepted",
  "complete",
  "failed",
  "timed_out",
  "stuck",
  "rejected",
] as const;
export type WriteStatus = (typeof WRITE_STATUSES)[number];

/**
 * - post_accepted / post_rejected: the result of our POST (201 vs a 4xx).
 * - insertion_*: an `appointment_insertion.{complete,failed,timed_out}` webhook.
 * - readback_written: a read (or any event) shows `foreign_id != null`, i.e. the record is in the EHR.
 * - sync_blocked: a timer found the write still pending while the location's sync can't take writes.
 * - sync_recovered: that sync is taking writes again.
 */
export type WriteSignal =
  | "post_accepted"
  | "post_rejected"
  | "insertion_complete"
  | "insertion_failed"
  | "insertion_timed_out"
  | "readback_written"
  | "sync_blocked"
  | "sync_recovered";

const TRANSITIONS: Record<WriteSignal, Partial<Record<WriteStatus, WriteStatus>>> = {
  post_accepted: { requested: "accepted" },
  post_rejected: { requested: "rejected" },
  insertion_complete: { accepted: "complete", stuck: "complete" },
  insertion_failed: { accepted: "failed", stuck: "failed" },
  insertion_timed_out: { accepted: "timed_out", stuck: "timed_out" },
  // What the EHR holds wins over an earlier event.
  readback_written: { accepted: "complete", stuck: "complete", failed: "complete", timed_out: "complete" },
  sync_blocked: { accepted: "stuck" },
  sync_recovered: { stuck: "accepted" },
};

/** Returns the next status, or null when the signal doesn't apply (late or out-of-order events are ignored). */
export function nextWriteStatus(current: WriteStatus, signal: WriteSignal): WriteStatus | null {
  return TRANSITIONS[signal][current] ?? null;
}

export function isPending(status: WriteStatus): boolean {
  return status === "requested" || status === "accepted" || status === "stuck";
}

/** NexHealth never retries a failed write; only these may be resent, and only after a read-back. */
export function isRetryable(status: WriteStatus): boolean {
  return status === "failed" || status === "timed_out";
}
