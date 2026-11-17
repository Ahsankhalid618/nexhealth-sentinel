import { and, eq } from "drizzle-orm";
import type { SyncSnapshot } from "@/core/normalize";
import { classifySyncState, outageMinutesDuringOfficeHours, shouldAlertOnSync, type SyncState } from "@/core/sync-state";
import { syncHealth, type SyncHealthRow } from "@/db/schema";
import type { SyncStatusEntry } from "@/nexhealth/types";
import { raiseAlert, resolveAlerts } from "./alerts";
import { officeHoursFor } from "./config";
import type { SentinelContext } from "./context";
import { formatLocal } from "./time";

const FALLBACK_TZ = "America/New_York";

export const NO_SYNC_DETAIL = "No sync behind this location: NexHealth accepts the booking but it will never reach an EHR.";

/** Adds every location NexHealth reports (GET /locations) to the monitor, with its name and time zone. */
export async function discoverLocations(ctx: SentinelContext, subdomain?: string): Promise<number> {
  const institutions = await ctx.nex.getLocations(subdomain);
  let count = 0;
  for (const inst of institutions) {
    for (const loc of inst.locations ?? []) {
      if (loc.inactive) continue;
      await ctx.db
        .insert(syncHealth)
        .values({
          subdomain: inst.subdomain,
          locationId: loc.id,
          locationName: loc.name,
          timezone: loc.tz || FALLBACK_TZ,
          updatedAt: ctx.now(),
        })
        .onConflictDoUpdate({
          target: [syncHealth.subdomain, syncHealth.locationId],
          set: { locationName: loc.name, timezone: loc.tz || FALLBACK_TZ },
        });
      count++;
    }
  }
  return count;
}

export async function ensureLocation(ctx: SentinelContext, subdomain: string, locationId: number): Promise<void> {
  const existing = await ctx.db
    .select({ id: syncHealth.locationId })
    .from(syncHealth)
    .where(and(eq(syncHealth.subdomain, subdomain), eq(syncHealth.locationId, locationId)));
  if (existing.length) return;
  try {
    await discoverLocations(ctx, subdomain);
  } catch {
    // fall through and track it with the fallback zone
  }
  await ctx.db
    .insert(syncHealth)
    .values({ subdomain, locationId, timezone: FALLBACK_TZ, updatedAt: ctx.now() })
    .onConflictDoNothing();
}

type StatusUpdate = Pick<SyncSnapshot, "readStatus" | "readStatusAt" | "writeStatus" | "writeStatusAt" | "syncSourceName">;

async function applyStatus(
  ctx: SentinelContext,
  row: SyncHealthRow,
  status: StatusUpdate | null,
  observedAt: Date,
  source: "webhook" | "poll",
): Promise<void> {
  const anyRed = status?.readStatus === "red" || status?.writeStatus === "red";
  await ctx.db
    .update(syncHealth)
    .set({
      hasSync: status !== null,
      syncSourceName: status?.syncSourceName ?? null,
      readStatus: status?.readStatus ?? null,
      readStatusAt: status?.readStatusAt ? new Date(status.readStatusAt) : null,
      writeStatus: status?.writeStatus ?? null,
      writeStatusAt: status?.writeStatusAt ? new Date(status.writeStatusAt) : null,
      redSince: anyRed ? (row.redSince ?? observedAt) : null,
      lastSource: source,
      updatedAt: ctx.now(),
    })
    .where(and(eq(syncHealth.subdomain, row.subdomain), eq(syncHealth.locationId, row.locationId)));
}

/**
 * A SyncStatus webhook. The documented payload has `locations: null`, so when locations are
 * missing the change is applied to every location of the institution that this sync (by
 * name) was last seen serving, or that has not been matched to a sync yet.
 */
export async function applySyncEvent(
  ctx: SentinelContext,
  subdomain: string,
  snapshot: SyncSnapshot,
  observedAt: Date,
): Promise<void> {
  const rows = await ctx.db.select().from(syncHealth).where(eq(syncHealth.subdomain, subdomain));
  const targets = snapshot.locationIds
    ? rows.filter((r) => snapshot.locationIds!.includes(r.locationId))
    : rows.filter((r) => r.syncSourceName === snapshot.syncSourceName || (r.syncSourceName === null && r.hasSync !== false));
  for (const row of targets) await applyStatus(ctx, row, snapshot, observedAt, "webhook");
}

const fromEntry = (e: SyncStatusEntry): StatusUpdate => ({
  syncSourceName: e.sync_source_name,
  readStatus: e.read_status,
  readStatusAt: e.read_status_at,
  writeStatus: e.write_status,
  writeStatusAt: e.write_status_at,
});

/** The backstop: webhooks can be skipped, so poll GET /sync_status for every monitored institution. */
export async function pollSyncStatus(ctx: SentinelContext): Promise<void> {
  const rows = await ctx.db.select().from(syncHealth);
  const subdomains = [...new Set(rows.map((r) => r.subdomain))];
  for (const subdomain of subdomains) {
    const entries = await ctx.nex.getSyncStatus(subdomain);
    for (const row of rows.filter((r) => r.subdomain === subdomain)) {
      const entry =
        entries.find((e) => e.locations?.some((l) => l.id === row.locationId)) ??
        (entries.length === 1 && !entries[0]!.locations ? entries[0] : undefined);
      await applyStatus(ctx, row, entry ? fromEntry(entry) : null, ctx.now(), "poll");
    }
  }
}

export async function syncPreflight(
  ctx: SentinelContext,
  subdomain: string,
  locationId: number,
): Promise<"ok" | "will_wait" | "no_sync" | "unknown"> {
  let entries: SyncStatusEntry[];
  try {
    entries = await ctx.nex.getSyncStatus(subdomain, [locationId]);
  } catch {
    return "unknown";
  }
  const entry = entries.find((e) => e.locations?.some((l) => l.id === locationId)) ?? entries[0];
  const [row] = await ctx.db
    .select()
    .from(syncHealth)
    .where(and(eq(syncHealth.subdomain, subdomain), eq(syncHealth.locationId, locationId)));
  if (row) await applyStatus(ctx, row, entry ? fromEntry(entry) : null, ctx.now(), "poll");
  if (!entry) return "no_sync";
  return entry.write_status === "green" ? "ok" : "will_wait";
}

export function stateOf(ctx: SentinelContext, row: SyncHealthRow): SyncState | "unknown" {
  if (row.hasSync === null) return "unknown";
  const status = row.hasSync
    ? { readStatus: row.readStatus as "green" | "red" | null, writeStatus: row.writeStatus as "green" | "red" | null }
    : null;
  const hours = officeHoursFor(ctx.config, row.subdomain, row.locationId, row.timezone);
  return classifySyncState(status, hours, ctx.now());
}

/** Classify every location and raise or resolve alerts. */
export async function evaluateSyncHealth(ctx: SentinelContext): Promise<void> {
  const rows = await ctx.db.select().from(syncHealth);
  const now = ctx.now();
  for (const row of rows) {
    const state = stateOf(ctx, row);
    await ctx.db
      .update(syncHealth)
      .set({ state })
      .where(and(eq(syncHealth.subdomain, row.subdomain), eq(syncHealth.locationId, row.locationId)));

    const where = `${row.locationName ?? "location"} (${row.subdomain}, location ${row.locationId})`;
    const keyBase = `sync:${row.subdomain}:${row.locationId}:`;
    if (state === "no_sync") {
      await raiseAlert(ctx, {
        dedupeKey: `nosync:${row.subdomain}:${row.locationId}`,
        kind: "no_sync",
        severity: "info",
        subdomain: row.subdomain,
        locationId: row.locationId,
        message: `${where}: GET /sync_status has no entry. ${NO_SYNC_DETAIL}`,
      });
    }
    if (state === "unknown" || state === "no_sync") continue;

    const hours = officeHoursFor(ctx.config, row.subdomain, row.locationId, row.timezone);
    if (shouldAlertOnSync(state, row.redSince, hours, now, ctx.config.syncAlertAfterMin)) {
      const minutes = outageMinutesDuringOfficeHours(row.redSince!, hours, now);
      const what = state === "down" ? "Sync is down (reads and writes red)" : "Writes are blocked (write_status red)";
      await raiseAlert(ctx, {
        dedupeKey: `${keyBase}${row.redSince!.toISOString()}`,
        kind: "sync_down",
        severity: "critical",
        subdomain: row.subdomain,
        locationId: row.locationId,
        message: `${what} at ${where} for ${minutes} min during office hours, since ${formatLocal(row.redSince!, row.timezone)}. New bookings will wait until the office's sync comes back.`,
      });
    }
    if (state === "healthy") await resolveAlerts(ctx, keyBase);
  }
}
