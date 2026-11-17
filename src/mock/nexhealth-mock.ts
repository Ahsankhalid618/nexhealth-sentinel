import { randomBytes } from "node:crypto";
import { computeSignature } from "@/core/signature";
import type { Appointment, Institution, Location, SyncStatusEntry, WebhookEndpoint, WebhookSubscription } from "@/nexhealth/types";

/**
 * An in-memory stand-in for the NexHealth Synchronizer API, built from the public docs only.
 * It is not NexHealth's implementation: where the docs are silent, the choice made here is
 * marked "assumption".
 */

export const MOCK_API_KEY = "mock-api-key";
export const ACCEPTED_VERSIONS = ["v3.0.0", "v20240412"];

const MIN = 60_000;
/** docs/webhooks "Retries and failing endpoints": 7 retries over about 11 hours. */
export const RETRY_DELAYS_MS = [0.5 * MIN, 2 * MIN, 5 * MIN, 15 * MIN, 60 * MIN, 180 * MIN, 420 * MIN];
/** "After more than 10 failed attempts in a row, NexHealth stops sending to the endpoint for 60 minutes." */
export const PAUSE_AFTER_FAILURES = 10;
export const PAUSE_MS = 60 * MIN;
/** "...the last 100 finished deliveries to the endpoint (successful or failed) all failed..." */
export const DEACTIVATE_AFTER_FAILURES = 100;
/** interpreting-sync-status: write_status turns red after 25 minutes, read_status after 150. */
const WRITE_RED_AFTER_MS = 25 * MIN;
const READ_RED_AFTER_MS = 150 * MIN;

export const SUBSCRIBABLE: Record<string, string[]> = {
  Appointment: ["appointment_insertion", "appointment_created", "appointment_updated", "appointment_requested"],
  Patient: ["patient_created", "patient_updated"],
  SyncStatus: ["sync_status_read_change", "sync_status_write_change"],
};

export type Transport = (req: { url: string; headers: Record<string, string>; body: string }) => Promise<number>;

interface MockSync {
  subdomain: string;
  entry: Omit<SyncStatusEntry, "locations">;
  locationIds: number[];
}

interface MockProvider {
  subdomain: string;
  id: number;
  name: string;
  location_id: number;
}

interface MockAppointment extends Appointment {
  subdomain: string;
  pendingInsertion: boolean;
  foreign_id_type?: string | null;
  provider_name?: string;
  appointment_type_id?: number | null;
  confirmed?: boolean;
  note?: string | null;
  misc?: Record<string, unknown>;
}

/** Extra fields stored on locations for GET /locations (full) vs GET /institutions (slim). */
interface MockLocation extends Location {
  city?: string | null;
  state?: string | null;
  street_address?: string | null;
  street_address_2?: string | null;
  zip_code?: string | null;
  email?: string | null;
  phone_number?: string | null;
  foreign_id?: string;
  last_sync_time?: string | null;
  created_at?: string;
  updated_at?: string;
  latitude?: number | null;
  longitude?: number | null;
  appt_types_map_by_operatory?: boolean;
  set_availability_by_operatory?: boolean;
  specialty?: string | null;
  wlogo?: string;
  weight?: number;
  country_code?: string | null;
}

interface MockInstitution extends Institution {
  created_at?: string;
  updated_at?: string;
  emrs?: string[];
  country_code?: string;
  locations: MockLocation[];
}

export interface Delivery {
  id: number;
  endpointId: number;
  eventName: string;
  payload: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: number;
  status: "pending" | "delivered" | "failed" | "skipped";
  errors: Array<{ code: string; timestamp: string; message: string; attempts: number }>;
}

interface EndpointHealth {
  consecutiveFailures: number;
  pausedUntil: number | null;
  pauses: number;
  finished: boolean[];
}

interface Route {
  method: string;
  path: string;
  query: string[];
  required: string[];
  forbiddenBodyKeys?: string[];
  auth?: false;
  handler: (ctx: RouteContext) => Response | Promise<Response>;
}

interface RouteContext {
  headers: Headers;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const fail = (status: number, ...errors: string[]) => json(status, { code: false, description: null, error: errors, data: null });

const PATIENT_NAMES = ["Avery Testcase", "Jordan Sample", "Riley Mockwell", "Casey Fixture", "Morgan Demo"];

export class MockNexHealth {
  readonly institutions: MockInstitution[] = [];
  readonly providers: MockProvider[] = [];
  readonly syncs: MockSync[] = [];
  readonly appointments = new Map<number, MockAppointment>();
  readonly endpoints: WebhookEndpoint[] = [];
  readonly subscriptions: Array<WebhookSubscription & { subdomain: string }> = [];
  readonly deliveries: Delivery[] = [];
  readonly endpointHealth = new Map<number, EndpointHealth>();
  /** The next N authenticated requests answer 429 with Retry-After: 1. */
  rateLimitNext = 0;
  transport: Transport | null = null;

  private readonly tokens = new Map<string, number>();
  private ids = { appointment: 900_000, endpoint: 1, subscription: 1, delivery: 1, provider: 500_000 };
  private sampleApptId: number | null = null;

  constructor(
    private readonly now: () => Date,
    private readonly apiKey = MOCK_API_KEY,
  ) {}

  // ---- world setup ------------------------------------------------------------------------

  addInstitution(id: number, name: string, subdomain: string): MockInstitution {
    const at = this.now().toISOString();
    const inst: MockInstitution = {
      id,
      name,
      subdomain,
      locations: [],
      created_at: at,
      updated_at: at,
      emrs: ["dentrix"],
      country_code: "US",
    };
    this.institutions.push(inst);
    return inst;
  }

  addProvider(subdomain: string, fields: { id?: number; name: string; location_id: number }): MockProvider {
    const provider: MockProvider = {
      subdomain,
      id: fields.id ?? ++this.ids.provider,
      name: fields.name,
      location_id: fields.location_id,
    };
    this.providers.push(provider);
    return provider;
  }

  addLocation(subdomain: string, loc: { id: number; name: string; tz: string } & Partial<MockLocation>): MockLocation {
    const inst = this.institution(subdomain);
    const at = this.now().toISOString();
    const location: MockLocation = {
      ...loc,
      institution_id: inst.id,
      foreign_id: loc.foreign_id ?? "0",
      foreign_id_type: loc.foreign_id_type ?? `remote_db-dentrix-DataSource-${inst.id}`,
      insert_appt_client: true,
      map_by_operatory: true,
      inactive: false,
      city: loc.city ?? "New York",
      state: loc.state ?? "NY",
      street_address: loc.street_address ?? "123 Demo Street",
      street_address_2: loc.street_address_2 ?? null,
      zip_code: loc.zip_code ?? "10001",
      email: loc.email ?? "office@demo.example",
      phone_number: loc.phone_number ?? "5555550100",
      created_at: at,
      updated_at: at,
      last_sync_time: null,
      latitude: loc.latitude ?? -39.40035768049127,
      longitude: loc.longitude ?? -69.91424997794276,
      appt_types_map_by_operatory: false,
      set_availability_by_operatory: false,
      specialty: null,
      wlogo: "/missing.png",
      weight: 1,
      country_code: null,
    };
    inst.locations.push(location);
    return location;
  }

  /** Practice shaped like the real sandbox captures (no sync, dentrix foreign_id_type, last_sync_time null). */
  seedSandboxPractice(): void {
    const sub = "eds-solutions-demo-practice";
    this.addInstitution(24796, "EDS Solutions Demo Practice", sub);
    const loc = this.addLocation(sub, { id: 361105, name: "Green River Dental", tz: "America/New_York" });
    const provider = this.addProvider(sub, { id: 541159954, name: "Demo Provider", location_id: loc.id });
    const synced = this.seedAppointment(sub, {
      location_id: loc.id,
      provider_id: provider.id,
      provider_name: provider.name,
      operatory_id: 325732,
      start_time: "2026-11-26T19:15:00.000Z",
      end_time: "2026-11-26T20:00:00.000Z",
      foreign_id: "a44fca72-e720-415e-815d-28a25c897eb5",
      foreign_id_type: loc.foreign_id_type,
      appointment_type_id: 1289111,
    });
    this.seedAppointment(sub, {
      location_id: loc.id,
      provider_id: provider.id,
      provider_name: provider.name,
      operatory_id: 325731,
      start_time: "2026-11-13T18:30:00.000Z",
      end_time: "2026-11-13T19:15:00.000Z",
      foreign_id: null,
      foreign_id_type: "nex",
      misc: { "is_terminal": false, "has_lab_requisition_linkable?": false, "has_case_tracker_linkable?": false },
    });
    this.sampleApptId = synced.id;
  }

  sampleAppointmentId(): number {
    if (this.sampleApptId === null) throw new Error("call seedSandboxPractice first");
    return this.sampleApptId;
  }

  addSync(subdomain: string, name: string, locationIds: number[]): void {
    const at = this.now().toISOString();
    this.syncs.push({
      subdomain,
      locationIds,
      entry: {
        institution_id: this.institution(subdomain).id,
        sync_source_type: "DataSource",
        sync_source_name: name,
        emr: { id: 11, name: "dentrix", display_name: "Dentrix", type: "onprem" },
        read_status: "green",
        read_status_at: at,
        write_status: "green",
        write_status_at: at,
      },
    });
  }

  seedAppointment(
    subdomain: string,
    fields: Partial<Omit<MockAppointment, "id" | "subdomain" | "pendingInsertion">> & { location_id: number; start_time: string },
  ): MockAppointment {
    const id = ++this.ids.appointment;
    const at = this.now().toISOString();
    const loc = this.institution(subdomain).locations.find((l) => l.id === fields.location_id);
    const foreignId =
      fields.foreign_id !== undefined
        ? fields.foreign_id
        : `${id.toString(16).padStart(8, "0")}-demo-0000-0000-000000000000`;
    const foreignType =
      fields.foreign_id_type ??
      (fields.foreign_id === null ? "nex" : (loc?.foreign_id_type ?? "remote_db-dentrix-DataSource-1"));
    const appt: MockAppointment = {
      ...fields,
      id,
      patient_id: fields.patient_id ?? 4000 + (id % 1000),
      provider_id: fields.provider_id ?? 415858,
      provider_name: fields.provider_name ?? this.providerName(subdomain, fields.provider_id ?? 415858),
      operatory_id: fields.operatory_id ?? null,
      end_time: fields.end_time ?? null,
      foreign_id: foreignId,
      foreign_id_type: foreignType,
      last_sync_time: null,
      created_at: fields.created_at ?? at,
      updated_at: fields.updated_at ?? at,
      cancelled: fields.cancelled ?? false,
      appointment_type_id: fields.appointment_type_id ?? null,
      misc: fields.misc ?? {},
      subdomain,
      pendingInsertion: false,
    };
    this.appointments.set(id, appt);
    return appt;
  }

  // ---- practice-side behaviour --------------------------------------------------------------

  /** Flip a sync's statuses and fire the matching SyncStatus webhooks, shaped like the docs' example. */
  setSyncStatus(subdomain: string, syncName: string, change: { read?: "green" | "red"; write?: "green" | "red" }): void {
    const sync = this.syncs.find((s) => s.subdomain === subdomain && s.entry.sync_source_name === syncName);
    if (!sync) throw new Error(`no sync ${syncName}`);
    const now = this.now().getTime();
    const fired: string[] = [];
    if (change.write && change.write !== sync.entry.write_status) {
      sync.entry.write_status = change.write;
      sync.entry.write_status_at = new Date(change.write === "red" ? now - WRITE_RED_AFTER_MS : now).toISOString();
      fired.push(`sync_status_write_change.${change.write}`);
    }
    if (change.read && change.read !== sync.entry.read_status) {
      sync.entry.read_status = change.read;
      sync.entry.read_status_at = new Date(change.read === "red" ? now - READ_RED_AFTER_MS : now).toISOString();
      fired.push(`sync_status_read_change.${change.read}`);
    }
    for (const eventName of fired) {
      this.emit(subdomain, "SyncStatus", eventName, { syncstatus: { ...sync.entry, locations: null } });
    }
  }

  /** The sync picks up queued writes for locations whose writes are green. Returns the ids written. */
  syncPendingWrites(subdomain: string): number[] {
    const written: number[] = [];
    for (const appt of this.appointments.values()) {
      if (appt.subdomain !== subdomain || !appt.pendingInsertion) continue;
      if (this.syncFor(subdomain, appt.location_id)?.entry.write_status !== "green") continue;
      appt.pendingInsertion = false;
      const loc = this.institution(subdomain).locations.find((l) => l.id === appt.location_id);
      appt.foreign_id = appt.foreign_id ?? `${appt.id.toString(16)}-mock-0000-0000-000000000000`;
      appt.foreign_id_type = loc?.foreign_id_type ?? appt.foreign_id_type ?? "remote_db-dentrix-DataSource-1";
      appt.updated_at = this.now().toISOString();
      this.emit(subdomain, "Appointment", "appointment_insertion.complete", { appointment: this.publicAppt(appt) });
      written.push(appt.id);
    }
    return written;
  }

  failPendingWrite(id: number): void {
    const appt = this.mustPending(id);
    appt.pendingInsertion = false;
    appt.updated_at = this.now().toISOString();
    this.emit(appt.subdomain, "Appointment", "appointment_insertion.failed", { appointment: this.publicAppt(appt) });
  }

  /** "The write could not reach the health record system before the start time of the appointment passed." */
  timeOutPendingWrites(subdomain: string): number[] {
    const now = this.now().getTime();
    const timedOut: number[] = [];
    for (const appt of this.appointments.values()) {
      if (appt.subdomain !== subdomain || !appt.pendingInsertion || Date.parse(appt.start_time) > now) continue;
      appt.pendingInsertion = false;
      appt.updated_at = this.now().toISOString();
      this.emit(subdomain, "Appointment", "appointment_insertion.timed_out", { appointment: this.publicAppt(appt) });
      timedOut.push(appt.id);
    }
    return timedOut;
  }

  /** A change made at the front desk, seen by the sync's read cycle. */
  changeAppointmentInEhr(id: number, changes: Partial<Appointment>): void {
    const appt = this.appointments.get(id);
    if (!appt) throw new Error(`no appointment ${id}`);
    const previous = Object.fromEntries(Object.keys(changes).map((k) => [k, appt[k as keyof Appointment]]));
    Object.assign(appt, changes, { updated_at: this.now().toISOString() });
    this.emit(appt.subdomain, "Appointment", "appointment_updated", {
      appointment: this.publicAppt(appt, true),
      previous_attributes: previous,
    });
  }

  createAppointmentInEhr(subdomain: string, fields: Partial<Appointment> & { location_id: number; start_time: string }): number {
    const appt = this.seedAppointment(subdomain, fields);
    this.emit(subdomain, "Appointment", "appointment_created", { appointments: [this.publicAppt(appt, true)] });
    return appt.id;
  }

  // ---- webhook delivery -------------------------------------------------------------------

  registerEndpoint(targetUrl: string, secretKey?: string): WebhookEndpoint {
    const at = this.now().toISOString();
    const endpoint: WebhookEndpoint = {
      id: this.ids.endpoint++,
      target_url: targetUrl,
      secret_key: secretKey ?? randomBytes(10).toString("base64url"),
      active: true,
      created_at: at,
      updated_at: at,
    };
    this.endpoints.push(endpoint);
    return endpoint;
  }

  subscribe(endpointId: number, subdomain: string, resourceType: string, event: string): WebhookSubscription {
    const at = this.now().toISOString();
    const sub = {
      id: this.ids.subscription++,
      webhook_endpoint_id: endpointId,
      institution_id: this.institution(subdomain).id,
      subdomain,
      resource_type: resourceType,
      event,
      active: true,
      created_at: at,
      updated_at: at,
    };
    this.subscriptions.push(sub);
    const { subdomain: _subdomain, ...publicFields } = sub;
    return publicFields;
  }

  emit(subdomain: string, resourceType: string, eventName: string, data: Record<string, unknown>): void {
    const base = eventName.split(".")[0];
    for (const sub of this.subscriptions) {
      const endpoint = this.endpoints.find((e) => e.id === sub.webhook_endpoint_id);
      if (!endpoint?.active || !sub.active) continue;
      if (sub.subdomain !== subdomain || sub.resource_type !== resourceType || sub.event !== base) continue;
      this.deliveries.push({
        id: this.ids.delivery++,
        endpointId: endpoint.id,
        eventName,
        payload: {
          institution_id: sub.institution_id,
          subdomain,
          webhook_subscription_id: sub.id,
          resource_type: resourceType,
          event_name: eventName,
          event_time: this.now().toISOString(),
          data,
        },
        attempts: 0,
        nextAttemptAt: this.now().getTime(),
        status: "pending",
        errors: [],
      });
    }
  }

  nextDeliveryAt(): number | null {
    const pending = this.deliveries.filter((d) => d.status === "pending").map((d) => d.nextAttemptAt);
    return pending.length ? Math.min(...pending) : null;
  }

  /** Attempt every delivery that is due now, in order. */
  async runDueDeliveries(): Promise<void> {
    const now = this.now().getTime();
    const due = this.deliveries
      .filter((d) => d.status === "pending" && d.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.id - b.id);
    for (const delivery of due) await this.attempt(delivery, now);
  }

  private async attempt(d: Delivery, now: number): Promise<void> {
    const endpoint = this.endpoints.find((e) => e.id === d.endpointId)!;
    const health = this.health(endpoint.id);
    if (!endpoint.active) {
      d.status = "skipped";
      return;
    }
    // "Events due in that hour are marked skipped and are not sent later." Assumption: this
    // includes retries that fall due during the pause, not only first attempts.
    if (health.pausedUntil !== null && now < health.pausedUntil) {
      d.status = "skipped";
      return;
    }

    d.attempts++;
    const timestamp = new Date(now).toISOString();
    const body = JSON.stringify(d.errors.length ? { ...d.payload, delivery_errors: d.errors } : d.payload);
    const headers = {
      "content-type": "application/json",
      timestamp,
      signature: computeSignature(body, timestamp, endpoint.secret_key),
    };
    let status = 0;
    try {
      status = this.transport ? await this.transport({ url: endpoint.target_url, headers, body }) : 0;
    } catch {
      status = 0;
    }

    if (status >= 200 && status < 300) {
      d.status = "delivered";
      health.consecutiveFailures = 0;
      this.finish(endpoint, true);
      return;
    }

    d.errors.push({
      code: status ? String(status) : "connection_error",
      timestamp,
      message: status ? `${status} response` : "could not connect",
      attempts: d.attempts,
    });
    const retryIndex = d.attempts - 1;
    if (retryIndex < RETRY_DELAYS_MS.length) {
      d.nextAttemptAt = now + RETRY_DELAYS_MS[retryIndex]!;
    } else {
      d.status = "failed";
      this.finish(endpoint, false);
    }
    health.consecutiveFailures++;
    if (health.consecutiveFailures > PAUSE_AFTER_FAILURES) {
      health.pausedUntil = now + PAUSE_MS;
      health.pauses++;
      // Assumption: the count starts again after a pause.
      health.consecutiveFailures = 0;
    }
  }

  private finish(endpoint: WebhookEndpoint, ok: boolean): void {
    const health = this.health(endpoint.id);
    health.finished.push(ok);
    if (health.finished.length > DEACTIVATE_AFTER_FAILURES) health.finished.shift();
    if (!ok && health.finished.length === DEACTIVATE_AFTER_FAILURES && health.finished.every((f) => !f)) {
      endpoint.active = false;
      // "Its subscriptions stay inactive when you set the endpoint back to active: true."
      for (const sub of this.subscriptions) if (sub.webhook_endpoint_id === endpoint.id) sub.active = false;
    }
  }

  health(endpointId: number): EndpointHealth {
    let h = this.endpointHealth.get(endpointId);
    if (!h) {
      h = { consecutiveFailures: 0, pausedUntil: null, pauses: 0, finished: [] };
      this.endpointHealth.set(endpointId, h);
    }
    return h;
  }

  revokeTokens(): void {
    this.tokens.clear();
  }

  // ---- HTTP surface -----------------------------------------------------------------------

  readonly fetch: typeof fetch = async (input, init) => this.handle(new Request(input, init));

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/mock(?=\/)/, "");

    // versioning: "With neither header the call returns 404."
    if (!ACCEPTED_VERSIONS.includes(req.headers.get("nex-api-version") ?? "")) return fail(404, "Not Found");

    const match = this.match(req.method, path);
    if (!match) return fail(404, "Not Found");
    const { route, params } = match;

    if (route.auth !== false) {
      const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const expires = this.tokens.get(bearer);
      if (!expires || expires <= this.now().getTime()) return fail(401, "Unauthorized");
      if (this.rateLimitNext > 0) {
        this.rateLimitNext--;
        return json(429, { code: false, description: null, error: ["You've exceeded our rate limit. Please wait and retry."], data: null }, { "Retry-After": "1" });
      }
    }

    let body: Record<string, unknown> | null = null;
    if (req.method === "POST" || req.method === "PATCH") {
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    if (body && route.forbiddenBodyKeys?.some((k) => k in body)) {
      return fail(403, "You don't have access to perform this action.");
    }

    for (const name of route.required) {
      if (!url.searchParams.has(name)) return fail(400, `${name} is missing`);
    }
    const ignored = [...new Set(url.searchParams.keys())].filter((k) => !route.query.includes(k));

    const res = await route.handler({ headers: req.headers, params, query: url.searchParams, body });
    if (!ignored.length || !res.ok) return res;
    // "A parameter the endpoint does not accept does not fail the request... says so in description."
    const payload = (await res.json()) as Record<string, unknown>;
    payload.description = `Note that following parameters are ignored: ${ignored.join(", ")}.`;
    return json(res.status, payload);
  }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const names: string[] = [];
      const pattern = new RegExp(`^${route.path.replace(/\{(\w+)\}/g, (_, n: string) => (names.push(n), "([^/]+)"))}$`);
      const m = path.match(pattern);
      if (m) return { route, params: Object.fromEntries(names.map((n, i) => [n, m[i + 1]!])) };
    }
    return null;
  }

  readonly routes: Route[] = [
    {
      method: "POST",
      path: "/authenticates",
      query: [],
      required: [],
      auth: false,
      handler: ({ headers }) => this.authenticate(headers),
    },
    {
      method: "GET",
      path: "/institutions",
      query: [],
      required: [],
      handler: () => this.list(this.institutions.map((i) => this.publicInstitution(i))),
    },
    {
      method: "GET",
      path: "/locations",
      query: ["subdomain", "inactive", "foreign_id"],
      required: [],
      handler: ({ query }) => {
        const sub = query.get("subdomain");
        return this.list(
          this.institutions
            .filter((i) => !sub || i.subdomain === sub)
            .map((i) => ({ ...i, locations: i.locations.map((l) => this.publicLocationFull(l)) })),
        );
      },
    },
    {
      method: "GET",
      path: "/providers",
      query: ["subdomain", "location_id", "inactive", "per_page", "foreign_id"],
      required: ["subdomain"],
      handler: ({ query }) => this.listProviders(query),
    },
    {
      method: "GET",
      path: "/available_slots",
      query: ["subdomain", "start_date", "days", "lids[]", "pids[]", "appointment_type_id", "slot_length"],
      required: ["subdomain", "start_date", "days", "lids[]"],
      handler: ({ query }) => this.availableSlots(query),
    },
    {
      method: "GET",
      path: "/appointments",
      query: [
        "subdomain", "location_id", "start", "end", "updated_since", "sort", "per_page", "start_cursor",
        "end_cursor", "foreign_id", "cancelled", "patient_ids[]", "provider_ids[]",
      ],
      required: ["subdomain", "start", "end"],
      handler: (ctx) => this.listAppointments(ctx.query),
    },
    {
      method: "GET",
      path: "/appointments/{id}",
      query: ["subdomain", "include[]"],
      required: ["subdomain"],
      handler: ({ params, query }) => {
        const appt = this.appointments.get(Number(params.id));
        if (!appt || appt.subdomain !== query.get("subdomain")) return fail(404, "Appointment not found");
        return json(200, { code: true, description: null, error: null, data: this.apptDetail(appt), count: null });
      },
    },
    {
      method: "POST",
      path: "/appointments",
      query: ["subdomain", "location_id", "notify_patient"],
      required: ["subdomain", "location_id"],
      handler: ({ query, body }) => this.createAppointment(query, body),
    },
    {
      method: "GET",
      path: "/sync_status",
      query: ["subdomain", "location_ids[]", "read_status", "write_status"],
      required: [],
      handler: ({ query }) => {
        const sub = query.get("subdomain");
        const ids = query.getAll("location_ids[]").map(Number);
        const entries = this.syncs
          .filter((s) => (!sub || s.subdomain === sub) && (!ids.length || s.locationIds.some((id) => ids.includes(id))))
          .map((s) => ({
            ...s.entry,
            locations: this.institution(s.subdomain).locations
              .filter((l) => s.locationIds.includes(l.id))
              .map((l) => ({ id: l.id, name: l.name, inactive: false })),
          }));
        return this.list(entries);
      },
    },
    { method: "GET", path: "/webhook_endpoints", query: ["active"], required: [], handler: () => this.list(this.endpoints) },
    {
      method: "POST",
      path: "/webhook_endpoints",
      query: [],
      required: [],
      handler: ({ body }) => {
        if (typeof body?.target_url !== "string") return fail(400, "target_url is missing");
        return json(201, { code: true, description: null, error: null, data: this.registerEndpoint(body.target_url) });
      },
    },
    {
      method: "PATCH",
      path: "/webhook_endpoints/{id}",
      query: [],
      required: [],
      handler: ({ params, body }) => {
        const endpoint = this.endpoints.find((e) => e.id === Number(params.id));
        if (!endpoint) return fail(404, "Webhook endpoint not found");
        if (typeof body?.active === "boolean") endpoint.active = body.active;
        if (typeof body?.target_url === "string") endpoint.target_url = body.target_url;
        return json(200, { code: true, description: null, error: null, data: endpoint });
      },
    },
    {
      method: "GET",
      path: "/webhook_endpoints/{id}/webhook_subscriptions",
      query: ["subdomain", "resource_type", "event"],
      required: [],
      handler: ({ params, query }) => {
        const sub = query.get("subdomain");
        return this.list(
          this.subscriptions
            .filter((s) => s.webhook_endpoint_id === Number(params.id) && (!sub || s.subdomain === sub))
            .map(({ subdomain: _subdomain, ...rest }) => rest),
        );
      },
    },
    {
      method: "POST",
      path: "/webhook_endpoints/{id}/webhook_subscriptions",
      query: ["subdomain"],
      required: ["subdomain"],
      // "Sending subdomain in the request body returns 403."
      forbiddenBodyKeys: ["subdomain"],
      handler: ({ params, query, body }) => {
        const subdomain = query.get("subdomain")!;
        if (!this.endpoints.some((e) => e.id === Number(params.id))) return fail(404, "Webhook endpoint not found");
        const resourceType = String(body?.resource_type ?? "");
        if (!SUBSCRIBABLE[resourceType]) return fail(400, "Invalid value for parameter resource_type");
        if (!SUBSCRIBABLE[resourceType]!.includes(String(body?.event))) return fail(400, "Invalid value for parameter event");
        const created = this.subscribe(Number(params.id), subdomain, resourceType, String(body!.event));
        return json(201, { code: true, description: null, error: null, data: created });
      },
    },
    {
      method: "PATCH",
      path: "/webhook_endpoints/{id}/webhook_subscriptions/{subscription_id}",
      query: ["subdomain"],
      required: ["subdomain"],
      handler: ({ params, body }) => {
        const sub = this.subscriptions.find(
          (s) => s.id === Number(params.subscription_id) && s.webhook_endpoint_id === Number(params.id),
        );
        if (!sub) return fail(404, "Webhook subscription not found");
        if (typeof body?.active === "boolean") sub.active = body.active;
        const { subdomain: _s, ...rest } = sub;
        return json(200, { code: true, description: null, error: null, data: rest });
      },
    },
  ];

  // ---- handlers ---------------------------------------------------------------------------

  /** POST /authenticates takes the raw API key in Authorization and returns a JWT-shaped token that lasts 1 hour. */
  private authenticate(headers: Headers): Response {
    if (headers.get("authorization") !== this.apiKey) return fail(401, "Unauthorized");
    const exp = Math.floor(this.now().getTime() / 1000) + 3600;
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "mock-api-user", exp })}.${randomBytes(16).toString("base64url")}`;
    this.tokens.set(token, exp * 1000);
    return json(201, { code: true, description: "Authenticated", error: null, data: { token }, count: null });
  }

  private list<T>(items: T[]): Response {
    return json(200, { code: true, description: null, error: null, data: items, count: items.length });
  }

  private listAppointments(query: URLSearchParams): Response {
    if (query.has("start_cursor") && query.has("end_cursor")) {
      return fail(400, "Only one of start_cursor or end_cursor can be provided");
    }
    if (!query.has("location_id") && !query.has("foreign_id")) {
      return fail(400, "At least one of location_id or foreign_id must be provided");
    }
    const start = Date.parse(query.get("start")!);
    const end = Date.parse(query.get("end")!);
    if (Number.isNaN(start) || Number.isNaN(end)) return fail(400, "start and end must be parseable dates");
    const since = query.has("updated_since") ? Date.parse(query.get("updated_since")!) : null;
    const locationId = query.has("location_id") ? Number(query.get("location_id")) : null;
    const patientIds = query.getAll("patient_ids[]").map(Number);

    const rows = [...this.appointments.values()]
      .filter((a) => a.subdomain === query.get("subdomain"))
      .filter((a) => locationId === null || a.location_id === locationId)
      .filter((a) => !query.has("foreign_id") || a.foreign_id === query.get("foreign_id"))
      .filter((a) => !patientIds.length || patientIds.includes(a.patient_id))
      .filter((a) => Date.parse(a.start_time) >= start && Date.parse(a.start_time) <= end)
      // "updated_since returns records updated at or after the time you send"
      .filter((a) => since === null || Date.parse(a.updated_at) >= since);
    const sort = query.get("sort");
    if (sort === "updated_at" || sort === "-updated_at") {
      rows.sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.id - b.id);
      if (sort === "-updated_at") rows.reverse();
    } else {
      rows.sort((a, b) => a.id - b.id);
    }

    const perPage = Math.min(Math.max(Number(query.get("per_page") ?? 5) || 5, 1), 1000);
    const offset = query.has("end_cursor") ? decodeCursor(query.get("end_cursor")!) : 0;
    const page = rows.slice(offset, offset + perPage);
    return json(200, {
      code: true,
      description: null,
      error: null,
      data: page.map((a) => this.apptListRow(a)),
      page_info: {
        has_previous_page: offset > 0,
        has_next_page: offset + perPage < rows.length,
        start_cursor: page.length ? encodeCursor(offset) : null,
        end_cursor: page.length ? encodeCursor(offset + page.length) : null,
      },
      // Paginated GET /appointments omits count (per live sandbox).
    });
  }

  private createAppointment(query: URLSearchParams, body: Record<string, unknown> | null): Response {
    const subdomain = query.get("subdomain")!;
    const inst = this.institutions.find((i) => i.subdomain === subdomain);
    if (!inst) return fail(403, "You don't have access to perform this action.");
    const locationId = Number(query.get("location_id"));
    if (!inst.locations.some((l) => l.id === locationId)) return fail(404, "Location not found");
    const appt = body?.appt as Record<string, unknown> | undefined;
    for (const field of ["patient_id", "provider_id", "start_time"]) {
      if (appt?.[field] === undefined) return fail(400, `appt[${field}] is missing`);
    }
    const at = this.now().toISOString();
    const created: MockAppointment = {
      id: ++this.ids.appointment,
      subdomain,
      patient_id: Number(appt!.patient_id),
      provider_id: Number(appt!.provider_id),
      operatory_id: appt!.operatory_id === undefined ? null : Number(appt!.operatory_id),
      location_id: locationId,
      start_time: String(appt!.start_time),
      end_time: appt!.end_time === undefined ? null : String(appt!.end_time),
      // "An appointment that NexHealth has not written yet has foreign_id set to null and last_sync_time set to null."
      foreign_id: null,
      foreign_id_type: "nex",
      last_sync_time: null,
      created_at: at,
      updated_at: at,
      cancelled: false,
      pendingInsertion: true,
    };
    this.appointments.set(created.id, created);
    return json(201, {
      code: true,
      description: null,
      error: null,
      data: { appt: this.apptListRow(created), stripe_client_secret: null },
    });
  }

  // ---- helpers ----------------------------------------------------------------------------

  private institution(subdomain: string): MockInstitution {
    const inst = this.institutions.find((i) => i.subdomain === subdomain);
    if (!inst) throw new Error(`no institution ${subdomain}`);
    return inst;
  }

  syncFor(subdomain: string, locationId: number): MockSync | undefined {
    return this.syncs.find((s) => s.subdomain === subdomain && s.locationIds.includes(locationId));
  }

  private mustPending(id: number): MockAppointment {
    const appt = this.appointments.get(id);
    if (!appt?.pendingInsertion) throw new Error(`appointment ${id} has no pending insertion`);
    return appt;
  }

  private providerName(subdomain: string, providerId: number): string {
    return this.providers.find((p) => p.subdomain === subdomain && p.id === providerId)?.name ?? "Demo Provider";
  }

  private listProviders(query: URLSearchParams): Response {
    const sub = query.get("subdomain");
    const locationId = query.has("location_id") ? Number(query.get("location_id")) : null;
    let rows = this.providers.filter((p) => (!sub || p.subdomain === sub) && (locationId === null || p.location_id === locationId));
    if (!rows.length && sub && locationId !== null) {
      rows = [{ subdomain: sub, id: 541159954, name: "Demo Provider", location_id: locationId }];
    }
    return this.list(
      rows.map((p) => ({
        id: p.id,
        email: "provider@demo.example",
        first_name: p.name.split(" ")[0],
        last_name: p.name.split(" ").slice(1).join(" ") || "Provider",
        name: p.name,
        created_at: this.now().toISOString(),
        updated_at: this.now().toISOString(),
        institution_id: this.institution(p.subdomain).id,
        foreign_id: "0",
        foreign_id_type: null,
        bio: { phone_number: "5555550101", gender: null, date_of_birth: null },
        inactive: false,
        last_sync_time: null,
        display_name: null,
        npi: null,
        tin: null,
        state_license: null,
        specialty: null,
        nexhealth_specialty: null,
        profile_url: "/missing.png",
        locations: [{ id: p.location_id, name: this.institution(p.subdomain).locations[0]?.name ?? "Main" }],
        provider_requestables: [],
      })),
    );
  }

  private availableSlots(query: URLSearchParams): Response {
    const sub = query.get("subdomain")!;
    const lids = query.getAll("lids[]").map(Number);
    const pids = query.getAll("pids[]").map(Number);
    if (!sub || !lids.length || (!pids.length && !query.has("appointment_type_id"))) {
      return fail(400, "subdomain, lids[], and pids[] or appointment_type_id are required");
    }
    const loc = lids[0]!;
    const pid = pids[0] ?? 0;
    const start = query.get("start_date") ?? this.now().toISOString().slice(0, 10);
    const days = Number(query.get("days") ?? 1);
    const slots: Array<{ time: string; end_time: string; operatory_id: number; working_hour_label_id: null }> = [];
    for (let i = 0; i < Math.max(2, days * 2); i++) {
      const minute = 45 + i * 15;
      const hour = 15 + Math.floor(minute / 60);
      const mm = minute % 60;
      slots.push({
        time: `${start}T${String(hour).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000-05:00`,
        end_time: `${start}T${String(hour).padStart(2, "0")}:${String(mm + 15).padStart(2, "0")}:00.000-05:00`,
        operatory_id: 325731,
        working_hour_label_id: null,
      });
    }
    return json(200, { code: true, description: null, error: null, data: [{ lid: loc, pid, slots }], count: 1 });
  }

  private publicInstitution(inst: MockInstitution) {
    return {
      id: inst.id,
      name: inst.name,
      created_at: inst.created_at,
      updated_at: inst.updated_at,
      subdomain: inst.subdomain,
      phone_number: null,
      emrs: inst.emrs ?? ["dentrix"],
      country_code: inst.country_code ?? "US",
      is_appt_categories_location_specific: true,
      appointment_types_location_scoped: true,
      is_sync_notifications: true,
      notify_insert_fails: true,
      wlogo: "/missing.png",
      is_appt_booking_patient_type_activated: true,
      is_appt_booking_insurance_activated: false,
      show_online_booking_no_insurance_option: true,
      request_online_booking_location_permissions: false,
      gtm_tags: [],
      show_map: false,
      logo_location_scoped: false,
      locations: inst.locations.map((l) => this.publicLocationSlim(l)),
    };
  }

  private publicLocationSlim(loc: MockLocation) {
    return {
      id: loc.id,
      name: loc.name,
      street_address: loc.street_address,
      street_address_2: loc.street_address_2 ?? null,
      city: loc.city,
      state: loc.state,
      zip_code: loc.zip_code,
      phone_number: loc.phone_number,
      email: loc.email,
      inactive: loc.inactive ?? false,
    };
  }

  private publicLocationFull(loc: MockLocation) {
    return {
      id: loc.id,
      name: loc.name,
      institution_id: loc.institution_id,
      street_address: loc.street_address,
      street_address_2: loc.street_address_2 ?? null,
      city: loc.city,
      state: loc.state,
      zip_code: loc.zip_code,
      country_code: null,
      created_at: loc.created_at,
      updated_at: loc.updated_at,
      latitude: loc.latitude ?? null,
      longitude: loc.longitude ?? null,
      phone_number: loc.phone_number,
      foreign_id: loc.foreign_id,
      foreign_id_type: loc.foreign_id_type,
      email: loc.email,
      tz: loc.tz,
      last_sync_time: loc.last_sync_time ?? null,
      insert_appt_client: loc.insert_appt_client ?? true,
      map_by_operatory: loc.map_by_operatory ?? true,
      appt_types_map_by_operatory: false,
      set_availability_by_operatory: false,
      inactive: loc.inactive ?? false,
      specialty: null,
      wlogo: "/missing.png",
      weight: 1,
    };
  }

  private apptListRow(appt: MockAppointment) {
    const inst = this.institution(appt.subdomain);
    const loc = inst.locations.find((l) => l.id === appt.location_id);
    return {
      id: appt.id,
      patient_id: appt.patient_id,
      provider_id: appt.provider_id,
      provider_name: appt.provider_name ?? this.providerName(appt.subdomain, appt.provider_id),
      start_time: appt.start_time,
      confirmed: appt.confirmed ?? false,
      patient_missed: false,
      created_at: appt.created_at,
      updated_at: appt.updated_at,
      note: appt.note ?? null,
      end_time: appt.end_time,
      unavailable: false,
      cancelled: appt.cancelled ?? false,
      timezone: loc?.tz ?? "America/New_York",
      institution_id: inst.id,
      appointment_type_id: appt.appointment_type_id ?? null,
      checkin_at: null,
      location_id: appt.location_id,
      foreign_id: appt.foreign_id,
      foreign_id_type: appt.foreign_id_type ?? (appt.foreign_id ? loc?.foreign_id_type : "nex"),
      misc: appt.misc ?? {},
      last_sync_time: appt.last_sync_time ?? null,
      patient_confirmed: false,
      created_by_user_id: null,
      is_guardian: false,
      patient_confirmed_at: null,
      cancelled_at: null,
      is_new_clients_patient: null,
      confirmed_at: null,
      sooner_if_possible: false,
      operatory_id: appt.operatory_id ?? null,
      deleted: false,
      checked_out: false,
      checked_out_at: null,
      referrer: null,
      is_past_patient: true,
      timezone_offset: "-05:00",
    };
  }

  private apptDetail(appt: MockAppointment) {
    const name = PATIENT_NAMES[appt.patient_id % PATIENT_NAMES.length]!;
    const [first_name, last_name] = name.split(" ");
    return {
      ...this.apptListRow(appt),
      patient: {
        id: appt.patient_id,
        email: "patient@demo.example",
        first_name,
        middle_name: null,
        last_name,
        name,
        created_at: appt.created_at,
        updated_at: appt.updated_at,
        institution_id: this.institution(appt.subdomain).id,
        foreign_id: "patient-demo-foreign-id",
        foreign_id_type: this.institution(appt.subdomain).locations[0]?.foreign_id_type,
        bio: { gender: "Female", phone_number: "5555550102", date_of_birth: "1990-01-01", verified_mobile: "5555550102" },
        inactive: false,
        last_sync_time: null,
        guarantor_id: null,
        unsubscribe_sms: true,
        balance: { amount: "0.00", currency: "USD" },
        billing_type: null,
        chart_id: null,
        preferred_language: null,
        preferred_locale: null,
        location_ids: [appt.location_id],
        guarantor: null,
      },
    };
  }

  /** For webhooks: list row without nesting patient (inclusion uses apptDetail separately). */
  private publicAppt(appt: MockAppointment, withPatient = false): Record<string, unknown> {
    return withPatient ? this.apptDetail(appt) : this.apptListRow(appt);
  }

}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: number };
    return typeof parsed.o === "number" && parsed.o >= 0 ? parsed.o : 0;
  } catch {
    const legacy = Number(Buffer.from(cursor, "base64url").toString("utf8").replace(/^o:/, ""));
    return Number.isFinite(legacy) && legacy >= 0 ? legacy : 0;
  }
}
