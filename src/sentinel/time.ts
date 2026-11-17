/** "10:12 CST" in the location's zone. */
export function formatLocal(date: Date, timezone: string, withDate = false): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    ...(withDate ? { weekday: "short", month: "short", day: "numeric" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(date);
}

function zoneOffsetMs(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `timezone` reads `day` (YYYY-MM-DD) `time` (HH:MM). */
export function zonedInstant(day: string, time: string, timezone: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  const first = guess - zoneOffsetMs(new Date(guess), timezone);
  return new Date(guess - zoneOffsetMs(new Date(first), timezone));
}

/** YYYY-MM-DD of `date` in `timezone`. */
export function localDay(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
