import { count, desc, eq, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Db } from "@/db/client";
import { alerts, events, reconcileCursors, rejectedDeliveries, syncHealth, writes } from "@/db/schema";

const where = (column: PgColumn, subdomain: string | null): SQL | undefined =>
  subdomain ? eq(column, subdomain) : undefined;

export async function loadDashboard(db: Db, subdomain: string | null) {
  const [eventStats] = await db
    .select({
      stored: count(),
      duplicates: sql<number>`coalesce(sum(${events.duplicateCount}), 0)::int`,
      retried: sql<number>`count(*) filter (where ${events.priorFailedAttempts} > 0)::int`,
    })
    .from(events)
    .where(where(events.subdomain, subdomain));

  const [rejectedCount] = await db
    .select({ n: count() })
    .from(rejectedDeliveries)
    .where(where(rejectedDeliveries.claimedSubdomain, subdomain));

  const writeStatuses = await db
    .select({ status: writes.status, n: count() })
    .from(writes)
    .where(where(writes.subdomain, subdomain))
    .groupBy(writes.status);

  const [recovered] = await db
    .select({ n: sql<number>`coalesce(sum(${reconcileCursors.totalRecovered}), 0)::int` })
    .from(reconcileCursors)
    .where(where(reconcileCursors.subdomain, subdomain));

  const subdomains = (await db.selectDistinct({ s: syncHealth.subdomain }).from(syncHealth).orderBy(syncHealth.subdomain)).map(
    (r) => r.s,
  );

  return {
    subdomains,
    stats: {
      eventsStored: eventStats?.stored ?? 0,
      duplicatesIgnored: eventStats?.duplicates ?? 0,
      redelivered: eventStats?.retried ?? 0,
      rejected: rejectedCount?.n ?? 0,
      recovered: recovered?.n ?? 0,
      writes: Object.fromEntries(writeStatuses.map((r) => [r.status, r.n])) as Record<string, number>,
    },
    locations: await db
      .select()
      .from(syncHealth)
      .where(where(syncHealth.subdomain, subdomain))
      .orderBy(syncHealth.subdomain, syncHealth.locationId),
    writes: await db.select().from(writes).where(where(writes.subdomain, subdomain)).orderBy(desc(writes.id)).limit(50),
    alerts: await db.select().from(alerts).where(where(alerts.subdomain, subdomain)).orderBy(desc(alerts.id)).limit(50),
    events: await db
      .select({
        id: events.id,
        subdomain: events.subdomain,
        eventName: events.eventName,
        eventTime: events.eventTime,
        receivedAt: events.receivedAt,
        recordIds: events.recordIds,
        duplicateCount: events.duplicateCount,
        priorFailedAttempts: events.priorFailedAttempts,
        processedAt: events.processedAt,
      })
      .from(events)
      .where(where(events.subdomain, subdomain))
      .orderBy(desc(events.id))
      .limit(50),
    rejected: await db
      .select()
      .from(rejectedDeliveries)
      .where(where(rejectedDeliveries.claimedSubdomain, subdomain))
      .orderBy(desc(rejectedDeliveries.id))
      .limit(20),
  };
}

export type Dashboard = Awaited<ReturnType<typeof loadDashboard>>;
