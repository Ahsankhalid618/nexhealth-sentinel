import { describe, expect, it } from "vitest";
import { WRITE_STATUSES, isPending, isRetryable, nextWriteStatus, type WriteSignal, type WriteStatus } from "./write-state";

const ALLOWED: Array<[WriteStatus, WriteSignal, WriteStatus]> = [
  ["requested", "post_accepted", "accepted"],
  ["requested", "post_rejected", "rejected"],
  ["accepted", "insertion_complete", "complete"],
  ["accepted", "insertion_failed", "failed"],
  ["accepted", "insertion_timed_out", "timed_out"],
  ["accepted", "readback_written", "complete"],
  ["accepted", "sync_blocked", "stuck"],
  ["stuck", "insertion_complete", "complete"],
  ["stuck", "insertion_failed", "failed"],
  ["stuck", "insertion_timed_out", "timed_out"],
  ["stuck", "readback_written", "complete"],
  ["stuck", "sync_recovered", "accepted"],
  ["failed", "readback_written", "complete"],
  ["timed_out", "readback_written", "complete"],
];

const SIGNALS: WriteSignal[] = [
  "post_accepted",
  "post_rejected",
  "insertion_complete",
  "insertion_failed",
  "insertion_timed_out",
  "readback_written",
  "sync_blocked",
  "sync_recovered",
];

describe("nextWriteStatus", () => {
  it.each(ALLOWED)("%s --%s--> %s", (from, signal, to) => {
    expect(nextWriteStatus(from, signal)).toBe(to);
  });

  it("ignores every transition not in the table", () => {
    const allowed = new Set(ALLOWED.map(([from, signal]) => `${from}/${signal}`));
    for (const status of WRITE_STATUSES) {
      for (const signal of SIGNALS) {
        if (!allowed.has(`${status}/${signal}`)) expect(nextWriteStatus(status, signal)).toBeNull();
      }
    }
  });

  it("resolves a stuck write when a late complete arrives", () => {
    let s: WriteStatus = "requested";
    for (const signal of ["post_accepted", "sync_blocked", "insertion_complete"] as const) {
      s = nextWriteStatus(s, signal) ?? s;
    }
    expect(s).toBe("complete");
  });

  it("does not let a late failed event undo a complete", () => {
    expect(nextWriteStatus("complete", "insertion_failed")).toBeNull();
  });
});

describe("helpers", () => {
  it("isPending", () => {
    expect(WRITE_STATUSES.filter(isPending)).toEqual(["requested", "accepted", "stuck"]);
  });

  it("isRetryable only for failed and timed_out", () => {
    expect(WRITE_STATUSES.filter(isRetryable)).toEqual(["failed", "timed_out"]);
  });
});
