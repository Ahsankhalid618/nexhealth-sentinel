import { z } from "zod";
import { NexHealthError } from "@/nexhealth/client";
import { createTrackedAppointment } from "@/sentinel/writes";
import { authorize, getSentinel } from "@/server/sentinel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bookingSchema = z.object({
  clientKey: z.string().min(1).max(200),
  subdomain: z.string().min(1),
  locationId: z.number().int().positive(),
  patientName: z.string().max(200).nullish(),
  appointment: z.object({
    patient_id: z.number().int().positive(),
    provider_id: z.number().int().positive(),
    start_time: z.iso.datetime({ offset: true }),
    end_time: z.iso.datetime({ offset: true }).optional(),
    operatory_id: z.number().int().positive().optional(),
    appointment_type_id: z.number().int().positive().optional(),
    note: z.string().max(128).optional(),
  }),
});

/** Book through the sentinel so the write is tracked until it is in the EHR. */
export async function POST(req: Request) {
  const ctx = await getSentinel();
  const denied = authorize(req, ctx.config);
  if (denied) return denied;
  const parsed = bookingSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  try {
    const { write, replayed } = await createTrackedAppointment(ctx, parsed.data);
    return Response.json({ write, replayed }, { status: replayed ? 200 : 201 });
  } catch (err) {
    if (err instanceof NexHealthError) return Response.json({ error: err.message }, { status: 502 });
    throw err;
  }
}
