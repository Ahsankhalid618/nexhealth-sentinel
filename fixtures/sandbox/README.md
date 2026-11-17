# Sandbox captures

Files here are produced by **`scripts/sandbox-smoke.ts`** (read-only API exercise) or by **`CAPTURE_WEBHOOKS_DIR`** when the app receives real webhooks.

- Patient-like fields are redacted before write.
- API keys and bearer tokens are never written.
- Review before committing; this directory may contain institution-specific shapes.

Nothing in this folder is checked in by default except this README.