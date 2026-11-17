/**
 * pnpm sim <scenario>     run one scenario against the running app (default http://localhost:3000)
 * pnpm sim all            run all of them
 * pnpm sim <name> --local run in-process against a throwaway in-memory database instead
 */
import { loadEnv } from "./lib/env";
import { isScenario, runScenario, SCENARIO_NAMES, SCENARIOS, type ScenarioResult } from "../src/sim/scenarios";

loadEnv();
const args = process.argv.slice(2);
const local = args.includes("--local");
const name = args.find((a) => !a.startsWith("--"));
const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

function usage(): never {
  console.log("Usage: pnpm sim <scenario|all> [--local]\n");
  for (const n of SCENARIO_NAMES) console.log(`  ${n.padEnd(26)} ${SCENARIOS[n].blurb}`);
  process.exit(1);
}

async function runRemote(scenario: string): Promise<ScenarioResult> {
  let res: Response;
  try {
    res = await fetch(`${appUrl}/api/sim/${scenario}`, { method: "POST" });
  } catch {
    console.error(`Could not reach ${appUrl}. Start the app with \`pnpm dev\`, set APP_URL, or pass --local.`);
    process.exit(1);
  }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as ScenarioResult;
}

let db: Awaited<ReturnType<typeof import("../src/db/client").openDb>>["db"] | undefined;
async function runLocal(scenario: string): Promise<ScenarioResult> {
  if (!db) db = (await (await import("../src/db/client")).openDb("memory://")).db;
  return runScenario(scenario as Parameters<typeof runScenario>[0], { db });
}

function print(r: ScenarioResult): void {
  console.log(`\n${r.title}  (${r.subdomain})`);
  for (const t of r.timeline) console.log(`  ${t.at.padEnd(10)} ${t.text}`);
  console.log("");
  for (const c of r.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}`);
}

if (!name) usage();
const names = name === "all" ? SCENARIO_NAMES : isScenario(name) ? [name] : usage();
let failed = 0;
for (const n of names) {
  const result = local ? await runLocal(n) : await runRemote(n);
  print(result);
  if (!result.ok) failed++;
}
if (!local) console.log(`\nOpen ${appUrl}/?subdomain=sim-${names.length === 1 ? names[0] : names.at(-1)} to see what was recorded.`);
process.exit(failed ? 1 : 0);
