import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Loads .env.local, then .env, without overriding variables already set. */
export function loadEnv(): void {
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

export function requireEnv(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is not set. ${hint}`);
    process.exit(1);
  }
  return value;
}

/** Sets KEY=value in .env.local, replacing an existing line. The value is never printed. */
export function setEnvLocal(key: string, value: string): void {
  const file = ".env.local";
  const existing = existsSync(file) ? readFileSync(file, "utf8").replace(/\n+$/, "") : "";
  const lines = existing ? existing.split("\n") : [];
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
}
