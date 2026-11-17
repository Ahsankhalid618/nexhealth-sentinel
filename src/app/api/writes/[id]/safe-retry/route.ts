import { z } from "zod";
import { safeRetry } from "@/sentinel/writes";
import { authorize, getSentinel } from "@/server/sentinel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const overridesSchema = z
  .object({
    start_time: z.iso.datetime({ offset: true }).optional(),
    end_time: z.iso.datetime({ offset: true }).optional(),
    operatory_id: z.number().int().positive().optional(),
    provider_id: z.number().int().positive().optional(),
  })
  .default({});

/** Read the write back from NexHealth and resend only if it never reached the EHR. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getSentinel();
  const denied = authorize(req, ctx.config);
  if (denied) return denied;
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return Response.json({ error: "bad id" }, { status: 400 });
  const text = await req.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = null;
  }
  const overrides = overridesSchema.safeParse(body);
  if (!overrides.success) return Response.json({ error: z.prettifyError(overrides.error) }, { status: 400 });
  const result = await safeRetry(ctx, id, overrides.data);
  const status = result.outcome === "not_found" ? 404 : result.outcome === "not_retryable" ? 409 : 200;
  return Response.json(result, { status });
}
