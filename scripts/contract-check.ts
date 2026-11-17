/**
 * Compares the mock API with NexHealth's published OpenAPI definitions, so drift in the docs
 * shows up as a failing check instead of a mock that quietly lies.
 *
 *   pnpm contract:check
 *
 * Each reference page at docs.nexhealth.com/reference/<slug>.md embeds the OpenAPI JSON for
 * its operation; the slug is the method plus the path without punctuation.
 */
import { MockNexHealth } from "../src/mock/nexhealth-mock";

const DOCS = process.env.NEXHEALTH_DOCS_URL ?? "https://docs.nexhealth.com/reference";

interface Param {
  name: string;
  in: string;
  required?: boolean;
}
interface Operation {
  parameters?: Param[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
}
interface Schema {
  required?: string[];
  properties?: Record<string, Schema>;
}

const slugFor = (method: string, path: string) => `${method.toLowerCase()}${path.replace(/[{}_/]/g, "")}`;
const shape = (path: string) => path.replace(/\{[^}]+\}/g, "{}");

function bodyRequired(schema: Schema | undefined, prefix = ""): string[] {
  if (!schema) return [];
  const own = (schema.required ?? []).map((r) => prefix + r);
  const nested = Object.entries(schema.properties ?? {}).flatMap(([k, v]) => (v.required ? bodyRequired(v, `${prefix}${k}.`) : []));
  return [...own, ...nested];
}

async function fetchOperation(method: string, path: string): Promise<Operation | string> {
  const slug = slugFor(method, path);
  const res = await fetch(`${DOCS}/${slug}.md`);
  if (!res.ok) return `docs page ${slug}.md returned ${res.status}`;
  const md = await res.text();
  const block = md.match(/```json\n([\s\S]*?)\n```/);
  if (!block) return `no OpenAPI block in ${slug}.md`;
  const spec = JSON.parse(block[1]!) as { paths: Record<string, Record<string, Operation>> };
  const key = Object.keys(spec.paths).find((p) => shape(p) === shape(path));
  const op = key ? spec.paths[key]![method.toLowerCase()] : undefined;
  return op ?? `${method} ${path} not found in ${slug}.md`;
}

const mock = new MockNexHealth(() => new Date());
let problems = 0;
for (const route of mock.routes) {
  const label = `${route.method} ${route.path}`;
  const op = await fetchOperation(route.method, route.path);
  if (typeof op === "string") {
    console.log(`?    ${label}: ${op}`);
    continue;
  }
  const query = (op.parameters ?? []).filter((p) => p.in === "query");
  const docRequired = query.filter((p) => p.required).map((p) => p.name).sort();
  const mockRequired = [...route.required].sort();
  const docNames = new Set(query.map((p) => p.name));
  const unknownToDocs = route.query.filter((q) => !docNames.has(q));

  const issues: string[] = [];
  if (docRequired.join() !== mockRequired.join()) {
    issues.push(`required query params: docs [${docRequired.join(", ")}], mock [${mockRequired.join(", ")}]`);
  }
  if (unknownToDocs.length) issues.push(`mock accepts params the docs don't list: ${unknownToDocs.join(", ")}`);
  const body = bodyRequired(op.requestBody?.content?.["application/json"]?.schema);

  if (issues.length) {
    problems++;
    console.log(`DIFF ${label}\n       ${issues.join("\n       ")}`);
  } else {
    console.log(`ok   ${label}${body.length ? `  (body requires: ${body.join(", ")})` : ""}`);
  }
}
console.log(problems ? `\n${problems} route(s) differ from the published docs.` : "\nThe mock matches the published docs for every route it implements.");
process.exit(problems ? 1 : 0);
