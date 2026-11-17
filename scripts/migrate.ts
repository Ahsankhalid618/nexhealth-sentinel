/** Applies drizzle/ migrations to DATABASE_URL (Postgres). PGlite databases migrate themselves on open. */
import { loadEnv } from "./lib/env";
import { migratePostgres, openDb } from "../src/db/client";

loadEnv();
const url = process.env.DATABASE_URL;
if (url && /^postgres(ql)?:\/\//.test(url)) {
  await migratePostgres(url);
  console.log("Migrated Postgres.");
} else {
  const handle = await openDb(url || ".data/pglite");
  await handle.close();
  console.log(`Migrated PGlite at ${url || ".data/pglite"}.`);
}
