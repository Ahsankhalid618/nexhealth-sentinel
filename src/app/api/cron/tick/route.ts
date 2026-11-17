import { runTick } from "@/sentinel/tick";
import { authorize, getSentinel } from "@/server/sentinel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function tick(req: Request) {
  const ctx = await getSentinel();
  const denied = authorize(req, ctx.config);
  if (denied) return denied;
  const report = await runTick(ctx, { discover: true });
  return Response.json(report, { status: report.errors.length ? 500 : 200 });
}

// Vercel Cron sends GET; the GitHub Actions workflow sends POST.
export const GET = tick;
export const POST = tick;
