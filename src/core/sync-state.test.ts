import { describe, expect, it } from "vitest";
import {
  DEFAULT_OFFICE_HOURS,
  classifySyncState,
  isWithinOfficeHours,
  localTime,
  officeOpenedAt,
  outageMinutesDuringOfficeHours,
  shouldAlertOnSync,
  type OfficeHours,
} from "./sync-state";

const NY: OfficeHours = { ...DEFAULT_OFFICE_HOURS, timezone: "America/New_York" };
const LA: OfficeHours = { ...DEFAULT_OFFICE_HOURS, timezone: "America/Los_Angeles" };
const KHI: OfficeHours = { days: [1, 2, 3, 4, 5, 6], open: "09:00", close: "17:00", timezone: "Asia/Karachi" };

// Tuesday 2026-11-17. New York is UTC-5 in November, Los Angeles UTC-8, Karachi UTC+5.
const TUE_1512_UTC = new Date("2026-11-17T15:12:00Z"); // 10:12 NY, 07:12 LA, 20:12 Karachi
const SAT_1512_UTC = new Date("2026-11-21T15:12:00Z");

const red = { readStatus: "green", writeStatus: "red" } as const;

describe("office hours", () => {
  it("reads local weekday and time in the location's zone", () => {
    expect(localTime(TUE_1512_UTC, "America/New_York")).toEqual({ weekday: 2, minutes: 10 * 60 + 12 });
    expect(localTime(TUE_1512_UTC, "Asia/Karachi")).toEqual({ weekday: 2, minutes: 20 * 60 + 12 });
  });

  it("is open in New York but not yet in Los Angeles or still in Karachi at the same instant", () => {
    expect(isWithinOfficeHours(NY, TUE_1512_UTC)).toBe(true);
    expect(isWithinOfficeHours(LA, TUE_1512_UTC)).toBe(false);
    expect(isWithinOfficeHours(KHI, TUE_1512_UTC)).toBe(false);
  });

  it("is closed on a weekend by default, but Saturday counts where configured", () => {
    expect(isWithinOfficeHours(NY, SAT_1512_UTC)).toBe(false);
    expect(isWithinOfficeHours(KHI, new Date("2026-11-21T06:00:00Z"))).toBe(true);
  });

  it("treats close time as exclusive", () => {
    expect(isWithinOfficeHours(NY, new Date("2026-11-17T22:59:00Z"))).toBe(true);
    expect(isWithinOfficeHours(NY, new Date("2026-11-17T23:00:00Z"))).toBe(false);
  });

  it("knows when today's window opened", () => {
    expect(officeOpenedAt(NY, TUE_1512_UTC)?.toISOString()).toBe("2026-11-17T13:00:00.000Z");
    expect(officeOpenedAt(LA, TUE_1512_UTC)).toBeNull();
  });
});

describe("classifySyncState", () => {
  it("flags a location with no sync at all", () => {
    expect(classifySyncState(null, NY, TUE_1512_UTC)).toBe("no_sync");
    expect(classifySyncState({ readStatus: null, writeStatus: null }, NY, TUE_1512_UTC)).toBe("no_sync");
  });

  it("is healthy when both are green, day or night", () => {
    const green = { readStatus: "green", writeStatus: "green" } as const;
    expect(classifySyncState(green, NY, TUE_1512_UTC)).toBe("healthy");
    expect(classifySyncState(green, NY, SAT_1512_UTC)).toBe("healthy");
  });

  it("separates the four red combinations during office hours", () => {
    expect(classifySyncState({ readStatus: "red", writeStatus: "red" }, NY, TUE_1512_UTC)).toBe("down");
    expect(classifySyncState(red, NY, TUE_1512_UTC)).toBe("writes_blocked");
    expect(classifySyncState({ readStatus: "red", writeStatus: "green" }, NY, TUE_1512_UTC)).toBe("degraded_reads");
  });

  it("calls any red outside office hours expected downtime", () => {
    expect(classifySyncState({ readStatus: "red", writeStatus: "red" }, NY, SAT_1512_UTC)).toBe("expected_downtime");
    expect(classifySyncState(red, LA, TUE_1512_UTC)).toBe("expected_downtime");
  });
});

describe("sync alerting", () => {
  it("counts only the part of an outage inside office hours", () => {
    const overnight = new Date("2026-11-17T02:00:00Z"); // 21:00 Monday in New York
    expect(outageMinutesDuringOfficeHours(overnight, NY, TUE_1512_UTC)).toBe(2 * 60 + 12);
    const sinceTen = new Date("2026-11-17T15:00:00Z");
    expect(outageMinutesDuringOfficeHours(sinceTen, NY, TUE_1512_UTC)).toBe(12);
    expect(outageMinutesDuringOfficeHours(sinceTen, LA, TUE_1512_UTC)).toBe(0);
  });

  it("alerts once writes have been blocked for the threshold during office hours", () => {
    const since = new Date("2026-11-17T14:42:00Z"); // 09:42 New York, 30 minutes earlier
    expect(shouldAlertOnSync("writes_blocked", since, NY, TUE_1512_UTC, 30)).toBe(true);
    expect(shouldAlertOnSync("writes_blocked", since, NY, TUE_1512_UTC, 31)).toBe(false);
    expect(shouldAlertOnSync("down", since, NY, TUE_1512_UTC, 30)).toBe(true);
  });

  it("never alerts for expected downtime, degraded reads, healthy or unknown start", () => {
    const since = new Date("2026-11-17T10:00:00Z");
    expect(shouldAlertOnSync("expected_downtime", since, NY, TUE_1512_UTC, 30)).toBe(false);
    expect(shouldAlertOnSync("degraded_reads", since, NY, TUE_1512_UTC, 30)).toBe(false);
    expect(shouldAlertOnSync("healthy", since, NY, TUE_1512_UTC, 30)).toBe(false);
    expect(shouldAlertOnSync("writes_blocked", null, NY, TUE_1512_UTC, 30)).toBe(false);
  });
});
