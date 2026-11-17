# nexhealth-sentinel

Find out about NexHealth integration problems before the practice does.

nexhealth-sentinel sits next to an app built on the [NexHealth Synchronizer API](https://docs.nexhealth.com). It checks every webhook signature, processes each event once, follows every booking until it is actually in the practice's health record system, alerts when a sync goes down during office hours (and stays quiet when the office is just closed), and pulls back events that NexHealth skipped while your endpoint was paused.

It comes with a mock NexHealth API and a failure simulator, because the failures that matter most can't be produced in the NexHealth sandbox.

After `pnpm sim sync-down-business-hours`, open the dashboard and filter by `sim-sync-down-business-hours` for alerts and stuck writes (see [docs/demo-script.md](docs/demo-script.md) for a ~20s screen capture).

> **Unofficial.** Not affiliated with or endorsed by NexHealth. Built from NexHealth's public documentation (retrieved November 2026).
>
> **Sandbox smoke test (2026-11-18):** [`scripts/sandbox-smoke.ts`](scripts/sandbox-smoke.ts) was run against the real NexHealth sandbox — **12/12 checks passed**, 0 diffs vs the published docs. Sanitized responses live in [`fixtures/sandbox/`](fixtures/sandbox/) and drive shape contract tests for the mock. **Signed webhook delivery has not been verified live yet** (see [docs/live-sandbox.md](docs/live-sandbox.md)).

## Why

Five things the NexHealth docs say, each of which turns into a silent failure if you take the happy path:

1. **A 201 is not a booking.** "A successful response means NexHealth accepted the record. It is not in the health record system yet." ([How a write reaches the health record system](https://docs.nexhealth.com/docs/how-a-write-reaches-the-ehr))
2. **Webhooks have no event ID.** "Payloads carry no event ID. Each event is sent once. It is sent again only when your endpoint does not answer with a `2xx`." A timeout on your side means the same event twice. ([Setting up webhooks](https://docs.nexhealth.com/docs/webhooks))
3. **Skipped events are gone.** After more than 10 failed attempts in a row, NexHealth pauses the endpoint for an hour. "Events due in that hour are marked `skipped` and are not sent later." ([Setting up webhooks](https://docs.nexhealth.com/docs/webhooks))
4. **Failures don't say why, and aren't retried.** "The reason for a failure is not in the payload." "NexHealth does not retry a failed write automatically. Before you send it again, read the original record and confirm that `foreign_id` is still `null`." ([webhooks](https://docs.nexhealth.com/docs/webhooks), [writes](https://docs.nexhealth.com/docs/how-a-write-reaches-the-ehr))
5. **The sandbox can't show any of this.** "There is no health record system behind the demo practice and no sync", so no insertion or sync events fire there. ([Sandbox and test mode](https://docs.nexhealth.com/docs/sandbox-and-test-mode))

## Quickstart (60 seconds, no API key)

Needs Node 22.12+ and pnpm 10. No Docker: the database is [PGlite](https://pglite.dev), a real Postgres compiled to WebAssembly, stored in `.data/`.

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000 and click a scenario, or from another terminal:

```bash
pnpm sim sync-down-business-hours
pnpm sim all
```

Each scenario prints a timeline and the checks it passed, and the dashboard shows what the sentinel recorded. `pnpm sim <name> --local` runs a scenario without the app, against a throwaway in-memory database.

## What it does

| Guarantee | How |
| --- | --- |
| Only NexHealth can post events | HMAC-SHA256 over `timestamp + "." + base64(raw body)`, compared in constant time, over the bytes exactly as received. Stale timestamps are rejected (5 minutes by default). Rejections are logged without the body. |
| Each event is processed once | No event IDs, so events are fingerprinted on subdomain, event name and each record's `id` + `updated_at` (`delivery_errors` excluded, so a retry matches the original). The fingerprint column is `UNIQUE`; repeats are counted, not processed. |
| A booking is followed until it's in the EHR | Bookings sent through the sentinel are tracked `requested → accepted → complete`, or `failed`, `timed_out`, `stuck`, `rejected`. Insertion webhooks move them; a timer reads back `foreign_id` on any that wait too long. A client key makes booking requests idempotent. |
| Retrying never double-books | Safe-retry reads the appointment back first and resends only if `foreign_id` is still `null`. When the original POST got no answer, it searches by patient and start time before sending again. |
| Sync outages page you only when it matters | Sync status comes from webhooks with `GET /sync_status` polled as a backstop. A red sync outside office hours (per location, in the location's time zone) is "expected downtime". Writes blocked for 30 minutes inside office hours raise a critical alert. A location with no sync is flagged: bookings there never reach an EHR. |
| Skipped events come back | A reconciler pages through `GET /appointments?updated_since=…&sort=updated_at` every tick and counts any change no webhook delivered. |
| A dead endpoint doesn't stay dead quietly | A watchdog checks the endpoint and each subscription for `active: false` and says exactly which PATCH calls fix it (subscriptions stay inactive after the endpoint is re-activated). |

Alerts are deduplicated. Sync, stuck-write and endpoint alerts resolve themselves when the problem clears. Critical and warning alerts can go to a Slack or Discord incoming webhook (`ALERT_WEBHOOK_URL`); the text never contains patient data.

## Scenarios

All run against the mock on a simulated clock, through the same inbox, state machine and monitors that handle real traffic. Each run replaces the previous run of the same scenario (institution `sim-<scenario>`).

| `pnpm sim …` | What happens | What you should see |
| --- | --- | --- |
| `happy` | Booking accepted (201), written by the sync, confirmed by `appointment_insertion.complete`. The same request is sent again. | Write `complete` with a `foreign_id`; the replay sends nothing; 1 event; no alerts. |
| `duplicate-retry` | Our 200 is lost twice, so NexHealth sends the same insertion event three times (now, +30 s, +2 min). | 1 event stored, 2 duplicates counted, write applied once. |
| `failed-write` | `appointment_insertion.failed` arrives. Safe-retry reads it back and resends; a second safe-retry is refused. | Original `failed` and linked to the retry; retry `complete`; 1 warning alert; 2 appointments at NexHealth, not 3. |
| `timed-out` | The sync doesn't reach a same-day booking before its start time. Resent for a later slot. | Original `timed_out`, resend `complete`, 1 warning alert. |
| `office-closed` | Los Angeles office. Server off at 7:30 PM, back at 7:30 AM. An online booking comes in overnight. | State `expected downtime`; 0 paging alerts; the booking shows as waiting (info) and completes in the morning. |
| `sync-down-business-hours` | Chicago office. Server drops at 10:12 AM; a booking at 10:15; back at 11:05. | Preflight warns the booking will wait; at 10:50 a critical sync alert and the write turns `stuck` with a critical alert; at 11:06 it completes and both alerts resolve. |
| `paused-endpoint-gap` | Our endpoint returns 503 at 10:00. 11 front-desk changes fail to deliver, NexHealth pauses the endpoint, 4 new bookings are skipped. | 0 webhooks received, 15 deliveries skipped, the reconciler recovers all 15, gap alert. |
| `forged` | Wrong secret, a 10-minute-old replay, and a body re-serialized before verifying. | 3 rejections (`bad_signature`, `stale_timestamp`, `bad_signature`), 0 events stored. |

Patient names in the mock are invented ("Avery Testcase"); only initials are stored.

## Using it with your integration

**As a service.** Deploy it (below), register `https://<host>/api/webhooks/nexhealth` as a NexHealth webhook endpoint (`pnpm setup:webhooks` does this), and send bookings through it so they're tracked:

```bash
curl -X POST https://<host>/api/writes/appointments \
  -H "authorization: Bearer $CRON_SECRET" -H "content-type: application/json" \
  -d '{"clientKey":"booking-123","subdomain":"my-practice","locationId":101,
       "appointment":{"patient_id":1,"provider_id":2,"start_time":"2026-12-01T15:00:00Z"}}'
```

The response says whether the sync can take writes right now (`preflight`). `POST /api/writes/<id>/safe-retry` resends a failed or timed-out write only after reading it back.

**As a library.** `src/core/` has no framework or database imports. The part most integrations get wrong is the signature check; in a Next.js route it looks like this:

```ts
import { verifySignature } from "@/core/signature";
import { normalizeEvent } from "@/core/normalize";
import { fingerprint } from "@/core/fingerprint";

export async function POST(req: Request) {
  const raw = Buffer.from(await req.arrayBuffer()); // not req.json(): the signature covers these exact bytes
  const check = verifySignature(raw, req.headers.get("timestamp"), req.headers.get("signature"), process.env.NEXHEALTH_WEBHOOK_SECRET!);
  if (!check.ok) return new Response(check.reason, { status: 401 });

  const event = normalizeEvent(JSON.parse(raw.toString("utf8")));
  const key = fingerprint(event); // store with a UNIQUE constraint; skip if it already exists
  // ... enqueue `event` and answer quickly
  return new Response("ok");
}
```

With Express, use `express.raw({ type: "application/json" })` on that route so the body stays a `Buffer`.

## Live sandbox

With a sandbox key (details in [docs/live-sandbox.md](docs/live-sandbox.md)):

```bash
# read-only: checks auth, versioning, appointments, availability, sync status and webhook endpoints
# against what the docs say, and saves redacted responses to fixtures/sandbox/
NEXHEALTH_API_KEY=... npx tsx scripts/sandbox-smoke.ts

# register this app as a webhook endpoint and subscribe it (saves the secret to .env.local)
NEXHEALTH_API_KEY=... NEXHEALTH_SUBDOMAIN=... WEBHOOK_TARGET_URL=https://<public-host>/api/webhooks/nexhealth pnpm setup:webhooks

# with the app running in live mode: create a synthetic patient (fires patient_created) and book through the sentinel
pnpm demo:live --yes
```

The sandbox has no sync, so a booking there is reported as "No sync behind this location". To see real insertion events, the docs describe [connecting a free Open Dental demo](https://docs.nexhealth.com/docs/setting-up-an-open-dental-sandbox-sync) to the sandbox.

## Deploying

Vercel + [Neon](https://neon.tech) Postgres + a GitHub Actions schedule:

1. Create a Neon database and run `DATABASE_URL=postgres://... pnpm db:migrate`.
2. Import the repo in Vercel and set `DATABASE_URL`, `CRON_SECRET`, and for live mode `NEXHEALTH_MODE=live`, `NEXHEALTH_API_KEY`, `NEXHEALTH_WEBHOOK_SECRET`, `WEBHOOK_TARGET_URL`. See [`.env.example`](.env.example) for the rest.
3. In the GitHub repo, set the secret `CRON_SECRET` and the variable `SENTINEL_URL` (the deployed URL). [`.github/workflows/cron.yml`](.github/workflows/cron.yml) calls `/api/cron/tick` every 10 minutes (Vercel's free cron only runs daily).

Left in mock mode, a deployment is a public demo: the simulator and `/mock/*` only run when `NEXHEALTH_MODE=mock`, and live mode turns both off.

## Patient data and security

- The dashboard shows initials only. Stored payloads have names, contact details, birth dates, addresses and notes replaced with `[redacted]`, and are dropped after 7 days; the normalized event (ids, timestamps, initials) is kept.
- Booking notes are sent to NexHealth but never stored. Alert text never contains patient data.
- Rejected deliveries are logged as metadata only: reason, claimed subdomain and event, body size and hash.
- Secrets live in environment variables. `setup:webhooks` writes the webhook secret to `.env.local` (mode 600) without printing it. The smoke test refuses to write any file containing the API key or token.
- Signatures are compared in constant time. The write and tick endpoints need `Authorization: Bearer $CRON_SECRET` in live mode. The dashboard has no login: don't expose a live-mode deployment publicly without putting it behind your own auth.
- This is a monitoring tool, not a system of record. Don't use it with production patient data unless you have a BAA covering where it runs.

## Limitations

- The mock follows the docs, not NexHealth's private behaviour. Where the docs are ambiguous it makes a choice, written down in [DESIGN.md](DESIGN.md#where-the-docs-are-ambiguous). `pnpm contract:check` compares its routes with the published OpenAPI definitions.
- Only appointments booked through the sentinel are tracked. Patient, payment and adjustment writes, and `PATCH /appointments` changes, are not.
- The reconciler covers appointments, in a window of 30 days back to 120 days ahead.
- The 5-minute timestamp window assumes NexHealth stamps each delivery attempt with the time it is sent; the docs don't say. If real retries arrive with their original timestamp, set `WEBHOOK_TOLERANCE_SEC=0`. The capture option in the live guide shows which it is.
- Processing runs right after the 200, plus on the tick. A high-volume deployment would want a real queue.

## Development

```bash
pnpm test            # unit + integration (all scenarios against PGlite)
pnpm test:coverage   # src/core must stay above 90%
pnpm lint && pnpm typecheck && pnpm build
pnpm contract:check  # mock vs docs.nexhealth.com OpenAPI pages
```

`TEST_DATABASE_URL=postgres://...` runs the integration tests against a real Postgres instead (CI does both).

```
src/core/       signature, normalizer, fingerprint, write state machine, sync classifier, redaction (pure TS)
src/nexhealth/  API client: token refresh, retry on 401 and 429, ignored-parameter warnings
src/mock/       mock NexHealth API: auth, versioning, pagination, writes, signed webhook delivery with retries, pause and deactivation
src/sentinel/   inbox, event processing, tracked writes, sync monitor, watchdog, reconciler, tick
src/sim/        simulated practices on a virtual clock, and the eight scenarios
src/app/        Next.js routes and dashboard
scripts/        sim, sandbox smoke test, webhook setup, live demo, contract check, migrate
fixtures/docs/  webhook payload examples copied from the docs
```

[DESIGN.md](DESIGN.md) has the decisions behind this, five things NexHealth could add server-side, and the doc inconsistencies found along the way. [docs/demo-script.md](docs/demo-script.md) is a two-minute walkthrough.

## License

MIT. Unofficial; not affiliated with NexHealth.
