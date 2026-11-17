# Sandbox captures

Files here are produced by **`scripts/sandbox-smoke.ts`** (read-only API exercise) or by **`CAPTURE_WEBHOOKS_DIR`** when the app receives real webhooks.

- Patient-like fields are redacted before write.
- API keys and bearer tokens are never written.
- Review before committing; this directory may contain institution-specific shapes.

**2026-11-18:** Captures from a real sandbox smoke run (12/12 checks in `report.json`) are checked in here to anchor mock shape tests. Webhook payload captures stay under `captures/` (gitignored).