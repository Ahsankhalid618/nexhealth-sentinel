import { and, lt, sql } from "drizzle-orm";
import { events } from "@/db/schema";
import type { SentinelContext } from "./context";
import { inScope } from "./scope";

export const PAYLOAD_TTL_DAYS = 7;

/** Stored payloads are already redacted; after a week only the normalized record is kept. */
export async function purgeOldPayloads(ctx: SentinelContext, days = PAYLOAD_TTL_DAYS): Promise<number> {
  const cutoff = new Date(ctx.now().getTime() - days * 24 * 60 * 60_000);
  const purged = await ctx.db
    .update(events)
    .set({ payload: sql`'{"purged":true}'::jsonb` })
    .where(and(lt(events.receivedAt, cutoff), sql`not (${events.payload} ? 'purged')`, inScope(ctx, events.subdomain)))
    .returning({ id: events.id });
  return purged.length;
}
