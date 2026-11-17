import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { fingerprint } from "@/core/fingerprint";
import { InvalidPayloadError, normalizeEvent } from "@/core/normalize";
import { initials, redact } from "@/core/redact";
import { verifySignature } from "@/core/signature";
import { events, rejectedDeliveries, type StoredEvent } from "@/db/schema";
import type { SentinelContext } from "./context";

export interface InboxRequest {
  /** The body exactly as received. Never parse and re-serialize before verifying. */
  rawBody: Buffer;
  timestamp: string | null;
  signature: string | null;
}

export type InboxResult =
  | { status: 200; outcome: "stored"; eventId: number; subdomain: string }
  | { status: 200; outcome: "duplicate"; eventId: number; subdomain: string }
  | { status: 400 | 401; outcome: "rejected"; reason: string };

function claimed(rawBody: Buffer): { subdomain: string | null; eventName: string | null } {
  try {
    const body = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    return {
      subdomain: typeof body.subdomain === "string" ? body.subdomain.slice(0, 100) : null,
      eventName: typeof body.event_name === "string" ? body.event_name.slice(0, 100) : null,
    };
  } catch {
    return { subdomain: null, eventName: null };
  }
}

async function reject(
  ctx: SentinelContext,
  req: InboxRequest,
  status: 400 | 401,
  reason: string,
): Promise<InboxResult> {
  const { subdomain, eventName } = claimed(req.rawBody);
  await ctx.db.insert(rejectedDeliveries).values({
    reason,
    claimedSubdomain: subdomain,
    claimedEventName: eventName,
    timestampHeader: req.timestamp?.slice(0, 64) ?? null,
    bodySha256: createHash("sha256").update(req.rawBody).digest("hex"),
    bodyBytes: req.rawBody.length,
    receivedAt: ctx.now(),
  });
  return { status, outcome: "rejected", reason };
}

/**
 * Verify, then store once. Processing happens separately (processPendingEvents) so the
 * route can answer 200 straight away, as the docs ask.
 */
export async function receiveWebhook(ctx: SentinelContext, req: InboxRequest): Promise<InboxResult> {
  const secret = ctx.config.webhookSecret;
  if (!secret) throw new Error("NEXHEALTH_WEBHOOK_SECRET is not set");

  const check = verifySignature(req.rawBody, req.timestamp, req.signature, secret, {
    toleranceSec: ctx.config.toleranceSec,
    now: ctx.now(),
  });
  if (!check.ok) return reject(ctx, req, 401, check.reason);

  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody.toString("utf8"));
  } catch {
    return reject(ctx, req, 400, "invalid_json");
  }

  let event;
  try {
    event = normalizeEvent(payload);
  } catch (err) {
    if (err instanceof InvalidPayloadError) return reject(ctx, req, 400, "invalid_payload");
    throw err;
  }

  const stored: StoredEvent = {
    ...event,
    records: event.records.map(({ patientName, ...r }) => ({ ...r, patientInitials: initials(patientName) })),
  };
  const now = ctx.now();
  const fp = fingerprint(event);
  const inserted = await ctx.db
    .insert(events)
    .values({
      fingerprint: fp,
      subdomain: event.subdomain,
      institutionId: event.institutionId,
      locationId: event.records.find((r) => r.locationId !== null)?.locationId ?? null,
      resourceType: event.resourceType,
      eventName: event.eventName,
      eventOutcome: event.eventOutcome,
      eventTime: event.eventTime ? new Date(event.eventTime) : null,
      recordIds: event.records.map((r) => r.id ?? "?"),
      normalized: stored,
      payload: redact(payload) as object,
      priorFailedAttempts: event.priorFailedAttempts,
      receivedAt: now,
    })
    .onConflictDoNothing({ target: events.fingerprint })
    .returning({ id: events.id });

  if (inserted[0]) return { status: 200, outcome: "stored", eventId: inserted[0].id, subdomain: event.subdomain };

  const [dup] = await ctx.db
    .update(events)
    .set({ duplicateCount: sql`${events.duplicateCount} + 1`, lastDuplicateAt: now })
    .where(eq(events.fingerprint, fp))
    .returning({ id: events.id });
  return { status: 200, outcome: "duplicate", eventId: dup!.id, subdomain: event.subdomain };
}
