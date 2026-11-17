import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "fixtures", "docs", "webhooks");

/** A fresh copy of a payload from fixtures/docs/webhooks (copied from NexHealth's public docs). */
export function loadDocFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, `${name}.json`), "utf8")) as Record<string, unknown>;
}
