import { and, asc, eq, isNull } from "drizzle-orm";
import type { WriteSignal } from "@/core/write-state";
import { events, type EventRow } from "@/db/schema";
import type { SentinelContext } from "./context";
import { inScope } from "./scope";
import { applySyncEvent, evaluateSyncHealth } from "./sync-monitor";
import { recordVersion } from "./versions";
import { applyAppointmentEvidence } from "./writes";

const INSERTION_SIGNALS: Record<string, WriteSignal> = {
  complete: "insertion_complete",
  failed: "insertion_failed",
  timed_out: "insertion_timed_out",
};

/** Applies every stored but unprocessed event, oldest first. Each event is claimed once, so this is safe to run concurrently. */
export async function processPendingEvents(ctx: SentinelContext): Promise<number> {
  const pending = await ctx.db
    .select({ id: events.id })
    .from(events)
    .where(and(isNull(events.processedAt), inScope(ctx, events.subdomain)))
    .orderBy(asc(events.id))
    .limit(500);
  let processed = 0;
  for (const { id } of pending) {
    const [claimed] = await ctx.db
      .update(events)
      .set({ processedAt: ctx.now() })
      .where(and(eq(events.id, id), isNull(events.processedAt)))
      .returning();
    if (!claimed) continue;
    await applyEvent(ctx, claimed);
    processed++;
  }
  return processed;
}

async function applyEvent(ctx: SentinelContext, row: EventRow): Promise<void> {
  const event = row.normalized;
  for (const record of event.records) {
    if (record.id && record.updatedAt) {
      await recordVersion(ctx, {
        subdomain: event.subdomain,
        resourceType: event.resourceType,
        id: record.id,
        locationId: record.locationId,
        updatedAt: record.updatedAt,
        source: "webhook",
      });
    }
  }

  if (event.resourceType === "Appointment") {
    const signal =
      event.eventBase === "appointment_insertion" && event.eventOutcome ? INSERTION_SIGNALS[event.eventOutcome] ?? null : null;
    for (const record of event.records) {
      await applyAppointmentEvidence(ctx, event.subdomain, record, signal);
    }
  }

  if (event.sync) {
    await applySyncEvent(ctx, event.subdomain, event.sync, event.eventTime ? new Date(event.eventTime) : ctx.now());
    await evaluateSyncHealth(ctx);
  }
}
