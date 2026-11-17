import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/db/client";
import { MOCK_API_KEY } from "@/mock/nexhealth-mock";
import { NexHealthClient } from "@/nexhealth/client";
import { loadConfig, type SentinelConfig } from "@/sentinel/config";
import { webhookNotifier, type SentinelContext } from "@/sentinel/context";
import { getMockWorld, MOCK_SUBDOMAIN } from "./mock-world";

export async function getSentinel(): Promise<SentinelContext> {
  const config = loadConfig();
  const db = await getDb();
  const nex =
    config.mode === "mock"
      ? new NexHealthClient({ apiKey: MOCK_API_KEY, baseUrl: "https://nexhealth.mock", fetch: getMockWorld().fetch })
      : new NexHealthClient({
          apiKey: config.apiKey ?? "",
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          onWarning: (message) => console.warn(`[nexhealth] ${message}`),
        });
  return {
    db,
    nex,
    config,
    now: () => new Date(),
    notify: webhookNotifier(config.alertWebhookUrl),
    // Simulator runs live in the same database under sim-* subdomains; keep mock-mode timers off them.
    ...(config.mode === "mock" ? { scope: MOCK_SUBDOMAIN } : {}),
  };
}

/**
 * Bearer CRON_SECRET check for the tick and write endpoints. Without a secret, mock mode is
 * open (local demo) and live mode refuses.
 */
export function authorize(req: Request, config: SentinelConfig): Response | null {
  if (!config.cronSecret) {
    return config.mode === "mock" ? null : Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  }
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${config.cronSecret}`);
  if (given.length === expected.length && timingSafeEqual(given, expected)) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
