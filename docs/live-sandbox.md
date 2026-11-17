# Live sandbox guide

Use this with a NexHealth **sandbox** API key.

**Verified in this repo (2026-11-18):** read-only `scripts/sandbox-smoke.ts` against the real NexHealth sandbox — **12/12 checks passed**, 0 diffs vs the published docs. Sanitized captures are committed under [`fixtures/sandbox/`](../fixtures/sandbox/).

**Not verified yet:** incoming **signed webhook** deliveries (HMAC over the raw body). Use steps 3–4 below with a public HTTPS URL and review captures before you trust production wiring.

## Prerequisites

- Sandbox key from the NexHealth developer portal.
- Node 22.12+ and pnpm 10.
- For incoming webhooks: a **public HTTPS** URL to `/api/webhooks/nexhealth` (deployed app or a tunnel such as ngrok).

## 1. Configure environment

Copy [`.env.example`](../.env.example) to `.env.local`:

```bash
NEXHEALTH_MODE=live
NEXHEALTH_API_KEY=your_sandbox_key
NEXHEALTH_BASE_URL=https://nexhealth.info
CRON_SECRET=choose_a_long_random_string
WEBHOOK_TARGET_URL=https://your-host/api/webhooks/nexhealth
```

Run migrations if you use Postgres:

```bash
DATABASE_URL=postgres://... pnpm db:migrate
```

Start the app:

```bash
pnpm dev
```

## 2. Smoke test (read-only)

Exercises auth, institutions, locations, appointments, available slots, sync status, and webhook endpoints. Writes sanitized JSON to `fixtures/sandbox/` and prints a report.

```bash
NEXHEALTH_API_KEY=... npx tsx scripts/sandbox-smoke.ts
```

Optional: `NEXHEALTH_SUBDOMAIN`, `NEXHEALTH_LOCATION_ID` if the key sees multiple institutions.

Review `fixtures/sandbox/report.json`. The smoke script redacts patient-like fields and never writes API keys or bearer tokens; re-check before committing any new run.

**Expected sandbox quirks (per docs):**

- `GET /sync_status` is often an **empty list** (no sync behind the demo practice).
- `GET /available_slots` may fail if no provider exists at the location — the script notes this.
- Only **patient_created** / **patient_updated** webhooks fire reliably without an EHR sync.

## 3. Register webhooks

```bash
NEXHEALTH_API_KEY=... \
NEXHEALTH_SUBDOMAIN=your_sandbox_subdomain \
WEBHOOK_TARGET_URL=https://your-host/api/webhooks/nexhealth \
npx tsx scripts/setup-webhooks.ts
```

This reuses or creates an endpoint, subscribes to Patient, Appointment, and SyncStatus events, and writes `NEXHEALTH_WEBHOOK_SECRET` to `.env.local` (not printed). Restart the app.

## 4. Capture a real signed event

With the app running and `NEXHEALTH_WEBHOOK_SECRET` set:

```bash
CAPTURE_WEBHOOKS_DIR=fixtures/sandbox/captures pnpm dev
```

Trigger an event (e.g. `pnpm demo:live --yes`, or create a patient in the portal). Each delivery is saved with:

- redacted payload
- verification result
- `signature_recipe` from `diagnoseSignature()` (`documented` vs `reserialized_compact_json`, etc.)

If verification fails with `documented`, check secret, raw body handling, and timestamp tolerance (`WEBHOOK_TOLERANCE_SEC`).

## 5. Demo booking through the sentinel

```bash
pnpm demo:live --yes
```

Creates a synthetic patient (should fire `patient_created`) and books via `POST /api/writes/appointments` using `CRON_SECRET`. Expect **no sync** messaging on the write unless you have connected Open Dental per [NexHealth's guide](https://docs.nexhealth.com/docs/setting-up-an-open-dental-sandbox-sync).

## 6. Cron tick in production

GitHub Actions (see `.github/workflows/cron.yml`) or manually:

```bash
curl -X POST "https://your-host/api/cron/tick" \
  -H "authorization: Bearer $CRON_SECRET"
```

## Security

- Never commit `.env.local`, captures, or smoke output that includes secrets.
- `fixtures/sandbox/captures/` is gitignored by default.
- Treat sandbox patients as disposable test data only.