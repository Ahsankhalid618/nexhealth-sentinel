import type { SentinelContext } from "./context";
import { processPendingEvents } from "./process";
import { reconcileAppointments, type ReconcileReport } from "./reconcile";
import { discoverLocations, evaluateSyncHealth, pollSyncStatus } from "./sync-monitor";
import { checkWebhookEndpoints, type WatchdogReport } from "./watchdog";
import { checkPendingWrites } from "./writes";

export interface TickReport {
  processedEvents: number;
  watchdog: WatchdogReport | null;
  reconcile: ReconcileReport | null;
  errors: string[];
}

/** Everything that runs on a timer. Each step is isolated so one failing call doesn't stop the rest. */
export async function runTick(ctx: SentinelContext, options: { discover?: boolean } = {}): Promise<TickReport> {
  const report: TickReport = { processedEvents: 0, watchdog: null, reconcile: null, errors: [] };
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      report.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  report.processedEvents = (await step("events", () => processPendingEvents(ctx))) ?? 0;
  if (options.discover) await step("discover", () => discoverLocations(ctx));
  await step("sync poll", () => pollSyncStatus(ctx));
  await step("sync evaluate", () => evaluateSyncHealth(ctx));
  await step("pending writes", () => checkPendingWrites(ctx));
  report.watchdog = await step("watchdog", () => checkWebhookEndpoints(ctx));
  report.reconcile = await step("reconcile", () => reconcileAppointments(ctx));
  return report;
}
