import { describe, expect, it } from "vitest";
import { REDACTED, initials, redact } from "./redact";
import { loadDocFixture } from "../../tests/fixtures";

describe("redact", () => {
  it("strips names, contact details and notes from an appointment payload", () => {
    const out = redact(loadDocFixture("guide_appointment_insertion_with_delivery_errors")) as {
      data: { appointment: Record<string, unknown> };
    };
    const appt = out.data.appointment;
    expect(appt.patient_name).toBe(REDACTED);
    expect(appt.note).toBe(REDACTED);
    expect(appt.id).toBe(1136829);
    expect(appt.provider_name).toBe("Dr. Lee");
    expect(appt.operatory_name).toBe("Room 3");
    expect(appt.updated_at).toBe("2021-12-05T16:30:53.488Z");
    expect(appt.foreign_id).toBeNull();
  });

  it("strips every string under a patient object but keeps ids, flags and timestamps", () => {
    const out = redact(loadDocFixture("patient_created")) as { data: { patients: Array<Record<string, unknown>> } };
    const p = out.data.patients[0]!;
    expect(p.name).toBe(REDACTED);
    expect(p.email).toBe(REDACTED);
    expect(typeof p.id).toBe("number");
    expect(p.updated_at).toMatch(/^\d{4}-/);
    const bio = p.bio as Record<string, unknown>;
    expect(bio.date_of_birth).toBe(REDACTED);
    expect(bio.phone_number).toBe(REDACTED);
    expect(bio.city).toBe(REDACTED);
    expect(bio.new_patient).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/John|Smith|Amy\.Ramos|5163042196|1964-05-03/);
  });

  it("removes secrets and tokens", () => {
    const out = redact({ data: [{ id: 1, secret_key: "abc", target_url: "https://x" }], token: "jwt" });
    expect(out).toEqual({ data: [{ id: 1, secret_key: REDACTED, target_url: "https://x" }], token: REDACTED });
  });

  it("keeps office names and nulls, and does not mutate the input", () => {
    const input = { name: "Demo Practice", locations: [{ id: 1, name: "Main" }], email: null };
    const out = redact(input);
    expect(out).toEqual({ name: "Demo Practice", locations: [{ id: 1, name: "Main" }], email: null });
    expect(out).not.toBe(input);
  });

  it("redacts a person's name when the object has person fields", () => {
    expect(redact({ name: "Jane Roe", first_name: "Jane" })).toEqual({ name: REDACTED, first_name: REDACTED });
  });
});

describe("initials", () => {
  it.each([
    ["John Smith", "J.S."],
    ["ada", "A."],
    ["  maria   de la cruz ", "M.C."],
    ["", null],
    [null, null],
    ["   ", null],
  ])("%s -> %s", (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});
