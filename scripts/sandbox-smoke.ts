/**
 * Checks this project's assumptions against a real NexHealth sandbox.
 *
 *   NEXHEALTH_API_KEY=... npx tsx scripts/sandbox-smoke.ts
 *
 * Optional: NEXHEALTH_BASE_URL (default https://nexhealth.info), NEXHEALTH_SUBDOMAIN,
 * NEXHEALTH_LOCATION_ID. Read-only: it creates nothing.
 *
 * Writes sanitized responses to fixtures/sandbox/ (patient-like fields redacted, secret_key
 * redacted, the API key and bearer token never written) and a report comparing what the docs
 * say with what the sandbox did.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../src/core/redact";
import { loadEnv, requireEnv } from "./lib/env";

loadEnv();
const apiKey = requireEnv("NEXHEALTH_API_KEY", "Get a sandbox key from NexHealth, then run: NEXHEALTH_API_KEY=... npx tsx scripts/sandbox-smoke.ts");
const base = (process.env.NEXHEALTH_BASE_URL ?? "https://nexhealth.info").replace(/\/$/, "");
const VERSION = "v3.0.0";
const OUT = process.env.SMOKE_OUT_DIR ?? "fixtures/sandbox";

interface Observation {
  claim: string;
  source: string;
  expected: string;
  observed: string;
  match: boolean | null;
}
const report: Observation[] = [];
const secrets = [apiKey];

function observe(claim: string, source: string, expected: string, observed: string, match: boolean | null) {
  report.push({ claim, source, expected, observed, match });
  const mark = match === null ? " ?? " : match ? " ok " : "DIFF";
  console.log(`[${mark}] ${claim}\n        docs: ${expected}\n        seen: ${observed}`);
}

function assertNoSecrets(text: string, file: string) {
  for (const s of secrets) {
    if (s && text.includes(s)) throw new Error(`refusing to write ${file}: it contains the API key or token`);
  }
}

function save(name: string, request: { method: string; path: string; query?: Record<string, unknown> }, status: number, body: unknown) {
  const file = join(OUT, `${name}.json`);
  const text = `${JSON.stringify({ source: base, retrieved_at: new Date().toISOString(), request, status, response: redact(body) }, null, 2)}\n`;
  assertNoSecrets(text, file);
  writeFileSync(file, text);
}

type Query = Record<string, string | number | Array<string | number> | undefined>;

function url(path: string, query: Query = {}): string {
  const u = new URL(base + path);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) u.searchParams.append(k, String(item));
  }
  return u.toString();
}

let token = "";
async function call(method: string, path: string, query: Query = {}, opts: { version?: string | null; auth?: string } = {}) {
  const headers: Record<string, string> = { accept: "application/json" };
  const version = opts.version === undefined ? VERSION : opts.version;
  if (version) headers["Nex-Api-Version"] = version;
  headers.authorization = opts.auth ?? `Bearer ${token}`;
  const res = await fetch(url(path, query), { method, headers });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: res.status, headers: res.headers, body: body as Record<string, unknown> & { data?: unknown; description?: string | null; page_info?: unknown } };
}

mkdirSync(OUT, { recursive: true });
console.log(`Sandbox smoke test against ${base}\n`);

// 1. Authentication
const auth = await call("POST", "/authenticates", {}, { auth: apiKey });
const t = (auth.body?.data as { token?: string } | undefined)?.token;
if (!t) {
  console.error(`Authentication failed (HTTP ${auth.status}). Check NEXHEALTH_API_KEY and NEXHEALTH_BASE_URL.`);
  process.exit(1);
}
token = t;
secrets.push(token);
observe("POST /authenticates status", "reference: postauthenticates", "201", String(auth.status), auth.status === 201);
let ttlMin: number | null = null;
try {
  const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { exp?: number; iat?: number };
  if (payload.exp) ttlMin = Math.round((payload.exp * 1000 - Date.now()) / 60_000);
} catch {
  // not a JWT
}
observe("Bearer token lifetime", "reference: authentication", "about 60 minutes", ttlMin === null ? "token is not a decodable JWT" : `${ttlMin} minutes`, ttlMin === null ? null : ttlMin > 50 && ttlMin <= 61);
save("authenticates", { method: "POST", path: "/authenticates" }, auth.status, { ...auth.body, data: { token: "[redacted]" } });

// 2. Versioning
const noVersion = await call("GET", "/institutions", {}, { version: null });
observe("Request without Nex-Api-Version", "reference: versioning", "404", String(noVersion.status), noVersion.status === 404);

// 3. Institutions and locations
const institutions = await call("GET", "/institutions");
save("institutions", { method: "GET", path: "/institutions" }, institutions.status, institutions.body);
const instList = (institutions.body.data as Array<{ subdomain: string }> | undefined) ?? [];
const subdomain = process.env.NEXHEALTH_SUBDOMAIN ?? instList[0]?.subdomain;
if (!subdomain) {
  console.error("No institution visible to this key; set NEXHEALTH_SUBDOMAIN.");
  process.exit(1);
}
const locations = await call("GET", "/locations", { subdomain });
save("locations", { method: "GET", path: "/locations", query: { subdomain } }, locations.status, locations.body);
const locs = ((locations.body.data as Array<{ locations?: Array<{ id: number; tz?: string; foreign_id_type?: string }> }>) ?? []).flatMap((i) => i.locations ?? []);
const locationId = Number(process.env.NEXHEALTH_LOCATION_ID ?? locs[0]?.id);
const loc = locs.find((l) => l.id === locationId);
observe("GET /locations nests locations under institutions", "reference: getlocations", "data[].locations[]", locs.length ? `${locs.length} location(s), tz=${loc?.tz ?? "?"}` : "no nested locations", locs.length > 0);

// 4. Appointments
const start = new Date(Date.now() - 7 * 86_400_000).toISOString();
const end = new Date(Date.now() + 30 * 86_400_000).toISOString();
const apptQuery = { subdomain, location_id: locationId, start, end, per_page: 5 };
const appts = await call("GET", "/appointments", apptQuery);
save("appointments", { method: "GET", path: "/appointments", query: apptQuery }, appts.status, appts.body);
observe("GET /appointments uses cursor page_info", "reference: pagination", "page_info with end_cursor/has_next_page", appts.body.page_info ? Object.keys(appts.body.page_info as object).join(", ") : "no page_info", appts.body.page_info ? true : false);
const first = (appts.body.data as Array<{ id: number; foreign_id: string | null }> | undefined)?.[0];
if (first) {
  const one = await call("GET", `/appointments/${first.id}`, { subdomain });
  save("appointment", { method: "GET", path: "/appointments/{id}", query: { subdomain } }, one.status, one.body);
}

const ignored = await call("GET", "/appointments", { ...apptQuery, sentinel_unknown_param: 1 });
observe("Unknown query parameter", "reference: introduction", '200 with "Note that following parameters are ignored" in description', `${ignored.status} ${JSON.stringify(ignored.body.description ?? null)}`, ignored.status === 200 && String(ignored.body.description ?? "").includes("ignored"));

const bothCursors = await call("GET", "/appointments", { ...apptQuery, start_cursor: "x", end_cursor: "y" });
observe("Both start_cursor and end_cursor", "reference: pagination", "400", String(bothCursors.status), bothCursors.status === 400);

const noLocation = await call("GET", "/appointments", { subdomain, start, end });
observe("GET /appointments without location_id or foreign_id", "reference: getappointments", "400", String(noLocation.status), noLocation.status === 400);

// 5. Availability
const providers = await call("GET", "/providers", { subdomain, location_id: locationId, per_page: 1 });
const providerId = (providers.body.data as Array<{ id: number }> | undefined)?.[0]?.id;
const slotQuery = { subdomain, start_date: new Date().toISOString().slice(0, 10), days: 7, "lids[]": [locationId], "pids[]": providerId ? [providerId] : undefined };
const slots = await call("GET", "/available_slots", slotQuery);
save("available_slots", { method: "GET", path: "/available_slots", query: slotQuery }, slots.status, slots.body);
observe("GET /available_slots", "reference: getavailableslots", "200 (needs lids[] and pids[] or appointment_type_id)", `${slots.status}${providerId ? "" : " (no provider found to pass as pids[])"}`, slots.status === 200);

// 6. Sync status
const sync = await call("GET", "/sync_status", { subdomain });
save("sync_status", { method: "GET", path: "/sync_status", query: { subdomain } }, sync.status, sync.body);
const entries = Array.isArray(sync.body.data) ? sync.body.data : null;
observe("Sandbox GET /sync_status", "guide: sandbox", "empty list (the sandbox has no sync)", entries ? `${entries.length} entr${entries.length === 1 ? "y" : "ies"}` : `HTTP ${sync.status}`, entries ? entries.length === 0 : false);

// 7. Webhook endpoints (secret_key is redacted before saving)
const endpoints = await call("GET", "/webhook_endpoints");
const epList = (endpoints.body.data as Array<{ id: number; secret_key?: string }> | undefined) ?? [];
for (const ep of epList) if (ep.secret_key) secrets.push(ep.secret_key);
save("webhook_endpoints", { method: "GET", path: "/webhook_endpoints" }, endpoints.status, endpoints.body);
observe("GET /webhook_endpoints", "reference: getwebhookendpoints", "200, list (includes secret_key)", `${endpoints.status}, ${epList.length} endpoint(s)`, endpoints.status === 200);

// 8. Rate-limit headers (informational)
const rl = [...appts.headers.entries()].filter(([k]) => /rate|retry/i.test(k)).map(([k, v]) => `${k}: ${v}`);
observe("Rate-limit headers on a normal response", "reference: rate limits", "informational: 429 responses carry Retry-After", rl.length ? rl.join("; ") : "none", null);

const reportFile = join(OUT, "report.json");
const reportText = `${JSON.stringify({ base_url: base, api_version: VERSION, ran_at: new Date().toISOString(), observations: report }, null, 2)}\n`;
assertNoSecrets(reportText, reportFile);
writeFileSync(reportFile, reportText);
const diffs = report.filter((r) => r.match === false).length;
console.log(`\n${report.length} checks, ${diffs} differ from the docs. Saved to ${OUT}/. Review before committing.`);
