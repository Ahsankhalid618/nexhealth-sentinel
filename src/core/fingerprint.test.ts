import { describe, expect, it } from "vitest";
import { fingerprint } from "./fingerprint";
import { normalizeEvent } from "./normalize";
import { loadDocFixture } from "../../tests/fixtures";

type Payload = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const fp = (p: unknown) => fingerprint(normalizeEvent(p));

describe("fingerprint", () => {
  it("is the same for a retry whose delivery_errors changed", () => {
    const first: Payload = loadDocFixture("appointment_insertion");
    const retry: Payload = loadDocFixture("appointment_insertion");
    retry.delivery_errors = [
      { code: "504", timestamp: "2024-03-21T17:53:00.000Z", message: "Gateway Timeout", attempts: 1 },
      { code: "500", timestamp: "2024-03-21T17:55:00.000Z", message: "Internal Server Error", attempts: 2 },
    ];
    expect(fp(retry)).toBe(fp(first));
  });

  it("changes when the record's updated_at changes", () => {
    const a: Payload = loadDocFixture("appointment_insertion");
    const b: Payload = loadDocFixture("appointment_insertion");
    b.data.appointment.updated_at = "2030-01-01T00:00:00.000Z";
    expect(fp(a)).not.toBe(fp(b));
  });

  it("changes with the event name, so .complete and .failed for one record differ", () => {
    const a: Payload = loadDocFixture("appointment_insertion");
    const b: Payload = loadDocFixture("appointment_insertion");
    b.event_name = "appointment_insertion.failed";
    expect(fp(a)).not.toBe(fp(b));
  });

  it("does not depend on record order inside a batch", () => {
    const a: Payload = loadDocFixture("appointment_created");
    const record = a.data.appointments[0];
    a.data.appointments = [record, { ...record, id: 999, updated_at: "2025-01-01T00:00:00Z" }];
    const b: Payload = structuredClone(a);
    b.data.appointments.reverse();
    expect(fp(a)).toBe(fp(b));
  });

  it("uses event_time for records without updated_at", () => {
    const a: Payload = loadDocFixture("payment_insertion");
    const b: Payload = loadDocFixture("payment_insertion");
    b.event_time = "2030-01-01T00:00:00.000Z";
    expect(fp(a)).not.toBe(fp(b));
  });

  it("separates sync status events by their status timestamps", () => {
    const red: Payload = loadDocFixture("sync_status_write_change");
    const later: Payload = loadDocFixture("sync_status_write_change");
    later.data.syncstatus.write_status_at = "2030-01-01T00:00:00.000Z";
    expect(fp(red)).not.toBe(fp(later));
    expect(fp(red)).toBe(fp(loadDocFixture("sync_status_write_change")));
  });

  it("is a sha256 hex digest", () => {
    expect(fp(loadDocFixture("patient_created"))).toMatch(/^[0-9a-f]{64}$/);
  });
});
