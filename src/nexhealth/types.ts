/** The fields of NexHealth v3.0.0 responses this project reads. See docs.nexhealth.com/reference. */

export interface Envelope<T> {
  code: boolean;
  description: string | null;
  error: string[] | null;
  data: T;
  count?: number | null;
  page_info?: PageInfo;
}

export interface PageInfo {
  has_previous_page: boolean;
  has_next_page: boolean;
  start_cursor: string | null;
  end_cursor: string | null;
}

export interface Location {
  id: number;
  name: string;
  institution_id: number;
  tz: string | null;
  foreign_id_type: string | null;
  insert_appt_client?: boolean;
  map_by_operatory?: boolean;
  inactive?: boolean;
}

export interface Institution {
  id: number;
  name: string;
  subdomain: string;
  locations: Location[];
}

export interface Appointment {
  id: number;
  patient_id: number;
  provider_id: number;
  location_id: number;
  operatory_id?: number | null;
  start_time: string;
  end_time: string | null;
  foreign_id: string | null;
  last_sync_time: string | null;
  updated_at: string;
  created_at?: string;
  cancelled?: boolean;
  patient_name?: string;
  patient?: { id: number; name?: string; first_name?: string; last_name?: string } | null;
}

export interface SyncStatusEntry {
  institution_id: number;
  sync_source_type: string;
  sync_source_name: string;
  emr: { id: number; name: string; display_name: string; type: "cloud" | "onprem" } | null;
  read_status: "green" | "red";
  read_status_at: string | null;
  write_status: "green" | "red";
  write_status_at: string | null;
  locations: Array<{ id: number; name?: string }> | null;
}

export interface WebhookEndpoint {
  id: number;
  target_url: string;
  secret_key: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface WebhookSubscription {
  id: number;
  webhook_endpoint_id: number;
  institution_id: number | null;
  resource_type: string;
  event: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface NewAppointment {
  patient_id: number;
  provider_id: number;
  start_time: string;
  end_time?: string;
  operatory_id?: number;
  appointment_type_id?: number;
  note?: string;
}
