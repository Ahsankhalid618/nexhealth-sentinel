import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "@/core/redact";
import { diagnoseSignature } from "@/core/signature";
import type { InboxResult } from "@/sentinel/inbox";

/**
 * For checking our assumptions against a real sandbox: with CAPTURE_WEBHOOKS_DIR set, every
 * delivery is written there with patient fields redacted, plus which signing recipe matched.
 * The secret and the raw signature are never written.
 */
export async function captureDelivery(
  dir: string,
  input: { rawBody: Buffer; timestamp: string | null; signature: string | null; secret: string | null; result: InboxResult },
): Promise<void> {
  let payload: unknown = null;
  try {
    payload = redact(JSON.parse(input.rawBody.toString("utf8")));
  } catch {
    payload = "(not JSON)";
  }
  const record = {
    captured_at: new Date().toISOString(),
    headers: { timestamp: input.timestamp, signature_present: Boolean(input.signature) },
    body_bytes: input.rawBody.length,
    result: input.result,
    signature_recipe:
      input.secret && input.timestamp && input.signature
        ? diagnoseSignature(input.rawBody, input.timestamp, input.signature, input.secret)
        : "not checked",
    payload,
  };
  await mkdir(dir, { recursive: true });
  const name = `${record.captured_at.replace(/[:.]/g, "-")}.json`;
  await writeFile(join(dir, name), `${JSON.stringify(record, null, 2)}\n`);
}
