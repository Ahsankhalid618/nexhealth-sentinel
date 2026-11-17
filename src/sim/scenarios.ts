import { asc, eq } from "drizzle-orm";
import { computeSignature } from "@/core/signature";
import type { Db } from "@/db/client";
import { alerts, events, reconcileCursors, rejectedDeliveries, syncHealth, writes } from "@/db/schema";
import { MOCK_WEBHOOK_SECRET } from "@/sentinel/config";
import { receiveWebhook } from "@/sentinel/inbox";
import { safeRetry } from "@/sentinel/writes";
import { DEMO_SYNC, DemoWorld } from "./world";

export interface Check {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface ScenarioResult {
  scenario: ScenarioName;
  title: string;
  subdomain: string;
  timeline: Array<{ at: string; text: string }>;
  checks: Check[];
  ok: boolean;
}

export interface ScenarioOptions {
  db: Db;
  /** A Tuesday (YYYY-MM-DD). Defaults to the most recent Tuesday before today. */
  day?: string;
}

export const SCENARIOS = {
  happy: {
    title: "Happy path",
    blurb: "A booking is accepted, written to the EHR, confirmed by webhook. Replaying the same request sends nothing.",
  },
  "duplicate-retry": {
    title: "Duplicate delivery",
    blurb: "Our 200 gets lost twice, so NexHealth retries the same event. It is stored and applied once.",
  },
  "failed-write": {
    title: "Failed write",
    blurb: "The EHR rejects a booking. NexHealth won't retry or say why; safe-retry reads it back, then resends.",
  },
  "timed-out": {
    title: "Write timed out",
    blurb: "The sync doesn't get to a booking before its start time. Resent for a later slot.",
  },
  "office-closed": {
    title: "Sync down overnight",
    blurb: "The office server goes offline after close. Expected downtime: nobody gets paged.",
  },
  "sync-down-business-hours": {
    title: "Sync down in office hours",
    blurb: "The office server drops mid-morning. Bookings wait, the outage and stuck write alert, then recover.",
  },
  "paused-endpoint-gap": {
    title: "Paused endpoint gap",
    blurb: "Our endpoint fails, NexHealth pauses it and skips events for an hour. The reconciler gets them back.",
  },
  forged: {
    title: "Forged and stale webhooks",
    blurb: "A wrong signature, a replayed old delivery and a re-serialized body are all rejected.",
  },
} as const;

export type ScenarioName = keyof typeof SCENARIOS;
export const SCENARIO_NAMES = Object.keys(SCENARIOS) as ScenarioName[];

export function isScenario(name: string): name is ScenarioName {
  return name in SCENARIOS;
}

export function defaultDemoDay(today = new Date()): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  do d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() !== 2);
  return d.toISOString().slice(0, 10);
}

const check = (label: string, ok: boolean, detail?: string): Check => ({ label, ok, ...(detail ? { detail } : {}) });

async function writesOf(w: DemoWorld) {
  return w.ctx.db.select().from(writes).where(eq(writes.subdomain, w.subdomain)).orderBy(asc(writes.id));
}
async function eventsOf(w: DemoWorld) {
  return w.ctx.db.select().from(events).where(eq(events.subdomain, w.subdomain)).orderBy(asc(events.id));
}
async function alertsOf(w: DemoWorld) {
  return w.ctx.db.select().from(alerts).where(eq(alerts.subdomain, w.subdomain)).orderBy(asc(alerts.id));
}
async function locationOf(w: DemoWorld) {
  const [row] = await w.ctx.db.select().from(syncHealth).where(eq(syncHealth.subdomain, w.subdomain));
  return row!;
}
const paged = (rows: Array<{ severity: string }>) => rows.filter((a) => a.severity !== "info");

type Runner = (o: Required<ScenarioOptions>) => Promise<{ world: DemoWorld; checks: Check[] }>;

const RUNNERS: Record<ScenarioName, Runner> = {
  async happy({ db, day }) {
    const w = await DemoWorld.create({ db, scenario: "happy", timezone: "America/New_York", day, start: "09:00" });
    const booked = await w.book(w.at("14:00"), "Avery Testcase", "demo-happy-1");
    w.log(`Booked 2:00 PM for A.T. NexHealth answered 201: accepted, not yet written (write #${booked.write.id} ${booked.write.status}).`);
    await w.advanceTo(w.at("09:07"));
    w.mock.syncPendingWrites(w.subdomain);
    await w.deliver();
    const [write] = await writesOf(w);
    w.log(`The office sync wrote it. appointment_insertion.complete arrived; write is ${write!.status}, foreign_id ${write!.foreignId}.`);

    const replay = await w.book(w.at("14:00"), "Avery Testcase", "demo-happy-1");
    w.log(`Same request sent again with the same client key: ${replay.replayed ? "returned the existing write, nothing sent" : "sent again"}.`);
    await w.advanceTo(w.at("09:30"));

    return {
      world: w,
      checks: [
        check("write reached the EHR (complete, foreign_id set)", write!.status === "complete" && write!.foreignId !== null),
        check("replay with the same client key sent nothing", replay.replayed && w.mock.appointments.size === 1),
        check("one webhook stored", (await eventsOf(w)).length === 1),
        check("no alerts", (await alertsOf(w)).length === 0),
      ],
    };
  },

  async "duplicate-retry"({ db, day }) {
    const w = await DemoWorld.create({ db, scenario: "duplicate-retry", timezone: "America/New_York", day, start: "09:00" });
    await w.book(w.at("13:00"), "Blake Placeholder");
    w.log("Booked 1:00 PM for B.P.; accepted.");
    await w.advanceTo(w.at("09:05"));
    w.loseResponses = 2;
    w.mock.syncPendingWrites(w.subdomain);
    w.log("Sync wrote it. Our 200 is lost on the way back twice (think a load balancer timeout).");
    await w.advanceTo(w.at("09:10"));
    const stored = await eventsOf(w);
    const delivery = w.mock.deliveries.at(-1)!;
    w.log(`NexHealth tried ${delivery.attempts} times (now, +30s, +2m). Stored ${stored.length} event, ${stored[0]?.duplicateCount ?? 0} duplicates ignored.`);
    const [write] = await writesOf(w);

    return {
      world: w,
      checks: [
        check("NexHealth delivered the event 3 times", delivery.attempts === 3),
        check("stored once, 2 duplicates counted", stored.length === 1 && stored[0]!.duplicateCount === 2),
        check("retries carried delivery_errors, which dedupe ignores", delivery.errors.length === 2 && stored[0]!.priorFailedAttempts === 0),
        check("write applied once and complete", write!.status === "complete"),
      ],
    };
  },

  async "failed-write"({ db, day }) {
    const w = await DemoWorld.create({ db, scenario: "failed-write", timezone: "America/Denver", day, start: "09:00" });
    const { write: first } = await w.book(w.at("15:00"), "Casey Sample");
    w.log(`Booked 3:00 PM for C.S. (write #${first.id}); accepted.`);
    await w.advanceTo(w.at("09:20"));
    w.mock.failPendingWrite(first.nexAppointmentId!);
    await w.deliver();
    w.log("appointment_insertion.failed arrived. The payload says nothing about why, and NexHealth will not retry.");

    const retry = await safeRetry(w.ctx, first.id);
    if (retry.outcome !== "resent") throw new Error(`expected a resend, got ${retry.outcome}`);
    w.log(`safe-retry read appointment ${first.nexAppointmentId} back first: foreign_id still null, so it resent as write #${retry.write.id}.`);
    const again = await safeRetry(w.ctx, first.id);
    w.log(`A second safe-retry on #${first.id} was refused: ${again.outcome === "not_retryable" ? again.reason : again.outcome}.`);

    await w.advanceTo(w.at("09:25"));
    w.mock.syncPendingWrites(w.subdomain);
    await w.deliver();
    const [orig, resent] = await writesOf(w);
    w.log(`The resend reached the EHR: write #${resent!.id} ${resent!.status}.`);
    const alertRows = await alertsOf(w);

    return {
      world: w,
      checks: [
        check("original marked failed and linked to its retry", orig!.status === "failed" && orig!.retriedById === resent!.id),
        check("retry complete", resent!.status === "complete" && resent!.retryOfId === orig!.id),
        check("second retry refused (no double booking)", again.outcome === "not_retryable" && w.mock.appointments.size === 2),
        check("one failed-write alert", alertRows.filter((a) => a.kind === "write_failed").length === 1),
      ],
    };
  },

  async "timed-out"({ db, day }) {
    const w = await DemoWorld.create({ db, scenario: "timed-out", timezone: "America/New_York", day, start: "09:00" });
    const { write } = await w.book(w.at("09:20"), "Drew Example");
    w.log(`Same-day booking for 9:20 AM for D.E. (write #${write.id}); accepted.`);
    await w.advanceTo(w.at("09:20"));
    w.mock.timeOutPendingWrites(w.subdomain);
    await w.deliver();
    w.log("The sync did not get to it before 9:20. appointment_insertion.timed_out arrived.");

    const retry = await safeRetry(w.ctx, write.id, {
      start_time: w.at("10:00").toISOString(),
      end_time: w.at("10:30").toISOString(),
    });
    if (retry.outcome !== "resent") throw new Error(`expected a resend, got ${retry.outcome}`);
    w.log(`Read back (foreign_id null), then resent for 10:00 AM as write #${retry.write.id}.`);
    await w.advanceTo(w.at("09:24"));
    w.mock.syncPendingWrites(w.subdomain);
    await w.deliver();
    const [orig, resent] = await writesOf(w);
    w.log(`Write #${resent!.id} is ${resent!.status}.`);

    return {
      world: w,
      checks: [
        check("original timed_out", orig!.status === "timed_out"),
        check("resent for the new time and complete", resent!.status === "complete" && resent!.startTime?.getTime() === w.at("10:00").getTime()),
        check("timed-out alert raised", (await alertsOf(w)).some((a) => a.kind === "write_timed_out")),
      ],
    };
  },

  async "office-closed"({ db, day }) {
    const w = await DemoWorld.create({ db, scenario: "office-closed", timezone: "America/Los_Angeles", day, start: "19:20" });
    w.log("Office closed at 6:00 PM.");
    await w.advanceTo(w.at("19:30"));
    w.mock.setSyncStatus(w.subdomain, DEMO_SYNC, { read: "red", write: "red" });
    await w.deliver();
    w.log(`Server switched off for the night: read and write status red. State: ${(await locationOf(w)).state}.`);
    await w.advanceTo(w.at("19:40"));
    const { write } = await w.book(w.at("09:00", 1), "Emery Mock");
    w.log(`Online booking for tomorrow 9:00 AM for E.M. Preflight: ${write.preflight}. ${write.statusDetail}`);

    await w.advanceTo(w.at("07:30", 1), 60);
    const overnight = await alertsOf(w);
    w.log(`Overnight: ${paged(overnight).length} paging alerts, ${overnight.length - paged(overnight).length} dashboard-only notes.`);
    w.mock.setSyncStatus(w.subdomain, DEMO_SYNC, { read: "green", write: "green" });
    await w.deliver();
    await w.advanceTo(w.at("07:35", 1));
    w.mock.syncPendingWrites(w.subdomain);
    await w.deliver();
    await w.advanceTo(w.at("08:10", 1));
    const [after] = await writesOf(w);
    const loc = await locationOf(w);
    w.log(`Server back at 7:30 AM, before opening. Booking ${after!.status}; state ${loc.state}.`);

    return {
      world: w,
      checks: [
        check("nobody paged overnight", paged(overnight).length === 0),
        check("the waiting booking was flagged on the dashboard (info)", overnight.some((a) => a.kind === "write_stuck" && a.severity === "info")),
        check("booking landed in the morning", after!.status === "complete"),
        check("healthy at opening", loc.state === "healthy"),
      ],
    };
  },

  async "sync-down-business-hours"({ db, day }) {
    const w = await DemoWorld.create({ db, scenario: "sync-down-business-hours", timezone: "America/Chicago", day, start: "10:00" });
    await w.advanceTo(w.at("10:12"));
    w.mock.setSyncStatus(w.subdomain, DEMO_SYNC, { read: "red", write: "red" });
    await w.deliver();
    w.log(`Office server lost its connection. State: ${(await locationOf(w)).state}.`);
    await w.advanceTo(w.at("10:15"));
    const { write } = await w.book(w.at("15:00"), "Finley Fixture");
    w.log(`Booked 3:00 PM for F.F.: preflight ${write.preflight}. "${write.statusDetail}"`);

    await w.advanceTo(w.at("10:50"));
    const during = await alertsOf(w);
    const [stuck] = await writesOf(w);
    for (const a of during) w.log(`Alert (${a.severity}): ${a.message}`);

    await w.advanceTo(w.at("11:05"));
    w.mock.setSyncStatus(w.subdomain, DEMO_SYNC, { read: "green", write: "green" });
    await w.deliver();
    w.log("Server reconnected.");
    await w.advanceTo(w.at("11:06"));
    w.mock.syncPendingWrites(w.subdomain);
    await w.deliver();
    await w.advanceTo(w.at("11:10"));
    const [done] = await writesOf(w);
    const after = await alertsOf(w);
    w.log(`Booking ${done!.status}. Alerts resolved: ${after.filter((a) => a.resolvedAt).length}/${after.length}.`);

    return {
      world: w,
      checks: [
        check("preflight warned the booking would wait", write.preflight === "will_wait"),
        check("sync outage alert raised (critical)", during.some((a) => a.kind === "sync_down" && a.severity === "critical")),
        check("write marked stuck with a critical alert", stuck!.status === "stuck" && during.some((a) => a.kind === "write_stuck" && a.severity === "critical")),
        check("booking completed after recovery", done!.status === "complete"),
        check("alerts resolved", after.every((a) => a.resolvedAt !== null)),
      ],
    };
  },

  async "paused-endpoint-gap"({ db, day }) {
    const seeded: Array<{ id: number }> = [];
    const w = await DemoWorld.create({
      db,
      scenario: "paused-endpoint-gap",
      timezone: "America/New_York",
      day,
      start: "08:40",
      beforeStart: (world) => {
        for (let i = 0; i < 20; i++) {
          const hour = String(9 + (i % 8)).padStart(2, "0");
          seeded.push(
            world.mock.seedAppointment(world.subdomain, {
              location_id: world.locationId,
              start_time: world.at(`${hour}:${i % 2 ? "30" : "00"}`, 1 + Math.floor(i / 8)).toISOString(),
            }),
          );
        }
      },
    });
    await w.advanceTo(w.at("09:00"));
    const [baseline] = await w.ctx.db.select().from(reconcileCursors).where(eq(reconcileCursors.subdomain, w.subdomain));
    w.log(`${seeded.length} appointments on the books; the reconciler recorded them as its baseline.`);

    await w.advanceTo(w.at("10:00"));
    w.endpointMode = "down";
    w.log("Our endpoint starts answering 503 (bad deploy).");
    for (const [i, appt] of seeded.slice(0, 11).entries()) {
      await w.advanceTo(w.at(`10:0${Math.floor(i / 3)}`));
      w.mock.changeAppointmentInEhr(appt.id, { operatory_id: 7 + i });
    }
    await w.advanceTo(w.at("10:05"));
    const health = w.mock.health(1);
    w.log("11 front-desk changes. Every delivery failed, and after more than 10 failures in a row NexHealth paused the endpoint for an hour.");

    await w.advanceTo(w.at("10:15"));
    for (let i = 0; i < 4; i++) {
      w.mock.createAppointmentInEhr(w.subdomain, {
        location_id: w.locationId,
        start_time: w.at(`1${i}:00`, 3).toISOString(),
      });
    }
    await w.deliver();
    w.log("4 new appointments booked at the front desk while paused.");
    await w.advanceTo(w.at("10:20"));
    w.endpointMode = "up";
    w.log("Endpoint fixed.");
    await w.advanceTo(w.at("11:30"));

    const skipped = w.mock.deliveries.filter((d) => d.status === "skipped").length;
    const received = (await eventsOf(w)).length;
    const [cursor] = await w.ctx.db.select().from(reconcileCursors).where(eq(reconcileCursors.subdomain, w.subdomain));
    w.log(`NexHealth skipped ${skipped} deliveries and never resent them; we received ${received} webhooks for these changes.`);
    w.log(`The updated_since reconciler recovered ${cursor?.totalRecovered ?? 0} changes on its own.`);

    return {
      world: w,
      checks: [
        check("baseline recorded before the outage", baseline !== undefined && baseline.lastRecovered === 0),
        check("endpoint was paused", health.pauses >= 1),
        check("no webhook ever arrived for the 15 changes", received === 0),
        check("reconciler recovered all 15", cursor?.totalRecovered === 15),
        check("gap alert raised", (await alertsOf(w)).some((a) => a.kind === "gap_recovered")),
      ],
    };
  },

  async forged({ db, day }) {
    const w = await DemoWorld.create({ db, scenario: "forged", timezone: "America/New_York", day, start: "09:00" });
    const body = JSON.stringify({
      institution_id: 1,
      subdomain: w.subdomain,
      event_name: "appointment_insertion.complete",
      resource_type: "Appointment",
      data: { appointment: { id: 1, foreign_id: "1", updated_at: w.now().toISOString() } },
    });
    const post = (raw: string, timestamp: string, signature: string) =>
      receiveWebhook(w.ctx, { rawBody: Buffer.from(raw), timestamp, signature });
    const now = w.now().toISOString();

    const wrongKey = await post(body, now, computeSignature(body, now, "someone-elses-secret"));
    w.log(`Signed with the wrong secret: ${wrongKey.status} ${wrongKey.outcome === "rejected" ? wrongKey.reason : ""}.`);
    const old = new Date(w.now().getTime() - 10 * 60_000).toISOString();
    const replayed = await post(body, old, computeSignature(body, old, MOCK_WEBHOOK_SECRET));
    w.log(`Valid signature, but the timestamp is 10 minutes old (a replay): ${replayed.status} ${replayed.outcome === "rejected" ? replayed.reason : ""}.`);
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    const reserialized = await post(pretty, now, computeSignature(body, now, MOCK_WEBHOOK_SECRET));
    w.log(`Body parsed and re-serialized before verifying (the mistake the docs' Python example invites): ${reserialized.status} ${reserialized.outcome === "rejected" ? reserialized.reason : ""}.`);

    const rejected = await w.ctx.db.select().from(rejectedDeliveries).where(eq(rejectedDeliveries.claimedSubdomain, w.subdomain));
    return {
      world: w,
      checks: [
        check("all three answered 401", [wrongKey, replayed, reserialized].every((r) => r.status === 401)),
        check("3 rejections logged (metadata only, no body)", rejected.length === 3),
        check("nothing stored or processed", (await eventsOf(w)).length === 0),
      ],
    };
  },
};

export async function runScenario(name: ScenarioName, options: ScenarioOptions): Promise<ScenarioResult> {
  const { world, checks } = await RUNNERS[name]({ db: options.db, day: options.day ?? defaultDemoDay() });
  return {
    scenario: name,
    title: SCENARIOS[name].title,
    subdomain: world.subdomain,
    timeline: world.timeline,
    checks,
    ok: checks.every((c) => c.ok),
  };
}
