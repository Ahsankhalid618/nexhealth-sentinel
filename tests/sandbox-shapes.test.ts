import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "vitest";
import { MOCK_API_KEY, MockNexHealth } from "@/mock/nexhealth-mock";
import { assertShapeCovers } from "./shape";

const FIXTURES = join(process.cwd(), "fixtures/sandbox");

type Capture = {
  request: { method: string; path: string; query?: Record<string, unknown> };
  response: Record<string, unknown>;
};

function load(name: string): Capture {
  const raw = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as {
    request: Capture["request"];
    response: Capture["response"];
  };
  return { request: raw.request, response: raw.response };
}

function q(params: Record<string, unknown>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) u.append(k, String(item));
    else u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

describe("mock response shapes vs NexHealth sandbox captures", () => {
  let mock: MockNexHealth;

  beforeEach(() => {
    mock = new MockNexHealth(() => new Date("2026-11-17T20:00:00Z"));
    mock.seedSandboxPractice();
  });

  async function authedJson(method: string, path: string, query: Record<string, unknown> = {}) {
    const auth = await mock.fetch("http://mock/authenticates", {
      method: "POST",
      headers: { authorization: MOCK_API_KEY, "nex-api-version": "v3.0.0" },
    });
    const token = ((await auth.json()) as { data: { token: string } }).data.token;
    const res = await mock.fetch(`http://mock${path}${q(query)}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "nex-api-version": "v3.0.0" },
    });
    return res.json() as Promise<Record<string, unknown>>;
  }

  it("GET /institutions", async () => {
    const cap = load("institutions");
    const body = await authedJson("GET", "/institutions");
    assertShapeCovers(body.data, cap.response.data, "GET /institutions data");
  });

  it("GET /locations", async () => {
    const cap = load("locations");
    const body = await authedJson("GET", "/locations", cap.request.query ?? {});
    assertShapeCovers(body.data, cap.response.data, "GET /locations data");
  });

  it("GET /appointments (list)", async () => {
    const cap = load("appointments");
    const body = await authedJson("GET", "/appointments", cap.request.query ?? {});
    const refRows = cap.response.data as unknown[];
    assertShapeCovers((body.data as unknown[])[0], refRows[0], "GET /appointments row");
    assertShapeCovers(body.page_info, cap.response.page_info, "GET /appointments page_info");
  });

  it("GET /appointments/{id}", async () => {
    const cap = load("appointment");
    const id = mock.sampleAppointmentId();
    const body = await authedJson("GET", `/appointments/${id}`, cap.request.query ?? {});
    assertShapeCovers(body.data, cap.response.data, "GET /appointments/{id} data");
  });

  it("GET /available_slots", async () => {
    const cap = load("available_slots");
    const body = await authedJson("GET", "/available_slots", cap.request.query ?? {});
    assertShapeCovers(body.data, cap.response.data, "GET /available_slots data");
  });

  it("GET /sync_status (empty sandbox)", async () => {
    const cap = load("sync_status");
    const body = await authedJson("GET", "/sync_status", cap.request.query ?? {});
    assertShapeCovers(body.data, cap.response.data, "GET /sync_status data");
  });

  it("GET /webhook_endpoints", async () => {
    const cap = load("webhook_endpoints");
    const body = await authedJson("GET", "/webhook_endpoints");
    assertShapeCovers(body.data, cap.response.data, "GET /webhook_endpoints data");
  });
});