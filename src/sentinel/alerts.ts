import { and, eq, isNull, like } from "drizzle-orm";
import { alerts } from "@/db/schema";
import type { NewAlert, SentinelContext } from "./context";

const scoped = (ctx: SentinelContext, key: string) => (ctx.scope ? `${ctx.scope}/${key}` : key);

/** Inserts the alert unless one with the same dedupe key exists. Returns true when it was new. */
export async function raiseAlert(ctx: SentinelContext, alert: NewAlert): Promise<boolean> {
  const inserted = await ctx.db
    .insert(alerts)
    .values({
      dedupeKey: scoped(ctx, alert.dedupeKey),
      kind: alert.kind,
      severity: alert.severity,
      subdomain: alert.subdomain ?? ctx.scope ?? null,
      locationId: alert.locationId ?? null,
      message: alert.message,
      createdAt: ctx.now(),
      notified: alert.severity !== "info",
    })
    .onConflictDoNothing({ target: alerts.dedupeKey })
    .returning({ id: alerts.id });
  if (inserted.length === 0) return false;
  await ctx.notify(alert);
  return true;
}

export async function resolveAlerts(ctx: SentinelContext, dedupeKeyPrefix: string): Promise<void> {
  await ctx.db
    .update(alerts)
    .set({ resolvedAt: ctx.now() })
    .where(and(like(alerts.dedupeKey, `${scoped(ctx, dedupeKeyPrefix)}%`), isNull(alerts.resolvedAt)));
}

export async function openAlertExists(ctx: SentinelContext, dedupeKey: string): Promise<boolean> {
  const rows = await ctx.db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.dedupeKey, scoped(ctx, dedupeKey)), isNull(alerts.resolvedAt)));
  return rows.length > 0;
}
