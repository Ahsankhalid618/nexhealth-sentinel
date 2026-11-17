# Design notes

nexhealth-sentinel is an unofficial companion to the [NexHealth Synchronizer API](https://docs.nexhealth.com). It was built from the public docs and a mock that tracks those docs (`pnpm contract:check`). Nothing here claims to match NexHealth's private behaviour.

## Decisions

### Fingerprint = subdomain + event + each record's `id` + `updated_at`

Webhooks carry [no event ID](https://docs.nexhealth.com/docs/webhooks). Retries are the same logical change, so the dedupe key is the business version, not the HTTP attempt. `delivery_errors` on a retry is excluded so the fingerprint matches the first delivery. Sync events include sync source name and the read/write statuses and timestamps. Collisions across different records in one payload are unlikely because every record id is in the hash.

### Answer 200 quickly, process separately

NexHealth retries when the endpoint does not return 2xx. Processing in the handler risks a slow DB or a timeout looking like a failed delivery. The route stores (or dedupes) then returns 200; `after()` runs the state machine. The cron tick catches anything that slipped through.

### Poll `GET /sync_status` even with webhooks

Skipped deliveries during a [pause](https://docs.nexhealth.com/docs/webhooks) are not resent. SyncStatus webhooks can be skipped too, and the documented example has `locations: null`, so a webhook may not say which location changed. Polling is the backstop. When `locations` is missing, the event is applied to every location that was last seen on that sync source (or that had no sync name yet).

### Never auto-retry a failed write

The docs: [NexHealth does not retry a failed write](https://docs.nexhealth.com/docs/how-a-write-reaches-the-ehr); read back and confirm `foreign_id` is still `null` before sending again. The sentinel only resends from an explicit safe-retry (API or operator). An unanswered POST is treated as unknown: search by patient and start time before creating a second booking.

### Office-hours-aware alerting

A red sync at night is often expected (on-prem server off). The classifier distinguishes `expected_downtime` from `writes_blocked` / `down` during configured office hours (default Mon–Fri 08:00–18:00 in the location's time zone). Only the latter pages. A booking that waits overnight becomes an info-level stuck alert, not a page.

### Mock mode shares one database with simulator runs

Simulator institutions use the `sim-*` prefix. Timer work (`tick`) ignores them when unscoped so a demo run does not pollute production monitoring. Webhook processing for a delivery scopes to that event's subdomain only.

### PGlite instead of Docker for local and CI

The quickstart should not need Docker. PGlite runs real Postgres in WASM for tests and `.data/pglite` locally; CI also runs against a Postgres service container.

### Virtual clock instead of compressing retry delays

The mock implements NexHealth's real retry schedule (30 s, 2 m, 5 m, …). Demos advance a simulated clock every 10 minutes and flush due deliveries, which is easier to follow than a ×60 compression factor and still exercises the same code paths.

## Where the docs are ambiguous

These are assumptions in the mock and reconciler; they are not facts about production.

1. **Pause and retries.** The docs say events *due* in the pause hour are skipped. The mock also skips *retries* whose `nextAttemptAt` falls inside the pause, on the theory that nothing is sent during the pause.
2. **Pause counter reset.** After a pause starts, the mock resets consecutive failure count to zero. The docs do not say whether the count carries over.
3. **Timestamp tolerance.** Rejecting webhooks older than five minutes by default assumes each attempt gets a fresh `timestamp` header. If NexHealth reuses the original timestamp on retry, set `WEBHOOK_TOLERANCE_SEC=0` and dedupe on fingerprint only. `CAPTURE_WEBHOOKS_DIR` helps check this in sandbox.
4. **SyncStatus `locations: null`.** We fan out to locations previously tied to that sync source name. Polling remains authoritative.

## If I were on the API team

Small server-side changes that would make integrators' lives much easier, with a rough sense of cost.

### 1. `event_id` on webhook payloads (and optional `Idempotency-Key` on writes)

**Cost:** One UUID per delivery; store idempotency keys on write endpoints for 24 hours.

**Why:** Dedupe today requires every consumer to reverse-engineer fingerprints from `id` + `updated_at`, which breaks when those fields are missing (see payment/adjustment reference examples). An `event_id` would make "process exactly once" trivial. Idempotency-Key on `POST /appointments` would remove the need for a sidecar `client_key` table.

### 2. `failure_reason` on `*_insertion.failed` (and ideally `timed_out`)

**Cost:** Map internal sync errors to a small enum (`operatory_in_use`, `patient_not_found`, `sync_offline`, …) plus an optional detail string safe for logs.

**Why:** The [webhook guide](https://docs.nexhealth.com/docs/webhooks) says the reason is not in the payload. Integrators guess, file tickets, or call support. A code would power dashboards and safe-retry policy without PHI.

### 3. Replay skipped and exhausted deliveries from the API or portal

**Cost:** Persist delivery attempts (already partly visible as `delivery_errors`); add `POST /webhook_deliveries/{id}/replay` or a bulk "replay skipped since …" scoped by endpoint and time range.

**Why:** Skipped events [are not sent later](https://docs.nexhealth.com/docs/webhooks). Everyone builds an `updated_since` reconciler. A first-party replay would be cheaper and more complete than paging appointments.

### 4. `location_ids` (or a single `location_id`) on SyncStatus webhook `data.syncstatus`

**Cost:** Include the same `locations` array `GET /sync_status` returns, or at least the affected location ids.

**Why:** The [reference example](https://docs.nexhealth.com/reference/webhook-subscriptions) has `locations: null` while the GET schema has a `locations` array. Consumers cannot tell which site went red without fan-out heuristics or polling.

### 5. Sandbox "sync lab" mode (test clock + synthetic insertion/sync events)

**Cost:** A flag or separate sandbox institution where the API emits `appointment_insertion.*` and `sync_status_*` on a schedule or via `POST /sandbox/trigger_event`, without requiring Open Dental.

**Why:** The [sandbox doc](https://docs.nexhealth.com/docs/sandbox-and-test-mode) says there is no sync, so the failure modes integrators care about cannot be exercised with a key alone. Open Dental setup is heavy for a portfolio demo or CI. Stripe-style test clocks for sync state and write outcomes would let partners test without VMs.

## Documentation inconsistencies found (2026-11-17)

Checked against docs.nexhealth.com and `fixtures/docs/`.

| Issue | Where | What we saw |
| --- | --- | --- |
| Signature example re-serializes JSON | [Setting up webhooks](https://docs.nexhealth.com/docs/webhooks), Python sample | Step 1 says base64 the body **as received**; the sample uses `json.dumps(..., separators=(',', ':'))`, which changes bytes and breaks verification if copied literally. nexhealth-sentinel's `diagnoseSignature()` and the `forged` scenario test this. |
| Reference insertion examples lack outcomes | `payment_insertion.json`, `adjustment_insertion.json` in reference | Bare `event_name` without `.complete`/`.failed`, no `id`/`updated_at` on nested records — unlike the guide and unlike appointment insertion. Fingerprints and subscriptions do not line up. |
| Insertion events: table vs guide | Webhook subscriptions table vs guide text | Table says `*_insertion` fires on complete or failed; guide also documents `timed_out`. |
| SyncStatus webhook vs GET | Webhook example vs `GET /sync_status` | Webhook payload shows `locations: null`; GET returns `locations: [{id, name, …}]`. |
| Pause behaviour unspecified | Webhooks, pause section | Whether retries scheduled during the pause are skipped, and whether the failure counter resets after a pause, is not stated. |
| CLI README claims (not re-verified here) | Research cited a private NexHealth CLI README | Claims such as missing npm package, 24h tokens, 100 req/s could not be checked from this repo. Public auth docs describe ~1h JWT tokens and different rate limits. |

## What we intentionally did not build

- Multi-tenant auth on the dashboard (use your own gate or VPN for live mode).
- Tracking every write type (payments, adjustments, PATCH appointment flows) — only appointments through the sentinel booking API.
- Email alerts (Slack/Discord webhook optional; everything is on the dashboard).
- A queue between inbox and processor — documented as the next step for high volume in README.