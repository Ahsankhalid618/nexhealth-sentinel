import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { alerts, events, reconcileCursors, rejectedDeliveries, resourceVersions, syncHealth, writes } from "@/db/schema";
import { MOCK_API_KEY, MockNexHealth } from "@/mock/nexhealth-mock";
import { NexHealthClient } from "@/nexhealth/client";
import { loadConfig, MOCK_WEBHOOK_SECRET, type SentinelConfig } from "@/sentinel/config";
import type { NewAlert, SentinelContext } from "@/sentinel/context";
import { receiveWebhook } from "@/sentinel/inbox";
import { processPendingEvents } from "@/sentinel/process";
import { discoverLocations } from "@/sentinel/sync-monitor";
import { runTick } from "@/sentinel/tick";
import { formatLocal, zonedInstant } from "@/sentinel/time";
import { createTrackedAppointment, type BookingResult } from "@/sentinel/writes";

const MIN = 60_000;
export const DEMO_TARGET_URL = "https://sentinel.example/api/webhooks/nexhealth";
export const DEMO_PROVIDER_ID = 415858;
export const DEMO_SYNC = "GreenValley-Server-01";

export interface WorldOptions {
  db: Db;
  scenario: string;
  timezone: string;
  /** Local calendar day the scenario starts on (YYYY-MM-DD). */
  day: string;
  /** Local wall-clock start time (HH:MM). */
  start: string;
  config?: Partial<SentinelConfig>;
  /** Practice data that exists before monitoring starts (it ends up in the reconcile baseline). */
  beforeStart?: (world: DemoWorld) => void;
}

export interface TimelineEntry {
  at: string;
  text: string;
}

/**
 * One simulated practice: a mock NexHealth with its own virtual clock, wired to the real
 * sentinel code. Webhooks are signed by the mock and go through the same inbox as production.
 */
export class DemoWorld {
  readonly subdomain: string;
  readonly mock: MockNexHealth;
  readonly ctx: SentinelContext;
  readonly timeline: TimelineEntry[] = [];
  readonly notified: NewAlert[] = [];
  /** "down" answers 503; with loseResponses > 0 the event is stored but the 200 never reaches NexHealth. */
  endpointMode: "up" | "down" = "up";
  loseResponses = 0;
  readonly locationId = 101;
  private clock: Date;
  private nextTickAt: number;
  private bookings = 0;

  private constructor(private readonly options: WorldOptions) {
    this.subdomain = `sim-${options.scenario}`;
    this.clock = zonedInstant(options.day, options.start, options.timezone);
    this.nextTickAt = (Math.floor(this.clock.getTime() / (10 * MIN)) + 1) * 10 * MIN;
    const now = () => new Date(this.clock);
    this.mock = new MockNexHealth(now);
    const config: SentinelConfig = {
      ...loadConfig({ NEXHEALTH_MODE: "mock" }),
      webhookSecret: MOCK_WEBHOOK_SECRET,
      ...options.config,
    };
    this.ctx = {
      db: options.db,
      nex: new NexHealthClient({
        apiKey: MOCK_API_KEY,
        baseUrl: "https://nexhealth.mock",
        fetch: this.mock.fetch,
        now,
        sleep: async () => {},
      }),
      config,
      now,
      notify: async (alert) => {
        this.notified.push(alert);
      },
      scope: this.subdomain,
    };
  }

  static async create(options: WorldOptions): Promise<DemoWorld> {
    const world = new DemoWorld(options);
    await resetDemo(options.db, world.subdomain);
    world.setUpPractice();
    options.beforeStart?.(world);
    await discoverLocations(world.ctx);
    // First tick polls sync status and records the reconcile baseline.
    await runTick(world.ctx);
    return world;
  }

  private setUpPractice(): void {
    const m = this.mock;
    m.addInstitution(5000 + this.options.scenario.length, "Green Valley Dental (demo)", this.subdomain);
    m.addLocation(this.subdomain, { id: this.locationId, name: "Green Valley Dental - Main St", tz: this.options.timezone });
    m.addSync(this.subdomain, DEMO_SYNC, [this.locationId]);
    const endpoint = m.registerEndpoint(DEMO_TARGET_URL, this.ctx.config.webhookSecret!);
    for (const event of ["appointment_insertion", "appointment_created", "appointment_updated"]) {
      m.subscribe(endpoint.id, this.subdomain, "Appointment", event);
    }
    m.subscribe(endpoint.id, this.subdomain, "SyncStatus", "sync_status_write_change");
    m.subscribe(endpoint.id, this.subdomain, "SyncStatus", "sync_status_read_change");
    m.transport = async ({ headers, body }) => {
      if (this.endpointMode === "down") return 503;
      const result = await receiveWebhook(this.ctx, {
        rawBody: Buffer.from(body),
        timestamp: headers.timestamp ?? null,
        signature: headers.signature ?? null,
      });
      if (result.status === 200) await processPendingEvents(this.ctx);
      if (this.loseResponses > 0) {
        this.loseResponses--;
        return 0;
      }
      return result.status;
    };
  }

  now(): Date {
    return new Date(this.clock);
  }

  /** Wall-clock time in the practice's zone, on the start day plus `dayOffset`. */
  at(time: string, dayOffset = 0): Date {
    const start = zonedInstant(this.options.day, "12:00", this.options.timezone);
    const day = new Date(start.getTime() + dayOffset * 24 * 60 * MIN).toISOString().slice(0, 10);
    return zonedInstant(day, time, this.options.timezone);
  }

  local(date: Date = this.clock, withDate = false): string {
    return formatLocal(date, this.options.timezone, withDate);
  }

  log(text: string): void {
    this.timeline.push({ at: this.local(), text });
  }

  /** Move the clock forward, delivering webhooks and running the cron tick on the way, like production would. */
  async advanceTo(target: Date, tickEveryMin = 10): Promise<void> {
    if (target.getTime() < this.clock.getTime()) throw new Error("the clock only moves forward");
    for (;;) {
      await this.mock.runDueDeliveries();
      if (this.clock.getTime() >= target.getTime()) break;
      const next = Math.min(target.getTime(), this.nextTickAt, this.mock.nextDeliveryAt() ?? Infinity);
      this.clock = new Date(next);
      if (next === this.nextTickAt) {
        await this.mock.runDueDeliveries();
        const report = await runTick(this.ctx);
        if (report.errors.length) throw new Error(`tick failed: ${report.errors.join("; ")}`);
        this.nextTickAt += tickEveryMin * MIN;
      }
    }
  }

  async advanceBy(minutes: number, tickEveryMin = 10): Promise<void> {
    await this.advanceTo(new Date(this.clock.getTime() + minutes * MIN), tickEveryMin);
  }

  /** Deliver whatever the mock has queued for right now. */
  async deliver(): Promise<void> {
    await this.mock.runDueDeliveries();
  }

  async book(start: Date, patientName: string, clientKey?: string): Promise<BookingResult> {
    this.bookings++;
    return createTrackedAppointment(this.ctx, {
      clientKey: clientKey ?? `${this.subdomain}-booking-${this.bookings}`,
      subdomain: this.subdomain,
      locationId: this.locationId,
      patientName,
      appointment: {
        patient_id: 4100 + this.bookings,
        provider_id: DEMO_PROVIDER_ID,
        start_time: start.toISOString(),
        end_time: new Date(start.getTime() + 30 * MIN).toISOString(),
      },
    });
  }
}

/** Removes everything a previous run of this demo left behind. Live data is never touched. */
export async function resetDemo(db: Db, subdomain: string): Promise<void> {
  if (!subdomain.startsWith("sim-")) throw new Error("only sim-* institutions can be reset");
  const ids = (await db.select({ id: writes.id }).from(writes).where(eq(writes.subdomain, subdomain))).map((r) => r.id);
  if (ids.length) await db.delete(writes).where(inArray(writes.id, ids));
  await db.delete(events).where(eq(events.subdomain, subdomain));
  await db.delete(syncHealth).where(eq(syncHealth.subdomain, subdomain));
  await db.delete(resourceVersions).where(eq(resourceVersions.subdomain, subdomain));
  await db.delete(reconcileCursors).where(eq(reconcileCursors.subdomain, subdomain));
  await db.delete(alerts).where(eq(alerts.subdomain, subdomain));
  await db.delete(rejectedDeliveries).where(eq(rejectedDeliveries.claimedSubdomain, subdomain));
}
