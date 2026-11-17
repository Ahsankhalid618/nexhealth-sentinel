"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ScenarioResult } from "@/sim/scenarios";

interface Props {
  scenarios: Array<{ name: string; title: string; blurb: string }>;
  enabled: boolean;
}

export function ScenarioRunner({ scenarios, enabled }: Props) {
  const router = useRouter();
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function run(name: string) {
    setRunning(name);
    setError(null);
    try {
      const res = await fetch(`/api/sim/${name}`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setResult(body as ScenarioResult);
      startTransition(() => router.push(`/?subdomain=${body.subdomain}`, { scroll: false }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {scenarios.map((s) => (
          <button
            key={s.name}
            type="button"
            disabled={!enabled || running !== null}
            onClick={() => run(s.name)}
            className="group rounded-lg border border-zinc-200 bg-white p-3 text-left transition hover:border-zinc-400 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">{s.title}</span>
              <span className="font-mono text-[11px] text-zinc-400">{running === s.name ? "running…" : "▶ run"}</span>
            </div>
            <p className="mt-1 text-xs leading-snug text-zinc-500">{s.blurb}</p>
          </button>
        ))}
      </div>
      {!enabled && <p className="text-sm text-zinc-500">The simulator is off in live mode.</p>}
      {error && <p className="text-sm text-red-700">Scenario failed: {error}</p>}
      {result && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-semibold">
              {result.title} <span className="font-mono text-xs font-normal text-zinc-500">{result.subdomain}</span>
            </h3>
            <span className={`text-sm font-medium ${result.ok ? "text-emerald-700" : "text-red-700"}`}>
              {result.checks.filter((c) => c.ok).length}/{result.checks.length} checks passed
            </span>
          </div>
          <ol className="mt-3 space-y-1 text-sm">
            {result.timeline.map((t, i) => (
              <li key={i} className="flex gap-3">
                <span className="w-20 shrink-0 font-mono text-xs leading-5 text-zinc-500">{t.at}</span>
                <span>{t.text}</span>
              </li>
            ))}
          </ol>
          <ul className="mt-3 grid gap-1 border-t border-zinc-100 pt-3 text-sm sm:grid-cols-2">
            {result.checks.map((c) => (
              <li key={c.label} className={c.ok ? "text-emerald-800" : "text-red-700"}>
                {c.ok ? "✓" : "✗"} {c.label}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-zinc-400">Simulated clock. The tables below show what the sentinel recorded.</p>
        </div>
      )}
    </div>
  );
}
