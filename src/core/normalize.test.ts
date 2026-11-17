import { describe, expect, it } from "vitest";
import { InvalidPayloadError, normalizeEvent, splitEventName } from "./normalize";
import { loadDocFixture } from "../../tests/fixtures";

describe("splitEventName", () => {
  it.each([
    ["appointment_insertion.complete", "appointment_insertion", "complete"],
    ["appointment_insertion.timed_out", "appointment_insertion", "timed_out"],
    ["appointment_updated.incomplete", "appointment_updated", "incomplete"],
    ["sync_status_write_change.red", "sync_status_write_change", "red"],
    ["patient_created", "patient_created", null],
    ["something.unknown", "something", null],
  ])("%s", (name, base, outcome) => {
    expect(splitEventName(name)).toEqual({ base, outcome });
  });
});

describe("normalizeEvent with the docs' example payloads", () => {
  it("reads a singular `data.appointment` object (appointment_insertion)", () => {
    const e = normalizeEvent(loadDocFixture("appointment_insertion"));
    expect(e).toMatchObject({
      subdomain: "test-subdomain",
      institutionId: 1,
      subscriptionId: 2,
      resourceType: "Appointment",
      eventBase: "appointment_insertion",
      eventOutcome: "complete",
      eventTime: "2024-03-21T17:52:47.824Z",
      sync: null,
      priorFailedAttempts: 0,
    });
    expect(e.records).toHaveLength(1);
    expect(e.records[0]!.id).toMatch(/^\d+$/);
    expect(e.records[0]!.updatedAt).toBeTruthy();
  });

  it("reads a plural `data.appointments` array (appointment_created)", () => {
    const e = normalizeEvent(loadDocFixture("appointment_created"));
    expect(e.eventOutcome).toBeNull();
    expect(e.records.length).toBeGreaterThanOrEqual(1);
    expect(e.records[0]!.locationId).toEqual(expect.any(Number));
  });

  it("ignores `previous_attributes` on updates", () => {
    const e = normalizeEvent(loadDocFixture("appointment_updated"));
    expect(e.records).toHaveLength(1);
  });

  it("reads patient events in both shapes and picks up the name for initials", () => {
    const created = normalizeEvent(loadDocFixture("patient_created"));
    const updated = normalizeEvent(loadDocFixture("patient_updated"));
    expect(created.records).toHaveLength(1);
    expect(updated.records).toHaveLength(1);
    expect(created.records[0]!.patientName).toBe("John Smith");
  });

  it("reads `data.syncstatus`, where the documented example has `locations: null`", () => {
    const e = normalizeEvent(loadDocFixture("sync_status_write_change"));
    expect(e.eventOutcome).toBe("red");
    expect(e.records).toEqual([]);
    expect(e.sync).toEqual({
      syncSourceName: "My Source",
      readStatus: "green",
      readStatusAt: "2020-06-05T20:16:57.007Z",
      writeStatus: "red",
      writeStatusAt: "2020-06-05T20:16:57.007Z",
      locationIds: null,
    });
  });

  it("keeps location ids when a sync payload does list them", () => {
    const payload = loadDocFixture("sync_status_read_change") as { data: { syncstatus: Record<string, unknown> } };
    payload.data.syncstatus.locations = [{ id: 75 }, { id: 76 }, "junk"];
    expect(normalizeEvent(payload).sync?.locationIds).toEqual([75, 76]);
  });

  it("counts earlier failed attempts from `delivery_errors`", () => {
    const e = normalizeEvent(loadDocFixture("guide_appointment_insertion_with_delivery_errors"));
    expect(e.priorFailedAttempts).toBe(1);
    expect(e.records[0]!.patientName).toBe("John Smith");
    expect(e.records[0]!.foreignId).toBeNull();
  });

  it("handles payment_insertion, whose documented example has no id and no outcome suffix", () => {
    const e = normalizeEvent(loadDocFixture("payment_insertion"));
    expect(e.eventOutcome).toBeNull();
    expect(e.records[0]!.id).toBeNull();
  });

  it("builds names from first/last name and nested patient objects", () => {
    const e = normalizeEvent({
      subdomain: "s",
      resource_type: "Appointment",
      event_name: "appointment_created",
      data: {
        appointments: [
          { id: 1, patient: { first_name: "Ada", last_name: "Lovelace" } },
          { id: 2, patient: { name: "Grace Hopper" } },
          { id: 3, first_name: "Alan" },
          { id: 4, patient: {} },
        ],
      },
    });
    expect(e.records.map((r) => r.patientName)).toEqual(["Ada Lovelace", "Grace Hopper", "Alan", null]);
  });

  it("tolerates missing optional fields", () => {
    const e = normalizeEvent({ subdomain: "s", resource_type: "Patient", event_name: "patient_created" });
    expect(e).toMatchObject({ institutionId: null, eventTime: null, records: [], priorFailedAttempts: 0 });
  });

  it("rejects payloads that are not NexHealth webhooks", () => {
    expect(() => normalizeEvent({ hello: "world" })).toThrow(InvalidPayloadError);
    expect(() => normalizeEvent(null)).toThrow(InvalidPayloadError);
  });
});
