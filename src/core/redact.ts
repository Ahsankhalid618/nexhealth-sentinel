export const REDACTED = "[redacted]";

/** Keys whose values are patient-identifying or secret wherever they appear. */
const ALWAYS_REDACT = new Set([
  "first_name",
  "middle_name",
  "last_name",
  "patient_name",
  "email",
  "phone_number",
  "cell_phone_number",
  "home_phone_number",
  "work_phone_number",
  "date_of_birth",
  "street_address",
  "street_address_2",
  "address_line_1",
  "address_line_2",
  "zip_code",
  "ssn",
  "note",
  "notes",
  "chart_id",
  "token",
  "secret_key",
  "api_key",
  "authorization",
]);

/** Objects under these keys are redacted leaf by leaf (strings only; ids, flags and dates stay). */
const REDACT_ALL_STRINGS_UNDER = new Set(["bio", "patient", "patients", "guarantor", "subscriber"]);

/** Offices and providers have names and addresses that are not PHI, so `name` is only redacted on people. */
function looksLikePerson(obj: Record<string, unknown>): boolean {
  return "first_name" in obj || "last_name" in obj || "bio" in obj || "date_of_birth" in obj;
}

const KEEP_UNDER_PERSON = new Set(["created_at", "updated_at", "foreign_id_type", "last_sync_time"]);

function redactValue(value: unknown, everyString: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => redactValue(v, everyString));
  if (typeof value === "object" && value !== null) {
    return redactObject(value as Record<string, unknown>, everyString);
  }
  if (everyString && typeof value === "string") return REDACTED;
  return value;
}

function redactObject(obj: Record<string, unknown>, everyString: boolean): Record<string, unknown> {
  const person = looksLikePerson(obj);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const k = key.toLowerCase();
    if (ALWAYS_REDACT.has(k) || (k === "name" && person)) {
      out[key] = value === null ? null : REDACTED;
    } else if (everyString && KEEP_UNDER_PERSON.has(k)) {
      out[key] = value;
    } else {
      out[key] = redactValue(value, everyString || REDACT_ALL_STRINGS_UNDER.has(k));
    }
  }
  return out;
}

/**
 * Deep copy with patient-like fields and secrets replaced by "[redacted]". The shape of the
 * object is kept, so redacted payloads still document the API. Used for stored events,
 * sandbox fixtures and anything else that leaves memory.
 */
export function redact<T>(value: T): T {
  return redactValue(value, false) as T;
}

/** "John Smith" -> "J.S."; the only form of a patient name the dashboard shows. */
export function initials(name: string | null | undefined): string | null {
  if (!name) return null;
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase());
  if (letters.length === 0) return null;
  const picked = letters.length > 2 ? [letters[0]!, letters[letters.length - 1]!] : letters;
  return picked.map((l) => `${l}.`).join("");
}
