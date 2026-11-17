/**
 * Registers (or reuses) a webhook endpoint for this app and subscribes it to the events the
 * sentinel uses. Saves the endpoint's secret_key to .env.local as NEXHEALTH_WEBHOOK_SECRET
 * without printing it.
 *
 *   NEXHEALTH_API_KEY=... NEXHEALTH_SUBDOMAIN=... WEBHOOK_TARGET_URL=https://<public-host>/api/webhooks/nexhealth \
 *     npx tsx scripts/setup-webhooks.ts
 */
import { NexHealthClient } from "../src/nexhealth/client";
import type { WebhookEndpoint, WebhookSubscription } from "../src/nexhealth/types";
import { loadEnv, requireEnv, setEnvLocal } from "./lib/env";

loadEnv();
const apiKey = requireEnv("NEXHEALTH_API_KEY", "Set your sandbox API key.");
const subdomain = requireEnv("NEXHEALTH_SUBDOMAIN", "Set the institution subdomain (the sandbox smoke test prints it).");
const target = requireEnv("WEBHOOK_TARGET_URL", "Set the public HTTPS URL of /api/webhooks/nexhealth (a Vercel deploy or a tunnel to localhost).");
if (!target.startsWith("https://")) console.warn("Note: the docs say target_url must use HTTPS in production.");

const nex = new NexHealthClient({
  apiKey,
  ...(process.env.NEXHEALTH_BASE_URL ? { baseUrl: process.env.NEXHEALTH_BASE_URL } : {}),
  onWarning: (m) => console.warn(m),
});

// The sandbox only fires Patient events; the rest matter once a practice with a sync is connected.
const WANTED: Array<[string, string]> = [
  ["Patient", "patient_created"],
  ["Patient", "patient_updated"],
  ["Appointment", "appointment_insertion"],
  ["Appointment", "appointment_created"],
  ["Appointment", "appointment_updated"],
  ["SyncStatus", "sync_status_read_change"],
  ["SyncStatus", "sync_status_write_change"],
];

const endpoints = await nex.listWebhookEndpoints();
let endpoint: WebhookEndpoint | undefined = endpoints.find((e) => e.target_url === target);
if (endpoint) {
  console.log(`Reusing webhook endpoint #${endpoint.id}.`);
  if (!endpoint.active) {
    endpoint = (await nex.request<WebhookEndpoint>("PATCH", `/webhook_endpoints/${endpoint.id}`, { body: { active: true } })).data;
    console.log(`Endpoint #${endpoint.id} was inactive; re-activated it.`);
  }
} else {
  endpoint = await nex.createWebhookEndpoint(target);
  console.log(`Created webhook endpoint #${endpoint.id} for ${target}.`);
}

const existing = await nex.listSubscriptions(endpoint.id, subdomain);
for (const [resourceType, event] of WANTED) {
  const sub: WebhookSubscription | undefined = existing.find((s) => s.resource_type === resourceType && s.event === event);
  if (!sub) {
    try {
      const created = await nex.createSubscription(endpoint.id, subdomain, resourceType, event);
      console.log(`  subscribed ${resourceType}/${event} (#${created.id})`);
    } catch (err) {
      console.warn(`  could not subscribe ${resourceType}/${event}: ${err instanceof Error ? err.message : err}`);
    }
  } else if (!sub.active) {
    // Subscriptions stay inactive after their endpoint is re-activated.
    await nex.request("PATCH", `/webhook_endpoints/${endpoint.id}/webhook_subscriptions/${sub.id}`, {
      query: { subdomain },
      body: { active: true },
    });
    console.log(`  re-activated ${resourceType}/${event} (#${sub.id})`);
  } else {
    console.log(`  already subscribed ${resourceType}/${event} (#${sub.id})`);
  }
}

if (endpoint.secret_key) {
  setEnvLocal("NEXHEALTH_WEBHOOK_SECRET", endpoint.secret_key);
  setEnvLocal("WEBHOOK_TARGET_URL", target);
  console.log("\nSaved NEXHEALTH_WEBHOOK_SECRET and WEBHOOK_TARGET_URL to .env.local (not printed). Restart the app to pick them up.");
} else {
  console.warn("\nThe API did not return secret_key; copy it from GET /webhook_endpoints into NEXHEALTH_WEBHOOK_SECRET yourself.");
}
