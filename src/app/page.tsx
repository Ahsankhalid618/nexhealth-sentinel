import Link from "next/link";
import { getDb } from "@/db/client";
import { loadConfig } from "@/sentinel/config";
import { formatLocal } from "@/sentinel/time";
import { loadDashboard, type Dashboard } from "@/server/dashboard";
import { SCENARIO_NAMES, SCENARIOS } from "@/sim/scenarios";
import { ScenarioRunner } from "./scenario-runner";

export const dynamic = "force-dynamic";

const TONE = {
  good: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  warn: "bg-amber-50 text-amber-800 ring-amber-200",
  bad: "bg-red-50 text-red-800 ring-red-200",
  quiet: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  info: "bg-sky-50 text-sky-800 ring-sky-200",
} as const;

const STATUS_TONE: Record<string, keyof typeof TONE> = {
  healthy: "good",
  complete: "good",
  expected_downtime: "quiet",
  no_sync: "info",
  unknown: "quiet",
  requested: "quiet",
  accepted: "info",
  degraded_reads: "warn",
  stuck: "warn",
  writes_blocked: "bad",
  down: "bad",
  failed: "bad",
  timed_out: "bad",
  rejected: "quiet",
  critical: "bad",
  warning: "warn",
};

function Badge({ value }: { value: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE[STATUS_TONE[value] ?? "quiet"]}`}>
      {value.replace(/_/g, " ")}
    </span>
  );
}

function Card({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white">
      <header className="flex items-baseline justify-between gap-4 border-b border-zinc-100 px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {note && <span className="text-xs text-zinc-500">{note}</span>}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-sm text-zinc-500">{children}</p>;
}

function Stat({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

const th = "px-4 py-2 text-left text-xs font-medium text-zinc-500 whitespace-nowrap";
const td = "px-4 py-2 align-top text-sm";

export default async function Home({ searchParams }: { searchParams: Promise<{ subdomain?: string }> }) {
  const config = loadConfig();
  const { subdomain = null } = await searchParams;
  const data = await loadDashboard(await getDb(), subdomain);
  const zones = new Map(data.locations.map((l) => [l.subdomain, l.timezone]));
  const when = (date: Date | null, sub: string | null) =>
    date ? formatLocal(date, (sub && zones.get(sub)) || "UTC", true) : "—";

  const w = data.stats.writes;
  const pending = (w.requested ?? 0) + (w.accepted ?? 0) + (w.stuck ?? 0);
  const failed = (w.failed ?? 0) + (w.timed_out ?? 0);
  const openAlerts = data.alerts.filter((a) => !a.resolvedAt);

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">nexhealth-sentinel</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-600">
            Watches a NexHealth Synchronizer integration for the failures that are silent by default: duplicate and
            forged webhooks, writes that never reach the EHR, sync outages during office hours, and events skipped while
            an endpoint is paused.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-xs">
          <span className={`rounded-full px-2.5 py-1 font-medium ring-1 ring-inset ${config.mode === "mock" ? TONE.info : TONE.good}`}>
            {config.mode === "mock" ? "Mock mode: simulated NexHealth" : "Live mode"}
          </span>
          <span className="text-zinc-500">Unofficial. Not affiliated with NexHealth.</span>
        </div>
      </header>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Run a failure scenario</h2>
          <p className="text-xs text-zinc-500">
            Each one replays a documented failure against the mock API on a simulated clock, through the same code that
            handles real webhooks. Patient names are invented; only initials are stored.
          </p>
        </div>
        <ScenarioRunner
          enabled={config.mode === "mock"}
          scenarios={SCENARIO_NAMES.map((name) => ({ name, ...SCENARIOS[name] }))}
        />
      </section>

      {data.subdomains.length > 0 && (
        <nav className="flex flex-wrap gap-2 text-xs">
          {[null, ...data.subdomains].map((s) => (
            <Link
              key={s ?? "all"}
              href={s ? `/?subdomain=${s}` : "/"}
              scroll={false}
              className={`rounded-full px-3 py-1 ring-1 ring-inset ${s === subdomain ? "bg-zinc-900 text-white ring-zinc-900" : "bg-white text-zinc-700 ring-zinc-200 hover:ring-zinc-400"}`}
            >
              {s ?? "All institutions"}
            </Link>
          ))}
        </nav>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Webhooks stored" value={data.stats.eventsStored} sub={`${data.stats.duplicatesIgnored} duplicates ignored`} />
        <Stat label="Writes in the EHR" value={w.complete ?? 0} sub={`${pending} pending · ${failed} failed or timed out`} />
        <Stat label="Open alerts" value={openAlerts.length} sub={`${openAlerts.filter((a) => a.severity === "critical").length} critical`} />
        <Stat label="Forged or stale rejected" value={data.stats.rejected} />
        <Stat label="Changes recovered" value={data.stats.recovered} sub="never delivered by webhook" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Sync health" note="Office hours: Mon–Fri 08:00–18:00, location time">
          <SyncTable data={data} when={when} />
        </Card>
        <Card title="Alerts" note="critical and warning go to ALERT_WEBHOOK_URL">
          {data.alerts.length === 0 ? (
            <Empty>No alerts.</Empty>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {data.alerts.map((a) => (
                <li key={a.id} className={`px-4 py-3 text-sm ${a.resolvedAt ? "opacity-60" : ""}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge value={a.severity} />
                    <span className="font-mono text-xs text-zinc-500">{a.kind}</span>
                    <span className="text-xs text-zinc-500">{when(a.createdAt, a.subdomain)}</span>
                    {a.resolvedAt && <span className="text-xs text-emerald-700">resolved {when(a.resolvedAt, a.subdomain)}</span>}
                  </div>
                  <p className="mt-1">{a.message}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Tracked writes" note="201 means accepted, not written. Complete means foreign_id is set.">
        <WritesTable data={data} when={when} />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Webhooks received" note="deduped on record id + updated_at">
          {data.events.length === 0 ? (
            <Empty>Nothing received yet.</Empty>
          ) : (
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Received</th>
                  <th className={th}>Event</th>
                  <th className={th}>Records</th>
                  <th className={th}>Copies</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {data.events.map((e) => (
                  <tr key={e.id}>
                    <td className={`${td} whitespace-nowrap text-zinc-500`}>{when(e.receivedAt, e.subdomain)}</td>
                    <td className={`${td} font-mono text-xs`}>{e.eventName}</td>
                    <td className={`${td} font-mono text-xs`}>{e.recordIds.join(", ")}</td>
                    <td className={td}>
                      {e.duplicateCount > 0 ? `1 + ${e.duplicateCount} ignored` : "1"}
                      {e.priorFailedAttempts > 0 && <span className="text-xs text-amber-700"> (retry #{e.priorFailedAttempts})</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Rejected deliveries" note="metadata only; the body is never stored">
          {data.rejected.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Received</th>
                  <th className={th}>Reason</th>
                  <th className={th}>Claimed</th>
                  <th className={th}>Bytes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {data.rejected.map((r) => (
                  <tr key={r.id}>
                    <td className={`${td} whitespace-nowrap text-zinc-500`}>{when(r.receivedAt, r.claimedSubdomain)}</td>
                    <td className={`${td} font-mono text-xs`}>{r.reason}</td>
                    <td className={`${td} text-xs`}>
                      {r.claimedSubdomain ?? "?"} / {r.claimedEventName ?? "?"}
                    </td>
                    <td className={`${td} tabular-nums`}>{r.bodyBytes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <footer className="border-t border-zinc-200 pt-4 text-xs text-zinc-500">
        Unofficial open-source tool, not affiliated with or endorsed by NexHealth. Built from NexHealth&apos;s public
        documentation. Shows initials only; payloads are stored with patient fields redacted.
      </footer>
    </main>
  );
}

type When = (date: Date | null, sub: string | null) => string;

function SyncTable({ data, when }: { data: Dashboard; when: When }) {
  if (data.locations.length === 0) return <Empty>No locations yet. Run a scenario, or the cron tick in live mode.</Empty>;
  return (
    <table className="w-full">
      <thead>
        <tr>
          <th className={th}>Location</th>
          <th className={th}>State</th>
          <th className={th}>Read / write</th>
          <th className={th}>Red since</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100">
        {data.locations.map((l) => (
          <tr key={`${l.subdomain}:${l.locationId}`}>
            <td className={td}>
              <div>{l.locationName ?? `Location ${l.locationId}`}</div>
              <div className="font-mono text-xs text-zinc-500">
                {l.subdomain} · {l.timezone}
              </div>
            </td>
            <td className={td}>
              <Badge value={l.state} />
            </td>
            <td className={`${td} whitespace-nowrap`}>
              {l.hasSync === false ? (
                <span className="text-xs text-zinc-500">no sync</span>
              ) : (
                <span className="font-mono text-xs">
                  <span className={l.readStatus === "red" ? "text-red-700" : "text-emerald-700"}>{l.readStatus ?? "?"}</span>
                  {" / "}
                  <span className={l.writeStatus === "red" ? "text-red-700" : "text-emerald-700"}>{l.writeStatus ?? "?"}</span>
                </span>
              )}
            </td>
            <td className={`${td} whitespace-nowrap text-xs text-zinc-500`}>{when(l.redSince, l.subdomain)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WritesTable({ data, when }: { data: Dashboard; when: When }) {
  if (data.writes.length === 0) return <Empty>No tracked writes yet.</Empty>;
  return (
    <table className="w-full">
      <thead>
        <tr>
          <th className={th}>#</th>
          <th className={th}>Patient</th>
          <th className={th}>Starts</th>
          <th className={th}>Status</th>
          <th className={th}>What we know</th>
          <th className={th}>NexHealth id / foreign_id</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100">
        {data.writes.map((wr) => (
          <tr key={wr.id}>
            <td className={`${td} font-mono text-xs`}>
              {wr.id}
              {wr.retryOfId && <div className="text-zinc-500">retry of {wr.retryOfId}</div>}
              {wr.retriedById && <div className="text-zinc-500">retried as {wr.retriedById}</div>}
            </td>
            <td className={td}>{wr.patientInitials ?? "—"}</td>
            <td className={`${td} whitespace-nowrap text-xs`}>{when(wr.startTime, wr.subdomain)}</td>
            <td className={td}>
              <Badge value={wr.status} />
            </td>
            <td className={`${td} max-w-md text-xs text-zinc-600`}>
              {wr.statusDetail}
              {wr.lastError && <div className="text-red-700">{wr.lastError}</div>}
            </td>
            <td className={`${td} font-mono text-xs`}>
              {wr.nexAppointmentId ?? "—"} / {wr.foreignId ?? "null"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
