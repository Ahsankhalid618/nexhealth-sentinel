import { beforeEach, describe, expect, it } from "vitest";
import { MOCK_API_KEY, MockNexHealth, RETRY_DELAYS_MS, type Transport } from "@/mock/nexhealth-mock";
import { NexHealthClient } from "@/nexhealth/client";
import { verifySignature } from "@/core/signature";

const SECRET = "test-secret";
let clock: Date;
let mock: MockNexHealth;
let received: Array<{ at: string; body: string; headers: Record<string, string> }>;
let respond: () => number;

async function advanceTo(target: Date) {
  for (;;) {
    const next = mock.nextDeliveryAt();
    if (next === null || next > target.getTime()) break;
    clock = new Date(Math.max(next, clock.getTime()));
    await mock.runDueDeliveries();
  }
  clock = target;
}

const minutes = (n: number) => new Date(clock.getTime() + n * 60_000);

beforeEach(() => {
  clock = new Date("2026-11-17T15:00:00Z");
  mock = new MockNexHealth(() => clock);
  mock.addInstitution(1, "Demo", "demo");
  mock.addLocation("demo", { id: 10, name: "Main", tz: "America/New_York" });
  mock.addSync("demo", "Main server", [10]);
  received = [];
  respond = () => 200;
  const transport: Transport = async (req) => {
    received.push({ at: clock.toISOString(), body: req.body, headers: req.headers });
    return respond();
  };
  mock.transport = transport;
  const endpoint = mock.registerEndpoint("https://app.test/api/webhooks/nexhealth", SECRET);
  mock.subscribe(endpoint.id, "demo", "Appointment", "appointment_updated");
  mock.subscribe(endpoint.id, "demo", "SyncStatus", "sync_status_write_change");
});

function changeOne() {
  const appt = mock.seedAppointment("demo", { location_id: 10, start_time: "2026-11-20T15:00:00Z" });
  mock.changeAppointmentInEhr(appt.id, { confirmed: true } as never);
}

describe("mock webhook delivery", () => {
  it("signs each delivery with the documented algorithm and only for subscribed events", async () => {
    changeOne();
    mock.setSyncStatus("demo", "Main server", { write: "red", read: "red" });
    await advanceTo(minutes(1));
    expect(received.map((r) => JSON.parse(r.body).event_name)).toEqual([
      "appointment_updated",
      "sync_status_write_change.red",
    ]);
    for (const r of received) {
      expect(verifySignature(r.body, r.headers.timestamp, r.headers.signature, SECRET, { now: clock }).ok).toBe(true);
    }
  });

  it("retries on the documented schedule, adding delivery_errors each time, then marks it failed", async () => {
    respond = () => 500;
    changeOne();
    await advanceTo(minutes(12 * 60));
    expect(received).toHaveLength(1 + RETRY_DELAYS_MS.length);
    const offsets = received.map((r) => (Date.parse(r.at) - Date.parse(received[0]!.at)) / 1000);
    expect(offsets).toEqual([0, 30, 150, 450, 1350, 4950, 15750, 40950]);
    expect(JSON.parse(received[0]!.body).delivery_errors).toBeUndefined();
    expect(JSON.parse(received[3]!.body).delivery_errors).toHaveLength(3);
    expect(mock.deliveries[0]!.status).toBe("failed");
  });

  it("pauses after more than 10 failures in a row and skips what falls due in that hour", async () => {
    respond = () => 503;
    for (let i = 0; i < 11; i++) changeOne();
    await advanceTo(minutes(0));
    expect(mock.health(1).pausedUntil).toBe(clock.getTime() + 60 * 60_000);

    respond = () => 200;
    clock = minutes(10);
    for (let i = 0; i < 4; i++) changeOne();
    await advanceTo(minutes(70));

    const statuses = mock.deliveries.map((d) => d.status);
    expect(statuses.filter((s) => s === "skipped")).toHaveLength(15);
    expect(received).toHaveLength(11);
  });

  it("deactivates the endpoint after 100 failed deliveries, and its subscriptions stay inactive", async () => {
    respond = () => 500;
    for (let i = 0; i < 100; i++) {
      changeOne();
      for (const d of mock.deliveries.filter((x) => x.status === "pending")) {
        d.attempts = RETRY_DELAYS_MS.length;
      }
      mock.health(1).pausedUntil = null;
      await mock.runDueDeliveries();
    }
    expect(mock.endpoints[0]!.active).toBe(false);
    expect(mock.subscriptions.every((s) => !s.active)).toBe(true);

    const client = new NexHealthClient({ apiKey: MOCK_API_KEY, baseUrl: "http://mock.local", fetch: mock.fetch, now: () => clock });
    await client.request("PATCH", "/webhook_endpoints/1", { body: { active: true } });
    expect(mock.endpoints[0]!.active).toBe(true);
    const subs = await client.listSubscriptions(1, "demo");
    expect(subs.map((s) => s.active)).toEqual([false, false]);
  });

  it("resets the failure count after a success", async () => {
    let calls = 0;
    respond = () => (++calls % 5 === 0 ? 200 : 500);
    for (let i = 0; i < 20; i++) changeOne();
    await advanceTo(minutes(0));
    expect(mock.health(1).pauses).toBe(0);
  });
});
