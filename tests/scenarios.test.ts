import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { migratePostgres, openDb, type Db } from "@/db/client";
import { alerts, events, writes } from "@/db/schema";
import { defaultDemoDay, runScenario, SCENARIO_NAMES } from "@/sim/scenarios";

const DAY = "2026-11-10"; // a Tuesday

let db: Db;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (url) await migratePostgres(url);
  const handle = await openDb(url ?? "memory://");
  db = handle.db;
  return handle.close;
});

describe("simulator scenarios", () => {
  it.each(SCENARIO_NAMES)("%s passes all of its checks", async (name) => {
    const result = await runScenario(name, { db, day: DAY });
    const failed = result.checks.filter((c) => !c.ok).map((c) => c.label);
    expect(failed, result.timeline.map((t) => `${t.at} ${t.text}`).join("\n")).toEqual([]);
    expect(result.timeline.length).toBeGreaterThan(0);
  });

  it("re-running a scenario replaces its previous data", async () => {
    await runScenario("happy", { db, day: DAY });
    await runScenario("happy", { db, day: DAY });
    const rows = await db.select().from(writes).where(eq(writes.subdomain, "sim-happy"));
    expect(rows).toHaveLength(1);
  });

  it("never stores patient names, only initials", async () => {
    await runScenario("sync-down-business-hours", { db, day: DAY });
    const stored = JSON.stringify(await db.select().from(events).where(eq(events.subdomain, "sim-sync-down-business-hours")));
    expect(stored).not.toMatch(/Finley|Fixture|Testcase/);
    const [write] = await db.select().from(writes).where(eq(writes.subdomain, "sim-sync-down-business-hours"));
    expect(write!.patientInitials).toBe("F.F.");
  });

  it("alert text never contains patient names", async () => {
    const all = await db.select().from(alerts);
    for (const a of all) expect(a.message).not.toMatch(/Avery|Blake|Casey|Drew|Emery|Finley/);
  });

  it("picks a Tuesday before today as the default demo day", () => {
    expect(defaultDemoDay(new Date("2026-11-17T12:00:00Z"))).toBe("2026-11-10");
    expect(defaultDemoDay(new Date("2026-11-19T12:00:00Z"))).toBe("2026-11-17");
  });
});
