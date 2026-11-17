export type SyncState =
  | "healthy"
  | "expected_downtime"
  | "degraded_reads"
  | "writes_blocked"
  | "down"
  | "no_sync";

export interface OfficeHours {
  /** IANA zone of the location, e.g. "America/Chicago". */
  timezone: string;
  /** 0 = Sunday ... 6 = Saturday, in the location's zone. */
  days: number[];
  /** "HH:MM", 24h, local time. */
  open: string;
  close: string;
}

export interface SyncStatusLike {
  readStatus: "green" | "red" | null;
  writeStatus: "green" | "red" | null;
}

export const DEFAULT_OFFICE_HOURS: Omit<OfficeHours, "timezone"> = {
  days: [1, 2, 3, 4, 5],
  open: "08:00",
  close: "18:00",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localTime(date: Date, timezone: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    weekday: WEEKDAYS.indexOf(get("weekday")),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function isWithinOfficeHours(hours: OfficeHours, now: Date): boolean {
  const { weekday, minutes } = localTime(now, hours.timezone);
  return hours.days.includes(weekday) && minutes >= toMinutes(hours.open) && minutes < toMinutes(hours.close);
}

/** When today's office window opened, or null if the office is closed right now. */
export function officeOpenedAt(hours: OfficeHours, now: Date): Date | null {
  if (!isWithinOfficeHours(hours, now)) return null;
  const { minutes } = localTime(now, hours.timezone);
  const sinceOpen = minutes - toMinutes(hours.open);
  const opened = new Date(now.getTime() - sinceOpen * 60_000);
  opened.setUTCSeconds(0, 0);
  return opened;
}

/**
 * `status` is null when GET /sync_status has no entry for the location (the docs: "A location
 * with no sync behind it returns no entry"), which is the case for every sandbox demo practice.
 */
export function classifySyncState(status: SyncStatusLike | null, hours: OfficeHours, now: Date): SyncState {
  if (!status || (status.readStatus === null && status.writeStatus === null)) return "no_sync";
  const readRed = status.readStatus === "red";
  const writeRed = status.writeStatus === "red";
  if (!readRed && !writeRed) return "healthy";
  if (!isWithinOfficeHours(hours, now)) return "expected_downtime";
  if (readRed && writeRed) return "down";
  return writeRed ? "writes_blocked" : "degraded_reads";
}

/**
 * Minutes a write outage has lasted inside office hours. An outage that started overnight
 * only starts counting when the office opens.
 */
export function outageMinutesDuringOfficeHours(redSince: Date, hours: OfficeHours, now: Date): number {
  const opened = officeOpenedAt(hours, now);
  if (!opened) return 0;
  const from = Math.max(redSince.getTime(), opened.getTime());
  return Math.max(0, Math.floor((now.getTime() - from) / 60_000));
}

export function shouldAlertOnSync(
  state: SyncState,
  redSince: Date | null,
  hours: OfficeHours,
  now: Date,
  alertAfterMin: number,
): boolean {
  if (state !== "writes_blocked" && state !== "down") return false;
  if (!redSince) return false;
  return outageMinutesDuringOfficeHours(redSince, hours, now) >= alertAfterMin;
}
