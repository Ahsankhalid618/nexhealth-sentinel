import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { NormalizedEvent, NormalizedRecord } from "@/core/normalize";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** One row per distinct webhook event. Retries of the same event only bump `duplicate_count`. */
export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    fingerprint: text("fingerprint").notNull().unique(),
    subdomain: text("subdomain").notNull(),
    institutionId: integer("institution_id"),
    locationId: integer("location_id"),
    resourceType: text("resource_type").notNull(),
    eventName: text("event_name").notNull(),
    eventOutcome: text("event_outcome"),
    eventTime: ts("event_time"),
    recordIds: jsonb("record_ids").$type<string[]>().notNull(),
    /** What processing needs, with patient names reduced to initials. */
    normalized: jsonb("normalized").$type<StoredEvent>().notNull(),
    /** Patient-like fields are redacted before storage; the raw body is never persisted. */
    payload: jsonb("payload").notNull(),
    priorFailedAttempts: integer("prior_failed_attempts").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    lastDuplicateAt: ts("last_duplicate_at"),
    receivedAt: ts("received_at").notNull(),
    processedAt: ts("processed_at"),
  },
  (t) => [index("events_subdomain_idx").on(t.subdomain)],
);

/** Deliveries that failed verification. Only metadata is kept, never the body. */
export const rejectedDeliveries = pgTable("rejected_deliveries", {
  id: serial("id").primaryKey(),
  reason: text("reason").notNull(),
  claimedSubdomain: text("claimed_subdomain"),
  claimedEventName: text("claimed_event_name"),
  timestampHeader: text("timestamp_header"),
  bodySha256: text("body_sha256").notNull(),
  bodyBytes: integer("body_bytes").notNull(),
  receivedAt: ts("received_at").notNull(),
});

/** Appointment bookings we sent, tracked until the EHR has them. */
export const writes = pgTable(
  "writes",
  {
    id: serial("id").primaryKey(),
    clientKey: text("client_key").notNull().unique(),
    subdomain: text("subdomain").notNull(),
    locationId: integer("location_id").notNull(),
    nexAppointmentId: bigint("nex_appointment_id", { mode: "number" }),
    status: text("status").notNull(),
    statusDetail: text("status_detail"),
    preflight: text("preflight").notNull(),
    request: jsonb("request").$type<AppointmentRequest>().notNull(),
    startTime: ts("start_time"),
    patientInitials: text("patient_initials"),
    foreignId: text("foreign_id"),
    lastError: text("last_error"),
    retryOfId: integer("retry_of_id"),
    retriedById: integer("retried_by_id"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    acceptedAt: ts("accepted_at"),
    resolvedAt: ts("resolved_at"),
    lastCheckedAt: ts("last_checked_at"),
  },
  (t) => [index("writes_nex_id_idx").on(t.subdomain, t.nexAppointmentId)],
);

/** Latest known sync state per location, fed by SyncStatus webhooks and GET /sync_status polls. */
export const syncHealth = pgTable(
  "sync_health",
  {
    subdomain: text("subdomain").notNull(),
    locationId: integer("location_id").notNull(),
    locationName: text("location_name"),
    timezone: text("timezone").notNull(),
    hasSync: boolean("has_sync"),
    syncSourceName: text("sync_source_name"),
    readStatus: text("read_status"),
    readStatusAt: ts("read_status_at"),
    writeStatus: text("write_status"),
    writeStatusAt: ts("write_status_at"),
    state: text("state").notNull().default("unknown"),
    redSince: ts("red_since"),
    lastSource: text("last_source"),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.subdomain, t.locationId] })],
);

/** The newest `updated_at` we have seen per record, and how we learned about it. */
export const resourceVersions = pgTable(
  "resource_versions",
  {
    subdomain: text("subdomain").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    locationId: integer("location_id"),
    updatedAt: ts("updated_at").notNull(),
    /** webhook | api_write | reconcile | baseline */
    source: text("source").notNull(),
    seenAt: ts("seen_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.subdomain, t.resourceType, t.resourceId] })],
);

export const reconcileCursors = pgTable(
  "reconcile_cursors",
  {
    subdomain: text("subdomain").notNull(),
    locationId: integer("location_id").notNull(),
    resourceType: text("resource_type").notNull(),
    cursor: ts("cursor").notNull(),
    lastRunAt: ts("last_run_at").notNull(),
    lastRecovered: integer("last_recovered").notNull().default(0),
    totalRecovered: integer("total_recovered").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.subdomain, t.locationId, t.resourceType] })],
);

/** Alerts carry ids, subdomain, location and status only: never patient data. */
export const alerts = pgTable("alerts", {
  id: serial("id").primaryKey(),
  dedupeKey: text("dedupe_key").notNull().unique(),
  kind: text("kind").notNull(),
  severity: text("severity").notNull(),
  subdomain: text("subdomain"),
  locationId: integer("location_id"),
  message: text("message").notNull(),
  createdAt: ts("created_at").notNull(),
  resolvedAt: ts("resolved_at"),
  notified: boolean("notified").notNull().default(false),
});

export type StoredRecord = Omit<NormalizedRecord, "patientName"> & { patientInitials: string | null };
export type StoredEvent = Omit<NormalizedEvent, "records"> & { records: StoredRecord[] };

export interface AppointmentRequest {
  patient_id: number;
  provider_id: number;
  start_time: string;
  end_time?: string;
  operatory_id?: number;
  appointment_type_id?: number;
  note?: string;
}

export type EventRow = typeof events.$inferSelect;
export type WriteRow = typeof writes.$inferSelect;
export type SyncHealthRow = typeof syncHealth.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
