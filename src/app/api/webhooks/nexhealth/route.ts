import { after } from "next/server";
import { receiveWebhook } from "@/sentinel/inbox";
import { processPendingEvents } from "@/sentinel/process";
import { captureDelivery } from "@/server/capture";
import { getSentinel } from "@/server/sentinel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await getSentinel();
  // The signature covers these exact bytes; req.json() or req.text() could change them.
  const rawBody = Buffer.from(await req.arrayBuffer());
  const timestamp = req.headers.get("timestamp");
  const signature = req.headers.get("signature");
  const result = await receiveWebhook(ctx, { rawBody, timestamp, signature });

  const captureDir = process.env.CAPTURE_WEBHOOKS_DIR;
  if (captureDir) {
    await captureDelivery(captureDir, { rawBody, timestamp, signature, secret: ctx.config.webhookSecret, result });
  }
  if (result.outcome === "stored") {
    // Answer NexHealth first; a slow reply counts as a failed delivery.
    const { subdomain } = result;
    after(() => processPendingEvents({ ...ctx, scope: subdomain }).catch((err) => console.error("processing webhook failed:", err)));
  }
  return Response.json(result.outcome === "rejected" ? { error: result.reason } : { ok: true, outcome: result.outcome }, {
    status: result.status,
  });
}
