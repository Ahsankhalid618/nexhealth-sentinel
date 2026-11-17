import type {
  Appointment,
  Envelope,
  Institution,
  NewAppointment,
  PageInfo,
  SyncStatusEntry,
  WebhookEndpoint,
  WebhookSubscription,
} from "./types";

export const API_VERSION = "v3.0.0";
export const DEFAULT_BASE_URL = "https://nexhealth.info";

/** The docs say a token lasts 1 hour; refresh a little early. */
const TOKEN_TTL_MS = 60 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;

export class NexHealthError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly errors: string[],
  ) {
    super(`NexHealth ${method} ${path} -> ${status || "network error"}: ${errors.join("; ") || "no error message"}`);
  }

  /** 4xx other than 401/429 means NexHealth did not accept the request. */
  get isRejection(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 401 && this.status !== 429;
  }
}

type QueryValue = string | number | boolean | undefined | null | Array<string | number>;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  maxRateLimitRetries?: number;
  /** Called with `description` when NexHealth says it ignored parameters, which is otherwise silent. */
  onWarning?: (message: string) => void;
}

function tokenExpiry(token: string, issuedAt: number): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {
    // not a decodable JWT; fall back to the documented lifetime
  }
  return issuedAt + TOKEN_TTL_MS;
}

function retryAfterMs(header: string | null, now: number): number {
  if (!header) return 1000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? 1000 : Math.max(0, date - now);
}

export class NexHealthClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly options: ClientOptions) {
    if (!options.apiKey) throw new Error("NexHealthClient: apiKey is required (set NEXHEALTH_API_KEY)");
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
  }

  async authenticate(): Promise<string> {
    const res = await this.send("POST", "/authenticates", {}, this.options.apiKey);
    const token = (res.data as { token?: string } | null)?.token;
    if (!token) throw new NexHealthError(500, "POST", "/authenticates", ["no token in response"]);
    const issuedAt = this.now().getTime();
    this.token = { value: token, expiresAt: tokenExpiry(token, issuedAt) };
    return token;
  }

  private async bearer(): Promise<string> {
    if (!this.token || this.token.expiresAt - REFRESH_MARGIN_MS <= this.now().getTime()) {
      await this.authenticate();
    }
    return `Bearer ${this.token!.value}`;
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
    try {
      return await this.send<T>(method, path, options, await this.bearer());
    } catch (err) {
      if (!(err instanceof NexHealthError) || err.status !== 401) throw err;
      this.token = null;
      return this.send<T>(method, path, options, await this.bearer());
    }
  }

  private buildUrl(path: string, query: RequestOptions["query"] = {}): string {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(v));
    }
    return url.toString();
  }

  private async send<T>(
    method: string,
    path: string,
    options: RequestOptions,
    authorization: string,
  ): Promise<Envelope<T>> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      "Nex-Api-Version": API_VERSION,
      Authorization: authorization,
      Accept: "application/json",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
      } catch (err) {
        throw new NexHealthError(0, method, path, [err instanceof Error ? err.message : String(err)]);
      }

      if (res.status === 429 && attempt < (this.options.maxRateLimitRetries ?? 3)) {
        await this.sleep(retryAfterMs(res.headers.get("retry-after"), this.now().getTime()));
        continue;
      }

      const text = await res.text();
      let json: Envelope<T> | null = null;
      try {
        json = text ? (JSON.parse(text) as Envelope<T>) : null;
      } catch {
        json = null;
      }
      if (!res.ok || !json || json.code === false) {
        const errors = json?.error ?? [text.slice(0, 200) || res.statusText];
        throw new NexHealthError(res.status, method, path, errors);
      }
      if (json.description?.startsWith("Note that following parameters are ignored")) {
        this.options.onWarning?.(`${method} ${path}: ${json.description}`);
      }
      return json;
    }
  }

  // Typed helpers for the endpoints this project uses.

  async getInstitutions(): Promise<Institution[]> {
    return (await this.request<Institution[]>("GET", "/institutions")).data;
  }

  async getLocations(subdomain?: string): Promise<Institution[]> {
    return (await this.request<Institution[]>("GET", "/locations", { query: { subdomain } })).data;
  }

  async getAppointment(subdomain: string, id: number): Promise<Appointment> {
    return (await this.request<Appointment>("GET", `/appointments/${id}`, { query: { subdomain } })).data;
  }

  async listAppointments(query: {
    subdomain: string;
    location_id: number;
    start: string;
    end: string;
    updated_since?: string;
    sort?: "updated_at" | "-updated_at";
    per_page?: number;
    end_cursor?: string;
    "patient_ids[]"?: number[];
  }): Promise<{ data: Appointment[]; pageInfo: PageInfo | null }> {
    const res = await this.request<Appointment[]>("GET", "/appointments", { query });
    return { data: res.data, pageInfo: res.page_info ?? null };
  }

  async createAppointment(subdomain: string, locationId: number, appt: NewAppointment): Promise<Appointment> {
    const res = await this.request<{ appt: Appointment }>("POST", "/appointments", {
      query: { subdomain, location_id: locationId, notify_patient: false },
      body: { appt },
    });
    return res.data.appt;
  }

  async getSyncStatus(subdomain: string, locationIds?: number[]): Promise<SyncStatusEntry[]> {
    return (
      await this.request<SyncStatusEntry[]>("GET", "/sync_status", {
        query: { subdomain, "location_ids[]": locationIds },
      })
    ).data;
  }

  async listWebhookEndpoints(): Promise<WebhookEndpoint[]> {
    return (await this.request<WebhookEndpoint[]>("GET", "/webhook_endpoints")).data;
  }

  async createWebhookEndpoint(targetUrl: string): Promise<WebhookEndpoint> {
    return (await this.request<WebhookEndpoint>("POST", "/webhook_endpoints", { body: { target_url: targetUrl } }))
      .data;
  }

  async listSubscriptions(endpointId: number, subdomain?: string): Promise<WebhookSubscription[]> {
    return (
      await this.request<WebhookSubscription[]>("GET", `/webhook_endpoints/${endpointId}/webhook_subscriptions`, {
        query: { subdomain },
      })
    ).data;
  }

  /** `subdomain` must go in the query string; the docs say sending it in the body returns 403. */
  async createSubscription(
    endpointId: number,
    subdomain: string,
    resourceType: string,
    event: string,
  ): Promise<WebhookSubscription> {
    return (
      await this.request<WebhookSubscription>("POST", `/webhook_endpoints/${endpointId}/webhook_subscriptions`, {
        query: { subdomain },
        body: { resource_type: resourceType, event },
      })
    ).data;
  }
}
