import { and, eq } from "drizzle-orm";
import { reconcileCursors, syncHealth } from "@/db/schema";
import { raiseAlert } from "./alerts";
import type { SentinelContext } from "./context";
import { recordVersion } from "./versions";
import { applyAppointmentEvidence } from "./writes";

const DAY = 24 * 60 * 60_000;

export interface ReconcileReport {
  locations: number;
  scanned: number;
  recovered: number;
}

/**
 * Pull appointments changed since the last run and count any version webhooks never
 * delivered. Skipped deliveries (endpoint paused) are "not sent later", so this is the only
 * way to get them back. The first run per location only records a baseline.
 */
export async function reconcileAppointments(ctx: SentinelContext): Promise<ReconcileReport> {
  const locations = await ctx.db.select().from(syncHealth);
  const report: ReconcileReport = { locations: locations.length, scanned: 0, recovered: 0 };
  const { pastDays, futureDays, overlapMin } = ctx.config.reconcile;

  for (const loc of locations) {
    const startedAt = ctx.now();
    const [cursor] = await ctx.db
      .select()
      .from(reconcileCursors)
      .where(
        and(
          eq(reconcileCursors.subdomain, loc.subdomain),
          eq(reconcileCursors.locationId, loc.locationId),
          eq(reconcileCursors.resourceType, "Appointment"),
        ),
      );
    const baseline = !cursor;
    // "updated_since returns records updated at or after the time you send, so overlap by a few minutes."
    const updatedSince = cursor ? new Date(cursor.cursor.getTime() - overlapMin * 60_000).toISOString() : undefined;

    let recovered = 0;
    let endCursor: string | undefined;
    for (;;) {
      const page = await ctx.nex.listAppointments({
        subdomain: loc.subdomain,
        location_id: loc.locationId,
        start: new Date(startedAt.getTime() - pastDays * DAY).toISOString(),
        end: new Date(startedAt.getTime() + futureDays * DAY).toISOString(),
        updated_since: updatedSince,
        sort: "updated_at",
        per_page: 1000,
        end_cursor: endCursor,
      });
      for (const appt of page.data) {
        report.scanned++;
        const isNew = await recordVersion(ctx, {
          subdomain: loc.subdomain,
          resourceType: "Appointment",
          id: String(appt.id),
          locationId: appt.location_id,
          updatedAt: appt.updated_at,
          source: baseline ? "baseline" : "reconcile",
        });
        if (isNew && !baseline) recovered++;
        await applyAppointmentEvidence(ctx, loc.subdomain, { id: String(appt.id), foreignId: appt.foreign_id }, null);
      }
      if (!page.pageInfo?.has_next_page || !page.pageInfo.end_cursor) break;
      endCursor = page.pageInfo.end_cursor;
    }

    const values = {
      subdomain: loc.subdomain,
      locationId: loc.locationId,
      resourceType: "Appointment",
      cursor: startedAt,
      lastRunAt: ctx.now(),
      lastRecovered: recovered,
      totalRecovered: (cursor?.totalRecovered ?? 0) + recovered,
    };
    await ctx.db
      .insert(reconcileCursors)
      .values(values)
      .onConflictDoUpdate({
        target: [reconcileCursors.subdomain, reconcileCursors.locationId, reconcileCursors.resourceType],
        set: values,
      });

    if (recovered > 0) {
      await raiseAlert(ctx, {
        dedupeKey: `gap:${loc.subdomain}:${loc.locationId}:${startedAt.toISOString()}`,
        kind: "gap_recovered",
        severity: "warning",
        subdomain: loc.subdomain,
        locationId: loc.locationId,
        message: `Recovered ${recovered} appointment change(s) at ${loc.locationName ?? `location ${loc.locationId}`} that no webhook delivered. Check the endpoint: deliveries skipped during a pause are not resent.`,
      });
    }
    report.recovered += recovered;
  }
  return report;
}
