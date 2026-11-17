import { sql } from "drizzle-orm";
import { resourceVersions } from "@/db/schema";
import type { SentinelContext } from "./context";

export type VersionSource = "webhook" | "api_write" | "reconcile" | "baseline";

/** Records the newest `updated_at` seen for a record. Returns true if this was news (new record or newer version). */
export async function recordVersion(
  ctx: SentinelContext,
  v: { subdomain: string; resourceType: string; id: string; locationId: number | null; updatedAt: string; source: VersionSource },
): Promise<boolean> {
  const updatedAt = new Date(v.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) return false;
  const rows = await ctx.db
    .insert(resourceVersions)
    .values({
      subdomain: v.subdomain,
      resourceType: v.resourceType,
      resourceId: v.id,
      locationId: v.locationId,
      updatedAt,
      source: v.source,
      seenAt: ctx.now(),
    })
    .onConflictDoUpdate({
      target: [resourceVersions.subdomain, resourceVersions.resourceType, resourceVersions.resourceId],
      set: { updatedAt, source: v.source, seenAt: ctx.now(), locationId: v.locationId },
      setWhere: sql`${resourceVersions.updatedAt} < ${updatedAt.toISOString()}::timestamptz`,
    })
    .returning({ id: resourceVersions.resourceId });
  return rows.length > 0;
}
