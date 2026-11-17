import type { Db } from "@/db/client";
import type { NexHealthClient } from "@/nexhealth/client";
import type { SentinelConfig } from "./config";

export type Severity = "critical" | "warning" | "info";

export interface NewAlert {
  dedupeKey: string;
  kind: string;
  severity: Severity;
  subdomain?: string;
  locationId?: number;
  message: string;
}

export interface SentinelContext {
  db: Db;
  nex: NexHealthClient;
  config: SentinelConfig;
  now: () => Date;
  /** Called once for every newly raised alert. */
  notify: (alert: NewAlert) => Promise<void>;
  /** Limits timer work and alert keys to one institution, so simulator runs can share a database. */
  scope?: string;
}

/** Posts critical and warning alerts to a Slack or Discord incoming webhook. Info alerts stay on the dashboard. */
export function webhookNotifier(url: string | null): (alert: NewAlert) => Promise<void> {
  return async (alert) => {
    if (!url || alert.severity === "info") return;
    const text = `[nexhealth-sentinel] ${alert.severity.toUpperCase()}: ${alert.message}`;
    try {
      // Slack reads `text`, Discord reads `content`.
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, content: text }),
      });
    } catch (err) {
      console.error("alert webhook failed:", err instanceof Error ? err.message : err);
    }
  };
}
