import { getDb } from "@/db/client";
import { loadConfig } from "@/sentinel/config";
import { isScenario, runScenario, SCENARIO_NAMES } from "@/sim/scenarios";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(_req: Request, { params }: { params: Promise<{ scenario: string }> }) {
  if (loadConfig().mode !== "mock") {
    return Response.json({ error: "the simulator only runs with NEXHEALTH_MODE=mock" }, { status: 404 });
  }
  const { scenario } = await params;
  if (!isScenario(scenario)) {
    return Response.json({ error: `unknown scenario; try one of: ${SCENARIO_NAMES.join(", ")}` }, { status: 404 });
  }
  const result = await runScenario(scenario, { db: await getDb() });
  return Response.json(result);
}
