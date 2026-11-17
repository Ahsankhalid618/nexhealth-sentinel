import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { computeSignature } from "@/core/signature";
import { openDb, type Db } from "@/db/client";
import { alerts, events, rejectedDeliveries, syncHealth, writes } from "@/db/schema";
import { MOCK_API_KEY, MockNexHealth } from "@/mock/nexhealth-mock";
import { NexHealthClient } from "@/nexhealth/client";
import { loadConfig, MOCK_WEBHOOK_SECRET, type SentinelConfig } from "@/sentinel/config";
import type { NewAlert, SentinelContext } from "@/sentinel/context";
import { receiveWebhook } from "@/sentinel/inbox";
import { processPendingEvents } from "@/sentinel/process";
import { discoverLocations, evaluateSyncHealth, pollSyncStatus } from "@/sentinel/sync-monitor";
import { runTick } from "@/sentinel/tick";
import { checkWebhookEndpoints } from "@/sentinel/watchdog";
import { createTrackedAppointment, safeRetry } from "@/sentinel/writes";
import { authorize } from "@/server/sentinel";
import { loadDocFixture } from "./fixtures";

const SUB = "green-valley";
// Tuesday 2026-11-10, 10:00 in New York
let clock = new Date("2026-11-10T15:00:00Z");
let db: Db;
let mock: MockNexHealth;
let ctx: SentinelContext;
let notified: NewAlert[];

async function setUp(config: Partial<SentinelConfig> = {}) {
  clock = new Date("2026-11-10T15:00:00Z");
  db = (await openDb("memory://")).db;
  mock = new MockNexHealth(() => clock);
  mock.addInstitution(1, "Green Valley Dental", SUB);
  mock.addLocation(SUB, { id: 101, name: "Main St", tz: "America/New_York" });
  mock.addLocation(SUB, { id: 102, name: "Elm St (no sync)", tz: "America/New_York" });
  mock.addSync(SUB, "GV-1", [101]);
  notified = [];
  ctx = {
    db,
    nex: new NexHealthClient({ apiKey: MOCK_API_KEY, baseUrl: "https://mock", fetch: mock.fetch, now: () => clock, sleep: async () => {} }),
    config: { ...loadConfig({ NEXHEALTH_MODE: "mock" }), ...config },
    now: () => clock,
    notify: async (a) => {
      notified.push(a);
    },
  };
  await discoverLocations(ctx);
}

const booking = (key: string, locationId = 101) => ({
  clientKey: key,
  subdomain: SUB,
  locationId,
  patientName: "Avery Testcase",
  appointment: { patient_id: 11, provider_id: 22, start_time: "2026-11-12T15:00:00.000Z", note: "Allergic to latex" },
});

describe("tracked writes", () => {
  beforeEach(() => setUp());

  it("never stores the free-text note", async () => {
    const { write } = await createTrackedAppointment(ctx, booking("a"));
    expect(write.status).toBe("accepted");
    expect(JSON.stringify(write)).not.toContain("latex");
    expect(write.patientInitials).toBe("A.T.");
  });

  it("marks a 4xx as rejected with NexHealth's error", async () => {
    const { write } = await createTrackedAppointment(ctx, { ...booking("b"), appointment: { ...booking("b").appointment, provider_id: undefined as never } });
    expect(write.status).toBe("rejected");
    expect(write.lastError).toContain("provider_id");
  });

  it("warns that a location without a sync will never reach the EHR", async () => {
    const { write } = await createTrackedAppointment(ctx, booking("c", 102));
    expect(write.preflight).toBe("no_sync");
    expect(write.statusDetail).toMatch(/never reach an EHR/);
  });

  it("refuses to send when PREFLIGHT_MODE=refuse and writes are blocked", async () => {
    await setUp({ preflightMode: "refuse" });
    mock.setSyncStatus(SUB, "GV-1", { write: "red" });
    const { write } = await createTrackedAppointment(ctx, booking("d"));
    expect(write.status).toBe("rejected");
    expect(write.nexAppointmentId).toBeNull();
    expect(mock.appointments.size).toBe(0);
  });

  it("an unanswered POST is searched for before resending", async () => {
    const realFetch = mock.fetch;
    let dropNextPost = true;
    // The POST lands at NexHealth but the response never comes back.
    (ctx as { nex: NexHealthClient }).nex = new NexHealthClient({
      apiKey: MOCK_API_KEY,
      baseUrl: "https://mock",
      now: () => clock,
      sleep: async () => {},
      fetch: async (input, init) => {
        const res = await realFetch(input, init);
        if (init?.method === "POST" && String(input).includes("/appointments") && dropNextPost) {
          dropNextPost = false;
          throw new TypeError("socket hang up");
        }
        return res;
      },
    });
    const { write } = await createTrackedAppointment(ctx, booking("e"));
    expect(write.status).toBe("requested");
    expect(write.lastError).toContain("socket hang up");

    const result = await safeRetry(ctx, write.id);
    expect(result.outcome).toBe("found_original");
    expect(mock.appointments.size).toBe(1);
  });

  it("an unanswered POST that never landed is resent once", async () => {
    (ctx as { nex: NexHealthClient }).nex = new NexHealthClient({
      apiKey: MOCK_API_KEY,
      baseUrl: "https://mock",
      now: () => clock,
      sleep: async () => {},
      fetch: async (input, init) => {
        if (init?.method === "POST" && String(input).includes("/appointments") && mock.appointments.size === 0 && !retrying) {
          throw new TypeError("connect ETIMEDOUT");
        }
        return mock.fetch(input, init);
      },
    });
    let retrying = false;
    const { write } = await createTrackedAppointment(ctx, booking("f"));
    retrying = true;
    const result = await safeRetry(ctx, write.id);
    expect(result.outcome).toBe("resent");
    const [original] = await db.select().from(writes).where(eq(writes.id, write.id));
    expect(original!.status).toBe("rejected");
    expect(original!.retriedById).toBe(result.outcome === "resent" ? result.write.id : -1);
    expect(mock.appointments.size).toBe(1);
  });

  it("does not resend a failed write that the EHR actually has", async () => {
    const { write } = await createTrackedAppointment(ctx, booking("g"));
    mock.failPendingWrite(write.nexAppointmentId!);
    await db.update(writes).set({ status: "failed" }).where(eq(writes.id, write.id));
    // Later the practice writes it after all (or an earlier attempt landed).
    mock.appointments.get(write.nexAppointmentId!)!.foreign_id = "77";
    const result = await safeRetry(ctx, write.id);
    expect(result.outcome).toBe("already_written");
    expect(mock.appointments.size).toBe(1);
  });

  it("refuses to retry a write that is still pending", async () => {
    const { write } = await createTrackedAppointment(ctx, booking("h"));
    const result = await safeRetry(ctx, write.id);
    expect(result).toMatchObject({ outcome: "not_retryable" });
    expect(await safeRetry(ctx, 9999)).toEqual({ outcome: "not_found" });
  });
});

describe("sync monitoring", () => {
  beforeEach(() => setUp());

  it("flags locations with no sync as info, without paging", async () => {
    await pollSyncStatus(ctx);
    await evaluateSyncHealth(ctx);
    const rows = await db.select().from(syncHealth).where(eq(syncHealth.locationId, 102));
    expect(rows[0]!.state).toBe("no_sync");
    const [alert] = await db.select().from(alerts);
    expect(alert).toMatchObject({ kind: "no_sync", severity: "info" });
    expect(notified.every((a) => a.severity === "info")).toBe(true);
  });

  it("applies a SyncStatus webhook with locations: null to the matching location", async () => {
    await pollSyncStatus(ctx);
    const payload = loadDocFixture("sync_status_write_change");
    const body = JSON.stringify({ ...payload, subdomain: SUB, event_time: clock.toISOString() });
    const [main] = await db.select().from(syncHealth).where(eq(syncHealth.locationId, 101));
    await db.update(syncHealth).set({ syncSourceName: (payload as { data: { syncstatus: { sync_source_name: string } } }).data.syncstatus.sync_source_name }).where(eq(syncHealth.locationId, main!.locationId));
    const ts = clock.toISOString();
    const res = await receiveWebhook(ctx, { rawBody: Buffer.from(body), timestamp: ts, signature: computeSignature(body, ts, MOCK_WEBHOOK_SECRET) });
    expect(res.outcome).toBe("stored");
    await processPendingEvents(ctx);
    const [after] = await db.select().from(syncHealth).where(eq(syncHealth.locationId, 101));
    const [other] = await db.select().from(syncHealth).where(eq(syncHealth.locationId, 102));
    expect(after!.writeStatus).toBe((payload as { data: { syncstatus: { write_status: string } } }).data.syncstatus.write_status);
    expect(other!.writeStatus).toBeNull();
  });
});

describe("webhook inbox", () => {
  beforeEach(() => setUp());

  const signed = (body: string) => {
    const ts = clock.toISOString();
    return { rawBody: Buffer.from(body), timestamp: ts, signature: computeSignature(body, ts, MOCK_WEBHOOK_SECRET) };
  };

  it("rejects signed bodies that are not JSON or not a NexHealth event", async () => {
    expect(await receiveWebhook(ctx, signed("not json"))).toMatchObject({ status: 400, reason: "invalid_json" });
    expect(await receiveWebhook(ctx, signed('{"hello":1}'))).toMatchObject({ status: 400, reason: "invalid_payload" });
    expect(await db.select().from(rejectedDeliveries)).toHaveLength(2);
  });

  it("rejects missing headers and stores no payload", async () => {
    const res = await receiveWebhook(ctx, { rawBody: Buffer.from('{"subdomain":"x"}'), timestamp: null, signature: null });
    expect(res).toMatchObject({ status: 401, reason: "missing_header" });
    const [row] = await db.select().from(rejectedDeliveries);
    expect(row!.claimedSubdomain).toBe("x");
    expect(JSON.stringify(row)).not.toContain('"subdomain"');
  });

  it("stores the doc examples with patient fields redacted", async () => {
    for (const name of ["appointment_created", "patient_created", "appointment_updated"]) {
      const res = await receiveWebhook(ctx, signed(JSON.stringify(loadDocFixture(name))));
      expect(res.outcome).toBe("stored");
    }
    const stored = JSON.stringify(await db.select().from(events));
    expect(stored).toContain("[redacted]");
    expect(stored).not.toMatch(/"(first_name|last_name|email|date_of_birth)":"(?!\[redacted\])/);
  });
});

describe("watchdog", () => {
  beforeEach(() => setUp());

  it("raises a fix-it alert for an inactive endpoint and for inactive subscriptions", async () => {
    const endpoint = mock.registerEndpoint("https://example.test/hook", "s");
    const sub = mock.subscribe(endpoint.id, SUB, "Appointment", "appointment_insertion");
    mock.subscriptions.find((s) => s.id === sub.id)!.active = false;
    let report = await checkWebhookEndpoints(ctx);
    expect(report.inactiveSubscriptions).toEqual([sub.id]);

    endpoint.active = false;
    report = await checkWebhookEndpoints(ctx);
    expect(report.inactiveEndpoints).toEqual([endpoint.id]);
    const rows = await db.select().from(alerts);
    expect(rows.map((a) => a.kind).sort()).toEqual(
      ["endpoint_inactive", "subscription_inactive", "subscription_missing", "subscription_missing"].sort(),
    );
    expect(rows.find((a) => a.kind === "endpoint_inactive")!.message).toContain(`PATCH /webhook_endpoints/${endpoint.id}`);
    expect(rows.find((a) => a.kind === "subscription_inactive")!.message).toContain(`webhook_subscriptions/${sub.id}?subdomain=${SUB}`);
  });

  it("alerts when no endpoint is registered for the configured URL", async () => {
    await setUp({ webhookTargetUrl: "https://sentinel.test/api/webhooks/nexhealth" });
    await checkWebhookEndpoints(ctx);
    const [row] = await db.select().from(alerts);
    expect(row!.kind).toBe("endpoint_missing");
  });
});

describe("tick", () => {
  beforeEach(() => setUp());

  it("keeps going when one step fails", async () => {
    mock.rateLimitNext = 100;
    const report = await runTick(ctx);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors.join(" ")).toMatch(/429/);
  });

  it("leaves simulator institutions alone when unscoped", async () => {
    await db.insert(syncHealth).values({ subdomain: "sim-happy", locationId: 1, timezone: "UTC", updatedAt: clock });
    const report = await runTick(ctx);
    expect(report.errors).toEqual([]);
    expect(report.reconcile?.locations).toBe(2);
  });
});

describe("authorize", () => {
  const config = (mode: "mock" | "live", cronSecret: string | null) => ({ ...loadConfig({ NEXHEALTH_MODE: mode }), cronSecret });
  const req = (auth?: string) => new Request("http://x/api/cron/tick", { headers: auth ? { authorization: auth } : {} });

  it("is open in mock mode without a secret and closed in live mode", () => {
    expect(authorize(req(), config("mock", null))).toBeNull();
    expect(authorize(req(), config("live", null))?.status).toBe(503);
  });

  it("checks the bearer secret", () => {
    expect(authorize(req("Bearer s3cret"), config("live", "s3cret"))).toBeNull();
    expect(authorize(req("Bearer nope"), config("live", "s3cret"))?.status).toBe(401);
    expect(authorize(req(), config("mock", "s3cret"))?.status).toBe(401);
  });
});
