import { raiseAlert, resolveAlerts } from "./alerts";
import type { SentinelContext } from "./context";
import { monitoredLocations } from "./sync-monitor";

/** Without these, tracked writes and sync outages can only be caught by polling. */
export const RECOMMENDED_SUBSCRIPTIONS: Array<[resourceType: string, event: string]> = [
  ["Appointment", "appointment_insertion"],
  ["SyncStatus", "sync_status_write_change"],
  ["SyncStatus", "sync_status_read_change"],
];

export interface WatchdogReport {
  endpoints: number;
  inactiveEndpoints: number[];
  inactiveSubscriptions: number[];
}

/**
 * NexHealth deactivates an endpoint after 100 failed deliveries in a row, and "its
 * subscriptions stay inactive when you set the endpoint back to active: true". Both are
 * silent from the receiving side, so check them.
 */
export async function checkWebhookEndpoints(ctx: SentinelContext): Promise<WatchdogReport> {
  const all = await ctx.nex.listWebhookEndpoints();
  const target = ctx.config.webhookTargetUrl;
  const endpoints = target ? all.filter((e) => e.target_url === target) : all;
  const report: WatchdogReport = { endpoints: endpoints.length, inactiveEndpoints: [], inactiveSubscriptions: [] };

  if (target && endpoints.length === 0) {
    await raiseAlert(ctx, {
      dedupeKey: `endpoint:missing:${target}`,
      kind: "endpoint_missing",
      severity: "warning",
      message: `No NexHealth webhook endpoint is registered for ${target}. Run \`pnpm setup:webhooks\`.`,
    });
  }

  const subdomains = [...new Set((await monitoredLocations(ctx)).map((r) => r.subdomain))];

  for (const endpoint of endpoints) {
    const key = `endpoint:${endpoint.id}:inactive`;
    if (!endpoint.active) {
      report.inactiveEndpoints.push(endpoint.id);
      await raiseAlert(ctx, {
        dedupeKey: `${key}:${endpoint.updated_at}`,
        kind: "endpoint_inactive",
        severity: "critical",
        message: `Webhook endpoint #${endpoint.id} is inactive, so NexHealth sends it nothing. Fix: PATCH /webhook_endpoints/${endpoint.id} {"active": true}, then re-activate each of its subscriptions (they stay inactive).`,
      });
      continue;
    }
    await resolveAlerts(ctx, key);

    for (const subdomain of subdomains) {
      const subs = await ctx.nex.listSubscriptions(endpoint.id, subdomain);
      for (const sub of subs) {
        const subKey = `subscription:${endpoint.id}:${sub.id}:inactive`;
        if (sub.active) {
          await resolveAlerts(ctx, subKey);
          continue;
        }
        report.inactiveSubscriptions.push(sub.id);
        await raiseAlert(ctx, {
          dedupeKey: `${subKey}:${sub.updated_at}`,
          kind: "subscription_inactive",
          severity: "critical",
          subdomain,
          message: `Subscription #${sub.id} (${sub.resource_type}/${sub.event}) on endpoint #${endpoint.id} is inactive. Fix: PATCH /webhook_endpoints/${endpoint.id}/webhook_subscriptions/${sub.id}?subdomain=${subdomain} {"active": true}.`,
        });
      }
      for (const [resourceType, event] of RECOMMENDED_SUBSCRIPTIONS) {
        if (subs.some((s) => s.resource_type === resourceType && s.event === event)) continue;
        await raiseAlert(ctx, {
          dedupeKey: `subscription:${endpoint.id}:${subdomain}:missing:${event}`,
          kind: "subscription_missing",
          severity: "info",
          subdomain,
          message: `Endpoint #${endpoint.id} is not subscribed to ${resourceType}/${event} for ${subdomain}; that signal will only be caught by polling.`,
        });
      }
    }
  }
  return report;
}
