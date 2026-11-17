import { z } from "zod";

export const EVENT_OUTCOMES = ["complete", "failed", "timed_out", "incomplete", "red", "green"] as const;
export type EventOutcome = (typeof EVENT_OUTCOMES)[number];

export interface NormalizedRecord {
  id: string | null;
  updatedAt: string | null;
  locationId: number | null;
  foreignId: string | null;
  patientName: string | null;
}

export interface SyncSnapshot {
  syncSourceName: string | null;
  readStatus: "green" | "red" | null;
  readStatusAt: string | null;
  writeStatus: "green" | "red" | null;
  writeStatusAt: string | null;
  /** Null when the payload does not say which locations the sync serves (the documented example has `locations: null`). */
  locationIds: number[] | null;
}

export interface NormalizedEvent {
  subdomain: string;
  institutionId: number | null;
  subscriptionId: number | null;
  resourceType: string;
  eventName: string;
  eventBase: string;
  eventOutcome: EventOutcome | null;
  eventTime: string | null;
  records: NormalizedRecord[];
  sync: SyncSnapshot | null;
  /** Length of `delivery_errors`: how many earlier attempts of this delivery failed. */
  priorFailedAttempts: number;
}

export class InvalidPayloadError extends Error {}

const envelope = z.object({
  subdomain: z.string().min(1),
  institution_id: z.number().nullish(),
  webhook_subscription_id: z.number().nullish(),
  resource_type: z.string().min(1),
  event_name: z.string().min(1),
  event_time: z.string().nullish(),
  data: z.record(z.string(), z.unknown()).nullish(),
  delivery_errors: z.array(z.unknown()).nullish(),
});

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const status = (v: unknown): "green" | "red" | null => (v === "green" || v === "red" ? v : null);

export function splitEventName(eventName: string): { base: string; outcome: EventOutcome | null } {
  const dot = eventName.indexOf(".");
  if (dot === -1) return { base: eventName, outcome: null };
  const suffix = eventName.slice(dot + 1);
  const outcome = (EVENT_OUTCOMES as readonly string[]).includes(suffix) ? (suffix as EventOutcome) : null;
  return { base: eventName.slice(0, dot), outcome };
}

function patientNameOf(record: Obj): string | null {
  if (typeof record.patient_name === "string") return record.patient_name;
  const patient = record.patient;
  if (isObj(patient)) {
    if (typeof patient.name === "string") return patient.name;
    const parts = [patient.first_name, patient.last_name].filter((p) => typeof p === "string");
    if (parts.length) return parts.join(" ");
  }
  if ("first_name" in record || "last_name" in record) {
    const parts = [record.first_name, record.last_name].filter((p) => typeof p === "string");
    if (parts.length) return parts.join(" ");
  }
  return null;
}

function toRecord(value: Obj): NormalizedRecord {
  return {
    id: str(value.id),
    updatedAt: str(value.updated_at),
    locationId: num(value.location_id),
    foreignId: str(value.foreign_id),
    patientName: patientNameOf(value),
  };
}

function toSync(value: Obj): SyncSnapshot {
  const locations = Array.isArray(value.locations)
    ? value.locations.map((l) => (isObj(l) ? num(l.id) : null)).filter((id): id is number => id !== null)
    : null;
  return {
    syncSourceName: str(value.sync_source_name),
    readStatus: status(value.read_status),
    readStatusAt: str(value.read_status_at),
    writeStatus: status(value.write_status),
    writeStatusAt: str(value.write_status_at),
    locationIds: locations,
  };
}

/**
 * Payload shapes differ by event: `data.appointment` (object), `data.appointments` (array),
 * `data.syncstatus` (sync snapshot), plus `data.previous_attributes` on updates.
 */
export function normalizeEvent(payload: unknown): NormalizedEvent {
  const parsed = envelope.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidPayloadError(`not a NexHealth webhook payload: ${parsed.error.issues[0]?.message}`);
  }
  const p = parsed.data;
  const { base, outcome } = splitEventName(p.event_name);

  const records: NormalizedRecord[] = [];
  let sync: SyncSnapshot | null = null;
  for (const [key, value] of Object.entries(p.data ?? {})) {
    if (key === "previous_attributes") continue;
    if (key === "syncstatus" && isObj(value)) {
      sync = toSync(value);
    } else if (Array.isArray(value)) {
      for (const item of value) if (isObj(item)) records.push(toRecord(item));
    } else if (isObj(value)) {
      records.push(toRecord(value));
    }
  }

  return {
    subdomain: p.subdomain,
    institutionId: p.institution_id ?? null,
    subscriptionId: p.webhook_subscription_id ?? null,
    resourceType: p.resource_type,
    eventName: p.event_name,
    eventBase: base,
    eventOutcome: outcome,
    eventTime: p.event_time ?? null,
    records,
    sync,
    priorFailedAttempts: p.delivery_errors?.length ?? 0,
  };
}
