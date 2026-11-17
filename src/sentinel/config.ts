import { z } from "zod";
import { DEFAULT_OFFICE_HOURS, type OfficeHours } from "@/core/sync-state";
import { DEFAULT_TOLERANCE_SEC } from "@/core/signature";

/** Only ever used by the mock and the simulator. Live mode requires NEXHEALTH_WEBHOOK_SECRET. */
export const MOCK_WEBHOOK_SECRET = "mock-webhook-secret-not-for-production";

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const officeHoursRule = z.object({
  days: z.array(z.number().int().min(0).max(6)).optional(),
  open: hhmm.optional(),
  close: hhmm.optional(),
  timezone: z.string().optional(),
});
export type OfficeHoursRule = z.infer<typeof officeHoursRule>;

const intFromEnv = (fallback: number) => z.coerce.number().int().min(0).default(fallback);

const envSchema = z.object({
  NEXHEALTH_MODE: z.enum(["mock", "live"]).default("mock"),
  NEXHEALTH_API_KEY: z.string().optional(),
  NEXHEALTH_BASE_URL: z.string().url().optional(),
  NEXHEALTH_WEBHOOK_SECRET: z.string().optional(),
  WEBHOOK_TOLERANCE_SEC: intFromEnv(DEFAULT_TOLERANCE_SEC),
  WEBHOOK_TARGET_URL: z.string().url().optional(),
  SYNC_ALERT_AFTER_MIN: intFromEnv(30),
  STUCK_WRITE_AFTER_MIN: intFromEnv(30),
  PREFLIGHT_MODE: z.enum(["will_wait", "refuse"]).default("will_wait"),
  OFFICE_HOURS_JSON: z.string().optional(),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  CRON_SECRET: z.string().optional(),
});

export interface SentinelConfig {
  mode: "mock" | "live";
  apiKey: string | null;
  baseUrl: string | null;
  webhookSecret: string | null;
  toleranceSec: number;
  webhookTargetUrl: string | null;
  syncAlertAfterMin: number;
  stuckWriteAfterMin: number;
  preflightMode: "will_wait" | "refuse";
  /** Keys are "default" or "<subdomain>:<locationId>". */
  officeHours: Record<string, OfficeHoursRule>;
  alertWebhookUrl: string | null;
  cronSecret: string | null;
  reconcile: { pastDays: number; futureDays: number; overlapMin: number };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): SentinelConfig {
  const blankToUndefined = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === "" ? undefined : v]));
  const e = envSchema.parse(blankToUndefined);
  const officeHours = e.OFFICE_HOURS_JSON
    ? z.record(z.string(), officeHoursRule).parse(JSON.parse(e.OFFICE_HOURS_JSON))
    : {};
  return {
    mode: e.NEXHEALTH_MODE,
    apiKey: e.NEXHEALTH_API_KEY ?? null,
    baseUrl: e.NEXHEALTH_BASE_URL ?? null,
    webhookSecret: e.NEXHEALTH_WEBHOOK_SECRET ?? (e.NEXHEALTH_MODE === "mock" ? MOCK_WEBHOOK_SECRET : null),
    toleranceSec: e.WEBHOOK_TOLERANCE_SEC,
    webhookTargetUrl: e.WEBHOOK_TARGET_URL ?? null,
    syncAlertAfterMin: e.SYNC_ALERT_AFTER_MIN,
    stuckWriteAfterMin: e.STUCK_WRITE_AFTER_MIN,
    preflightMode: e.PREFLIGHT_MODE,
    officeHours,
    alertWebhookUrl: e.ALERT_WEBHOOK_URL ?? null,
    cronSecret: e.CRON_SECRET ?? null,
    reconcile: { pastDays: 30, futureDays: 120, overlapMin: 5 },
  };
}

/** Per-location rule, then "default", then Mon-Fri 08:00-18:00 in the location's own time zone. */
export function officeHoursFor(
  config: SentinelConfig,
  subdomain: string,
  locationId: number,
  locationTimezone: string,
): OfficeHours {
  const rule = { ...config.officeHours.default, ...config.officeHours[`${subdomain}:${locationId}`] };
  return {
    timezone: rule.timezone ?? locationTimezone,
    days: rule.days ?? DEFAULT_OFFICE_HOURS.days,
    open: rule.open ?? DEFAULT_OFFICE_HOURS.open,
    close: rule.close ?? DEFAULT_OFFICE_HOURS.close,
  };
}
