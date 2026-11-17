/**
 * Creates test data in a NexHealth sandbox so a real signed webhook arrives, then books an
 * appointment through the running app's tracked-write API.
 *
 *   pnpm demo:live --yes
 *
 * Needs NEXHEALTH_API_KEY, NEXHEALTH_SUBDOMAIN, and the app running in live mode (APP_URL,
 * default http://localhost:3000; CRON_SECRET if set). Run setup:webhooks first.
 * Only use this against a sandbox: it creates a patient and an appointment.
 */
import { NexHealthClient } from "../src/nexhealth/client";
import { loadEnv, requireEnv } from "./lib/env";

loadEnv();
if (!process.argv.includes("--yes")) {
  console.log("This creates a synthetic patient and an appointment in your NexHealth institution. Sandbox only.\nRe-run with --yes to continue.");
  process.exit(1);
}
const apiKey = requireEnv("NEXHEALTH_API_KEY", "Set your sandbox API key.");
const subdomain = requireEnv("NEXHEALTH_SUBDOMAIN", "Set the sandbox subdomain.");
const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

const nex = new NexHealthClient({
  apiKey,
  ...(process.env.NEXHEALTH_BASE_URL ? { baseUrl: process.env.NEXHEALTH_BASE_URL } : {}),
});

const [institution] = await nex.getLocations(subdomain);
const location = institution?.locations[0];
if (!location) throw new Error(`no location found for ${subdomain}`);
const locationId = Number(process.env.NEXHEALTH_LOCATION_ID ?? location.id);
const providers = await nex.request<Array<{ id: number }>>("GET", "/providers", {
  query: { subdomain, location_id: locationId, per_page: 1 },
});
const providerId = providers.data[0]?.id;
if (!providerId) throw new Error("no provider found at this location");

const stamp = Date.now();
const patient = await nex.request<{ user: { id: number } }>("POST", "/patients", {
  query: { subdomain, location_id: locationId },
  body: {
    provider: { provider_id: providerId },
    patient: {
      first_name: "Sentinel",
      last_name: `Testpatient${String(stamp).slice(-5)}`,
      email: `sentinel-test-${stamp}@example.com`,
      bio: { date_of_birth: "1990-01-01", phone_number: "5555550100" },
    },
  },
});
const patientId = patient.data.user.id;
console.log(`Created synthetic patient #${patientId}. The sandbox should now send patient_created to your endpoint.`);

const start = new Date(Date.now() + 2 * 86_400_000);
start.setUTCHours(15, 0, 0, 0);
const res = await fetch(`${appUrl}/api/writes/appointments`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {}),
  },
  body: JSON.stringify({
    clientKey: `demo-live-${stamp}`,
    subdomain,
    locationId,
    patientName: "Sentinel Testpatient",
    appointment: {
      patient_id: patientId,
      provider_id: providerId,
      start_time: start.toISOString(),
      end_time: new Date(start.getTime() + 30 * 60_000).toISOString(),
    },
  }),
});
const body = (await res.json()) as { write?: { id: number; status: string; preflight: string; statusDetail: string }; error?: string };
if (!res.ok || !body.write) {
  console.error(`Booking through ${appUrl} failed: HTTP ${res.status} ${body.error ?? ""}`);
  process.exit(1);
}
console.log(`Tracked write #${body.write.id}: ${body.write.status} (preflight: ${body.write.preflight})`);
console.log(`  ${body.write.statusDetail}`);
console.log(`\nOpen ${appUrl}/?subdomain=${subdomain}. If CAPTURE_WEBHOOKS_DIR is set, the signed delivery is saved there.`);
