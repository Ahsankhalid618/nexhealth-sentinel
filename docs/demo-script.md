# Two-minute demo script

Use this for a screen recording (Loom or similar). Mock mode, no API key. Terminal font large enough to read.

**Before you start:** `pnpm dev` at http://localhost:3000. Optional: set `ALERT_WEBHOOK_URL` to a test Slack channel so a critical alert appears during the business-hours scenario.

## 0:00–0:15 — The problem

Show the README "Why" section or say from memory:

- NexHealth returns 201 when a booking is **accepted**, not when it is in the EHR.
- Webhooks have **no event ID** — duplicates and retries are your problem.
- When your endpoint fails, events are **skipped** and never resent.
- Failed writes carry **no reason** and are **not auto-retried**.
- The **sandbox has no sync**, so you cannot see insertion or sync events there.

"This repo is a small open-source layer so developers hear about those failures before patients do."

## 0:15–0:35 — Live sandbox (optional; needs a key)

Skip if you only demo mock mode.

```bash
NEXHEALTH_API_KEY=... npx tsx scripts/sandbox-smoke.ts
pnpm setup:webhooks   # after WEBHOOK_TARGET_URL points at a tunnel or deploy
pnpm demo:live --yes
```

On the dashboard (live mode): one verified `patient_created` (if the webhook arrived), and a tracked write with preflight **no sync** — "No sync behind this location."

## 0:35–0:55 — Duplicate delivery and forged webhooks

Terminal:

```bash
pnpm sim duplicate-retry
pnpm sim forged
```

Dashboard filter `sim-duplicate-retry`: **1** webhook stored, duplicate count **2**. Filter `sim-forged`: **3** rejected, **0** events. Mention the re-serialized body failing signature check (docs Python sample pitfall).

## 0:55–1:20 — Sync down in office hours, then overnight

```bash
pnpm sim sync-down-business-hours
```

Dashboard: location state **down**, then **healthy**; open **critical** alerts at ~10:50 local, resolved after recovery; write goes **stuck** then **complete**.

```bash
pnpm sim office-closed
```

Filter `sim-office-closed`: overnight **0** critical alerts (expected downtime); booking completes in the morning.

## 1:20–1:40 — Paused endpoint gap

```bash
pnpm sim paused-endpoint-gap
```

Timeline: 0 webhooks for 15 changes, reconciler recovered **15**, gap alert. Tie to docs: skipped deliveries are not resent — you need `updated_since` or a replay API.

## 1:40–2:00 — Close

Open `DESIGN.md`: five server-side proposals (event IDs, failure reasons, replay API, location_ids on SyncStatus events, sandbox test clock). Mention `pnpm contract:check`, MIT license, unofficial / not affiliated with NexHealth.

**Recording the dashboard:** Run `pnpm sim sync-down-business-hours`, then scroll sync health, alerts, and writes — good for a ~20s GIF in the README.