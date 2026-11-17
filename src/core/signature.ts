import { createHmac, timingSafeEqual } from "node:crypto";

export type SignatureFailure =
  | "missing_header"
  | "bad_signature"
  | "stale_timestamp"
  | "invalid_timestamp";

export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailure };

export interface VerifyOptions {
  /**
   * How far the `timestamp` header may be from `now`, in seconds. NexHealth's docs do not
   * define a replay window; this check is our own addition. Set to 0 to turn it off.
   */
  toleranceSec?: number;
  now?: Date;
}

export const DEFAULT_TOLERANCE_SEC = 300;

function toBuffer(rawBody: Buffer | Uint8Array | string): Buffer {
  return typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
}

/**
 * The documented algorithm (docs.nexhealth.com/docs/webhooks, "Checking the webhook signature"):
 * base64(raw body) -> "{timestamp}.{base64}" -> HMAC-SHA256 keyed with the endpoint secret_key -> hex.
 */
export function computeSignature(
  rawBody: Buffer | Uint8Array | string,
  timestamp: string,
  secret: string,
): string {
  const signedPayload = `${timestamp}.${toBuffer(rawBody).toString("base64")}`;
  return createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
}

export function verifySignature(
  rawBody: Buffer | Uint8Array | string,
  timestamp: string | null | undefined,
  signature: string | null | undefined,
  secret: string,
  options: VerifyOptions = {},
): SignatureResult {
  if (!secret) throw new Error("verifySignature: webhook secret is empty");
  if (!timestamp || !signature) return { ok: false, reason: "missing_header" };

  const expected = Buffer.from(computeSignature(rawBody, timestamp, secret), "utf8");
  const given = Buffer.from(signature.trim().toLowerCase(), "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  const toleranceSec = options.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (toleranceSec > 0) {
    const sentAt = Date.parse(timestamp);
    if (Number.isNaN(sentAt)) return { ok: false, reason: "invalid_timestamp" };
    const skewSec = Math.abs((options.now ?? new Date()).getTime() - sentAt) / 1000;
    if (skewSec > toleranceSec) return { ok: false, reason: "stale_timestamp" };
  }
  return { ok: true };
}

export type SignatureVariant =
  | "documented"
  | "base64_digest"
  | "body_not_base64_encoded"
  | "reserialized_compact_json"
  | "none";

/**
 * For the live-sandbox check only: when a real delivery fails verification, report which
 * plausible variant of the algorithm would have matched, so the fix is obvious. Never used
 * to accept a request.
 */
export function diagnoseSignature(
  rawBody: Buffer | Uint8Array | string,
  timestamp: string,
  signature: string,
  secret: string,
): SignatureVariant {
  const body = toBuffer(rawBody);
  const given = signature.trim();
  const hmac = (message: string) => createHmac("sha256", secret).update(message, "utf8");

  if (hmac(`${timestamp}.${body.toString("base64")}`).digest("hex") === given.toLowerCase()) {
    return "documented";
  }
  if (hmac(`${timestamp}.${body.toString("base64")}`).digest("base64") === given) {
    return "base64_digest";
  }
  if (hmac(`${timestamp}.${body.toString("utf8")}`).digest("hex") === given.toLowerCase()) {
    return "body_not_base64_encoded";
  }
  try {
    const compact = Buffer.from(JSON.stringify(JSON.parse(body.toString("utf8"))), "utf8");
    if (hmac(`${timestamp}.${compact.toString("base64")}`).digest("hex") === given.toLowerCase()) {
      return "reserialized_compact_json";
    }
  } catch {
    // not JSON; nothing more to try
  }
  return "none";
}
