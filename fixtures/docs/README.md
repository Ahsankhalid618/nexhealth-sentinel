# Fixtures derived from NexHealth's public docs

Every JSON file in `webhooks/` is a copy of an example payload published in NexHealth's
documentation. None of them came from a real API call. They were retrieved on 2026-11-17.

| File | Source |
| --- | --- |
| `webhooks/guide_appointment_insertion_with_delivery_errors.json` | [Setting up webhooks](https://docs.nexhealth.com/docs/webhooks), "Event messages" (inline `//` comments removed) |
| all other `webhooks/*.json` | [Webhook subscriptions reference](https://docs.nexhealth.com/reference/webhook-subscriptions), the example payload for the event of the same name |

The names, emails and phone numbers in these files are NexHealth's own sample values, not
real patients.

Real sandbox responses go in [`../sandbox/`](../sandbox/), written by `scripts/sandbox-smoke.ts`.
