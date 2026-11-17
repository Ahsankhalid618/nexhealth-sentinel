import { beforeEach, describe, expect, it } from "vitest";
import { NexHealthClient, NexHealthError } from "@/nexhealth/client";
import { MOCK_API_KEY, MockNexHealth } from "@/mock/nexhealth-mock";

const BASE = "http://mock.local";
let clock: Date;
let mock: MockNexHealth;
let sleeps: number[];
let warnings: string[];
let client: NexHealthClient;

beforeEach(() => {
  clock = new Date("2026-11-17T15:00:00Z");
  mock = new MockNexHealth(() => clock);
  mock.addInstitution(1, "Demo Practice", "demo");
  mock.addLocation("demo", { id: 10, name: "Main", tz: "America/New_York" });
  mock.addSync("demo", "Main server", [10]);
  sleeps = [];
  warnings = [];
  client = new NexHealthClient({
    apiKey: MOCK_API_KEY,
    baseUrl: BASE,
    fetch: mock.fetch,
    now: () => clock,
    sleep: async (ms) => void sleeps.push(ms),
    onWarning: (w) => warnings.push(w),
  });
});

describe("NexHealthClient against the mock", () => {
  it("returns 404 without the Nex-Api-Version header, as the docs describe", async () => {
    const res = await mock.fetch(`${BASE}/institutions`);
    expect(res.status).toBe(404);
  });

  it("authenticates with the raw key, then uses a bearer token", async () => {
    const institutions = await client.getInstitutions();
    expect(institutions[0]?.subdomain).toBe("demo");
  });

  it("rejects a wrong API key", async () => {
    const bad = new NexHealthClient({ apiKey: "nope", baseUrl: BASE, fetch: mock.fetch });
    await expect(bad.getInstitutions()).rejects.toMatchObject({ status: 401 });
  });

  it("refreshes the token before its 1h expiry", async () => {
    await client.getInstitutions();
    clock = new Date(clock.getTime() + 56 * 60_000);
    await expect(client.getInstitutions()).resolves.toHaveLength(1);
  });

  it("re-authenticates once on a 401", async () => {
    await client.getInstitutions();
    mock.revokeTokens();
    await expect(client.getInstitutions()).resolves.toHaveLength(1);
  });

  it("waits Retry-After seconds on a 429 and retries", async () => {
    mock.rateLimitNext = 2;
    await expect(client.getSyncStatus("demo")).resolves.toHaveLength(1);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("gives up after the configured number of 429 retries", async () => {
    mock.rateLimitNext = 10;
    await expect(client.getSyncStatus("demo")).rejects.toMatchObject({ status: 429 });
  });

  it("surfaces the 'parameters are ignored' note as a warning", async () => {
    await client.request("GET", "/institutions", { query: { location_id: 10 } });
    expect(warnings).toEqual(["GET /institutions: Note that following parameters are ignored: location_id."]);
  });

  it("books an appointment that is accepted but not yet written", async () => {
    const appt = await client.createAppointment("demo", 10, {
      patient_id: 1,
      provider_id: 2,
      start_time: "2026-11-18T15:00:00Z",
    });
    expect(appt).toMatchObject({ foreign_id: null, last_sync_time: null, location_id: 10 });
    const readBack = await client.getAppointment("demo", appt.id);
    expect(readBack.foreign_id).toBeNull();
    mock.syncPendingWrites("demo");
    expect((await client.getAppointment("demo", appt.id)).foreign_id).not.toBeNull();
  });

  it("reports a 400 as a rejection with NexHealth's error message", async () => {
    const err = await client
      .createAppointment("demo", 10, { patient_id: 1, provider_id: 2 } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NexHealthError);
    expect((err as NexHealthError).isRejection).toBe(true);
    expect((err as NexHealthError).errors[0]).toMatch(/start_time/);
  });

  it("pages appointments with end_cursor until has_next_page is false", async () => {
    for (let i = 0; i < 7; i++) {
      mock.seedAppointment("demo", { location_id: 10, start_time: "2026-11-20T15:00:00Z" });
    }
    const seen: number[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await client.listAppointments({
        subdomain: "demo",
        location_id: 10,
        start: "2026-11-01T00:00:00Z",
        end: "2026-12-01T00:00:00Z",
        per_page: 3,
        end_cursor: cursor,
      });
      seen.push(...page.data.map((a) => a.id));
      if (!page.pageInfo?.has_next_page) break;
      cursor = page.pageInfo.end_cursor ?? undefined;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("requires start and end on GET /appointments, and refuses both cursors", async () => {
    await expect(
      client.request("GET", "/appointments", { query: { subdomain: "demo", location_id: 10 } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.request("GET", "/appointments", {
        query: { subdomain: "demo", location_id: 10, start: "2026-01-01", end: "2027-01-01", start_cursor: "a", end_cursor: "b" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("has no /sync_status entry for a location without a sync", async () => {
    mock.addLocation("demo", { id: 11, name: "Annex", tz: "America/New_York" });
    expect(await client.getSyncStatus("demo", [11])).toEqual([]);
    expect(await client.getSyncStatus("demo", [10])).toHaveLength(1);
  });

  it("enforces the documented webhook subscription rules", async () => {
    const endpoint = await client.createWebhookEndpoint("https://example.test/hooks");
    expect(endpoint.secret_key).toBeTruthy();
    await expect(
      client.request("POST", `/webhook_endpoints/${endpoint.id}/webhook_subscriptions`, {
        body: { subdomain: "demo", resource_type: "Appointment", event: "appointment_insertion" },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(client.createSubscription(endpoint.id, "demo", "appointment", "appointment_insertion")).rejects.toThrow(
      /Invalid value for parameter resource_type/,
    );
    const sub = await client.createSubscription(endpoint.id, "demo", "Appointment", "appointment_insertion");
    expect(sub.active).toBe(true);
    expect(await client.listSubscriptions(endpoint.id, "demo")).toHaveLength(1);
  });

  it("wraps network failures as status 0", async () => {
    const offline = new NexHealthClient({
      apiKey: "k",
      baseUrl: BASE,
      fetch: async () => {
        throw new Error("ECONNRESET");
      },
    });
    await expect(offline.getInstitutions()).rejects.toMatchObject({ status: 0 });
  });
});
