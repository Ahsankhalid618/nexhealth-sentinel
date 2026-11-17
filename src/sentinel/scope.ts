import { eq, notLike, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { SentinelContext } from "./context";

/** Simulator institutions. They run on a virtual clock, so real-time timer work leaves them alone. */
export const SIM_PREFIX = "sim-";

export function inScope(ctx: SentinelContext, subdomain: PgColumn): SQL {
  return ctx.scope ? eq(subdomain, ctx.scope) : notLike(subdomain, `${SIM_PREFIX}%`);
}
