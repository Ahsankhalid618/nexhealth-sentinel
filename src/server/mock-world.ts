import { MockNexHealth } from "@/mock/nexhealth-mock";

export const MOCK_SUBDOMAIN = "sim-sandbox";

const globalForMock = globalThis as unknown as { sentinelMock?: MockNexHealth };

/**
 * The practice behind `/mock/*` in mock mode, shaped like NexHealth's sandbox: one institution,
 * one location, a few appointments. It lives in memory, so it resets when the server restarts.
 */
export function getMockWorld(): MockNexHealth {
  if (!globalForMock.sentinelMock) {
    const mock = new MockNexHealth(() => new Date());
    mock.addInstitution(4321, "Sandbox Dental (mock)", MOCK_SUBDOMAIN);
    mock.addLocation(MOCK_SUBDOMAIN, { id: 101, name: "Sandbox Dental - Main", tz: "America/New_York" });
    mock.addSync(MOCK_SUBDOMAIN, "Sandbox-Server-01", [101]);
    const day = 24 * 60 * 60_000;
    for (let i = 1; i <= 5; i++) {
      mock.seedAppointment(MOCK_SUBDOMAIN, {
        location_id: 101,
        start_time: new Date(Date.now() + i * day).toISOString(),
      });
    }
    mock.transport = async ({ url, headers, body }) => {
      try {
        const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
        return res.status;
      } catch {
        return 0;
      }
    };
    globalForMock.sentinelMock = mock;
  }
  return globalForMock.sentinelMock;
}
