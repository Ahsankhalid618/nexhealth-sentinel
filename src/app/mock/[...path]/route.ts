import { loadConfig } from "@/sentinel/config";
import { getMockWorld } from "@/server/mock-world";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The mock NexHealth API over HTTP. Point a client at <app>/mock with the key "mock-api-key". */
async function handle(req: Request) {
  if (loadConfig().mode !== "mock") return Response.json({ error: "mock API is off in live mode" }, { status: 404 });
  const mock = getMockWorld();
  const res = await mock.handle(req);
  void mock.runDueDeliveries().catch(() => {});
  return res;
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
