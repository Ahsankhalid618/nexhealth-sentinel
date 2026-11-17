import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

const MIGRATIONS = join(process.cwd(), "drizzle");

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

/**
 * `postgres://...` connects to a real Postgres (Neon in production, CI's service container).
 * Anything else is a PGlite data directory, or "memory://" for tests: a real Postgres engine
 * compiled to WASM, so the quickstart needs no Docker. PGlite databases migrate themselves;
 * real Postgres is migrated with `pnpm db:migrate`.
 */
export async function openDb(url: string): Promise<DbHandle> {
  if (/^postgres(ql)?:\/\//.test(url)) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const sql = postgres(url, { max: 5, onnotice: () => {} });
    return { db: drizzle(sql, { schema }) as unknown as Db, close: () => sql.end() };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  if (url !== "memory://") await mkdir(url, { recursive: true });
  const client = new PGlite(url === "memory://" ? undefined : url);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db: db as unknown as Db, close: () => client.close() };
}

export async function migratePostgres(url: string): Promise<void> {
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });
  } finally {
    await sql.end();
  }
}

const globalForDb = globalThis as unknown as { sentinelDb?: Promise<DbHandle> };

/** Process-wide handle. Kept on globalThis so Next's dev reloads don't open a second PGlite on the same directory. */
export function getDb(): Promise<Db> {
  if (!globalForDb.sentinelDb) {
    const url = process.env.DATABASE_URL;
    if (!url && process.env.VERCEL) {
      throw new Error("DATABASE_URL is required on Vercel (PGlite needs a persistent disk)");
    }
    globalForDb.sentinelDb = openDb(url || join(process.cwd(), ".data", "pglite"));
  }
  return globalForDb.sentinelDb.then((h) => h.db);
}
