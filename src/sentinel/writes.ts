import { and, desc, eq, inArray } from "drizzle-orm";
import { initials } from "@/core/redact";
import { isRetryable, nextWriteStatus, type WriteSignal, type WriteStatus } from "@/core/write-state";
import { syncHealth, writes, type AppointmentRequest, type WriteRow } from "@/db/schema";
import { NexHealthError } from "@/nexhealth/client";
import type { Appointment } from "@/nexhealth/types";
import { raiseAlert, resolveAlerts } from "./alerts";
import { officeHoursFor } from "./config";
import type { SentinelContext } from "./context";
import { NO_SYNC_DETAIL, ensureLocation, syncPreflight } from "./sync-monitor";
import { isWithinOfficeHours } from "@/core/sync-state";
import { inScope } from "./scope";
import { formatLocal } from "./time";
import { recordVersion } from "./versions";

export interface BookingInput {
  /** Your own idempotency key. NexHealth has no Idempotency-Key header, so this layer provides one. */
  clientKey: string;
  subdomain: string;
  locationId: number;
  appointment: AppointmentRequest;
  /** Only the initials are stored, for the dashboard. */
  patientName?: string | null;
}

export interface BookingResult {
  write: WriteRow;
  /** True when this clientKey was seen before; nothing was sent to NexHealth. */
  replayed: boolean;
}

const TERMINAL: WriteStatus[] = ["complete", "failed", "timed_out", "rejected"];

/** Applies a state-machine signal. Returns the updated row, or null when the signal doesn't apply. */
export async function transitionWrite(
  ctx: SentinelContext,
  write: WriteRow,
  signal: WriteSignal,
  patch: Partial<Pick<WriteRow, "statusDetail" | "foreignId" | "patientInitials" | "lastError" | "nexAppointmentId" | "acceptedAt">> = {},
): Promise<WriteRow | null> {
  const next = nextWriteStatus(write.status as WriteStatus, signal);
  if (!next) return null;
  const now = ctx.now();
  const [updated] = await ctx.db
    .update(writes)
    .set({
      ...patch,
      status: next,
      updatedAt: now,
      resolvedAt: TERMINAL.includes(next) ? now : null,
    })
    .where(and(eq(writes.id, write.id), eq(writes.status, write.status)))
    .returning();
  if (!updated) return null;

  const label = `Write #${write.id} (appointment ${write.nexAppointmentId ?? "not created"}, ${write.subdomain}, location ${write.locationId})`;
  if (next === "failed" || next === "timed_out") {
    await raiseAlert(ctx, {
      dedupeKey: `write:${write.id}:${next}`,
      kind: `write_${next}`,
      severity: "warning",
      subdomain: write.subdomain,
      locationId: write.locationId,
      message:
        next === "failed"
          ? `${label} failed in the EHR. NexHealth gives no reason and does not retry. Use safe-retry, which reads it back first.`
          : `${label} timed out: the start time passed before the sync could write it.`,
    });
  }
  if (next === "complete") await resolveAlerts(ctx, `stuck:${write.id}`);
  return updated;
}

async function findByClientKey(ctx: SentinelContext, clientKey: string): Promise<WriteRow | undefined> {
  const [row] = await ctx.db.select().from(writes).where(eq(writes.clientKey, clientKey));
  return row;
}

function storedRequest(appointment: AppointmentRequest): AppointmentRequest {
  // Notes are free text that may hold PHI, so they are sent but never stored.
  const { note: _note, ...rest } = appointment;
  return rest;
}

export async function createTrackedAppointment(
  ctx: SentinelContext,
  input: BookingInput,
  retryOfId: number | null = null,
): Promise<BookingResult> {
  const existing = await findByClientKey(ctx, input.clientKey);
  if (existing) return { write: existing, replayed: true };

  await ensureLocation(ctx, input.subdomain, input.locationId);
  const preflight = await syncPreflight(ctx, input.subdomain, input.locationId);
  const now = ctx.now();
  const [row] = await ctx.db
    .insert(writes)
    .values({
      clientKey: input.clientKey,
      subdomain: input.subdomain,
      locationId: input.locationId,
      status: "requested",
      preflight,
      request: storedRequest(input.appointment),
      startTime: new Date(input.appointment.start_time),
      patientInitials: input.patientName ? initials(input.patientName) : null,
      retryOfId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: writes.clientKey })
    .returning();
  if (!row) return { write: (await findByClientKey(ctx, input.clientKey))!, replayed: true };

  if (preflight !== "ok" && preflight !== "unknown" && ctx.config.preflightMode === "refuse") {
    const refused = await transitionWrite(ctx, row, "post_rejected", {
      statusDetail: `Not sent: ${preflight === "no_sync" ? NO_SYNC_DETAIL : "the sync is not taking writes"} (PREFLIGHT_MODE=refuse).`,
    });
    return { write: refused!, replayed: false };
  }

  let appt: Appointment;
  try {
    appt = await ctx.nex.createAppointment(input.subdomain, input.locationId, input.appointment);
  } catch (err) {
    if (err instanceof NexHealthError && err.isRejection) {
      const rejected = await transitionWrite(ctx, row, "post_rejected", {
        lastError: err.errors.join("; ").slice(0, 500),
        statusDetail: `NexHealth rejected the booking (${err.status}).`,
      });
      return { write: rejected!, replayed: false };
    }
    const [unknown] = await ctx.db
      .update(writes)
      .set({
        lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        statusDetail: "Outcome unknown: the POST got no clear answer, so it may or may not exist. safe-retry searches for it before sending again.",
        updatedAt: ctx.now(),
      })
      .where(eq(writes.id, row.id))
      .returning();
    return { write: unknown!, replayed: false };
  }

  const detail =
    preflight === "no_sync"
      ? NO_SYNC_DETAIL
      : preflight === "will_wait"
        ? "Accepted, but the sync is not taking writes right now, so this booking will wait."
        : "Accepted by NexHealth; waiting for the EHR write.";
  const accepted = await transitionWrite(ctx, row, "post_accepted", {
    nexAppointmentId: appt.id,
    acceptedAt: ctx.now(),
    foreignId: appt.foreign_id,
    statusDetail: detail,
  });
  await recordVersion(ctx, {
    subdomain: input.subdomain,
    resourceType: "Appointment",
    id: String(appt.id),
    locationId: input.locationId,
    updatedAt: appt.updated_at,
    source: "api_write",
  });
  return { write: accepted!, replayed: false };
}

export type SafeRetryResult =
  | { outcome: "resent"; write: WriteRow; previous: WriteRow }
  | { outcome: "already_written" | "found_original"; write: WriteRow }
  | { outcome: "not_retryable"; write: WriteRow; reason: string }
  | { outcome: "not_found" };

/**
 * "NexHealth does not retry a failed write automatically. Before you send it again, read the
 * original record and confirm that foreign_id is still null." (docs: how-a-write-reaches-the-ehr)
 */
export async function safeRetry(
  ctx: SentinelContext,
  writeId: number,
  overrides: Partial<AppointmentRequest> = {},
): Promise<SafeRetryResult> {
  const [write] = await ctx.db.select().from(writes).where(eq(writes.id, writeId));
  if (!write) return { outcome: "not_found" };
  if (write.retriedById) return { outcome: "not_retryable", write, reason: `already retried as write #${write.retriedById}` };

  const status = write.status as WriteStatus;
  const unknownOutcome = status === "requested" && write.lastError !== null && write.nexAppointmentId === null;

  if (isRetryable(status) && write.nexAppointmentId !== null) {
    const appt = await ctx.nex.getAppointment(write.subdomain, write.nexAppointmentId);
    await ctx.db.update(writes).set({ lastCheckedAt: ctx.now() }).where(eq(writes.id, write.id));
    if (appt.foreign_id !== null) {
      const done = await transitionWrite(ctx, write, "readback_written", {
        foreignId: appt.foreign_id,
        statusDetail: "Read-back found it in the EHR (foreign_id is set); not resent.",
      });
      return { outcome: "already_written", write: done ?? write };
    }
  } else if (unknownOutcome) {
    const original = await findOriginal(ctx, write);
    if (original) {
      const adopted = await transitionWrite(ctx, write, "post_accepted", {
        nexAppointmentId: original.id,
        acceptedAt: ctx.now(),
        lastError: null,
        statusDetail: "The first POST did land: found it by patient and start time; not resent.",
      });
      return { outcome: "found_original", write: adopted ?? write };
    }
  } else {
    return { outcome: "not_retryable", write, reason: `status is ${status}; only failed, timed_out or unknown-outcome writes can be resent` };
  }

  const attempt = (await ctx.db.select({ id: writes.id }).from(writes).where(eq(writes.retryOfId, write.id))).length + 1;
  const { write: next } = await createTrackedAppointment(
    ctx,
    {
      clientKey: `${write.clientKey}#retry${attempt}`,
      subdomain: write.subdomain,
      locationId: write.locationId,
      appointment: { ...write.request, ...overrides },
    },
    write.id,
  );
  let resent = next;
  if (write.patientInitials && !next.patientInitials) {
    [resent = next] = await ctx.db
      .update(writes)
      .set({ patientInitials: write.patientInitials })
      .where(eq(writes.id, next.id))
      .returning();
  }
  if (unknownOutcome) {
    await transitionWrite(ctx, write, "post_rejected", { statusDetail: `No booking found after the unanswered POST; resent as write #${next.id}.` });
  }
  const [previous] = await ctx.db
    .update(writes)
    .set({ retriedById: next.id, updatedAt: ctx.now() })
    .where(eq(writes.id, write.id))
    .returning();
  return { outcome: "resent", write: resent, previous: previous! };
}

async function findOriginal(ctx: SentinelContext, write: WriteRow): Promise<Appointment | undefined> {
  const start = new Date(write.request.start_time).getTime();
  const { data } = await ctx.nex.listAppointments({
    subdomain: write.subdomain,
    location_id: write.locationId,
    start: new Date(start - 60_000).toISOString(),
    end: new Date(start + 60_000).toISOString(),
    "patient_ids[]": [write.request.patient_id],
    per_page: 50,
  });
  return data.find(
    (a) => a.provider_id === write.request.provider_id && Date.parse(a.start_time) === start && !a.cancelled,
  );
}

/** Webhook or reconciler evidence about one appointment we booked. */
export async function applyAppointmentEvidence(
  ctx: SentinelContext,
  subdomain: string,
  record: { id: string | null; foreignId: string | null; patientInitials?: string | null },
  signal: WriteSignal | null,
): Promise<void> {
  if (!record.id || !/^\d+$/.test(record.id)) return;
  const [write] = await ctx.db
    .select()
    .from(writes)
    .where(and(eq(writes.subdomain, subdomain), eq(writes.nexAppointmentId, Number(record.id))))
    .orderBy(desc(writes.id))
    .limit(1);
  if (!write) return;

  let current: WriteRow = write;
  if (record.patientInitials && !write.patientInitials) {
    const [w] = await ctx.db.update(writes).set({ patientInitials: record.patientInitials }).where(eq(writes.id, write.id)).returning();
    current = w ?? write;
  }
  const details: Partial<Record<WriteSignal, string>> = {
    insertion_complete: "appointment_insertion.complete received: it is in the EHR.",
    insertion_failed: "appointment_insertion.failed received. NexHealth does not say why.",
    insertion_timed_out: "appointment_insertion.timed_out received: the start time passed before it could be written.",
  };
  if (signal) {
    const moved = await transitionWrite(ctx, current, signal, { statusDetail: details[signal] ?? null, foreignId: record.foreignId });
    if (moved) current = moved;
  }
  if (record.foreignId && current.status !== "complete") {
    await transitionWrite(ctx, current, "readback_written", {
      foreignId: record.foreignId,
      statusDetail: "Seen with foreign_id set: it is in the EHR.",
    });
  }
}

/**
 * Timer side of the state machine: read back writes that have waited too long, mark them
 * stuck when their location's sync can't take writes, and un-stick them when it recovers.
 */
export async function checkPendingWrites(ctx: SentinelContext): Promise<void> {
  const pendingStatus = inArray(writes.status, ["accepted", "stuck"]);
  const pending = await ctx.db
    .select()
    .from(writes)
    .where(and(pendingStatus, inScope(ctx, writes.subdomain)));
  const now = ctx.now();
  for (const write of pending) {
    if (write.nexAppointmentId === null) continue;
    const waitedMin = (now.getTime() - (write.acceptedAt ?? write.createdAt).getTime()) / 60_000;
    if (write.status === "accepted" && waitedMin < ctx.config.stuckWriteAfterMin) continue;

    const appt = await ctx.nex.getAppointment(write.subdomain, write.nexAppointmentId);
    await ctx.db.update(writes).set({ lastCheckedAt: now }).where(eq(writes.id, write.id));
    const patientInitials = appt.patient?.name ? initials(appt.patient.name) : null;
    if (appt.foreign_id !== null) {
      await applyAppointmentEvidence(ctx, write.subdomain, { id: String(appt.id), foreignId: appt.foreign_id, patientInitials }, null);
      continue;
    }

    const [health] = await ctx.db
      .select()
      .from(syncHealth)
      .where(and(eq(syncHealth.subdomain, write.subdomain), eq(syncHealth.locationId, write.locationId)));
    const noSync = health?.hasSync === false;
    const blocked = noSync || health?.writeStatus === "red";

    if (write.status === "accepted" && blocked) {
      const detail = noSync
        ? NO_SYNC_DETAIL
        : `Stuck: the location's sync has not taken writes since ${health?.writeStatusAt ? formatLocal(health.writeStatusAt, health.timezone) : "unknown"}. Read back ${formatLocal(now, health?.timezone ?? "UTC")}: foreign_id still null.`;
      await transitionWrite(ctx, write, "sync_blocked", { statusDetail: detail });
      const inHours = health ? isWithinOfficeHours(officeHoursFor(ctx.config, write.subdomain, write.locationId, health.timezone), now) : true;
      await raiseAlert(ctx, {
        dedupeKey: `stuck:${write.id}`,
        kind: "write_stuck",
        severity: noSync || !inHours ? "info" : "critical",
        subdomain: write.subdomain,
        locationId: write.locationId,
        message: `Write #${write.id} (appointment ${write.nexAppointmentId}) has waited ${Math.round(waitedMin)} min and is stuck. ${noSync ? NO_SYNC_DETAIL : inHours ? "The sync is down during office hours." : "The office is closed; expected to land when the sync comes back."}`,
      });
    } else if (write.status === "stuck" && !blocked) {
      await transitionWrite(ctx, write, "sync_recovered", { statusDetail: "The sync is taking writes again; waiting for the insertion event." });
    }
  }
}
