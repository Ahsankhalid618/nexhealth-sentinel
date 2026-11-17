import { createHash } from "node:crypto";
import type { NormalizedEvent } from "./normalize";

/**
 * NexHealth payloads carry no event ID, and the docs say to dedupe on the record's
 * `id` + `updated_at`. The hash is built only from normalized fields, so `delivery_errors`
 * (which grows on every retry) and the `timestamp` header never affect it.
 */
export function fingerprint(event: NormalizedEvent): string {
  const parts = event.records
    .map((r) => `${r.id ?? "?"}:${r.updatedAt ?? event.eventTime ?? ""}`)
    .sort();
  if (event.sync) {
    const s = event.sync;
    parts.push(
      `sync:${s.syncSourceName ?? "?"}:${s.readStatus}@${s.readStatusAt}:${s.writeStatus}@${s.writeStatusAt}`,
    );
  }
  const material = [event.subdomain, event.eventName, event.resourceType, ...parts].join("|");
  return createHash("sha256").update(material, "utf8").digest("hex");
}
