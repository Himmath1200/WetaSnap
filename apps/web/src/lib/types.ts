// Domain contract shared by the PWA and the API (URS v2.0 §9.4).
// Keep in sync with services/api/db/migrations.

export type Role = 'super_admin' | 'client_admin' | 'staff' | 'individual' | 'organizer';

export type FieldType = 'text' | 'email' | 'phone' | 'link' | 'choice' | 'longtext';
export type FilledBy = 'ai' | 'offline' | 'person' | 'qr';
export type Interest = 'wetaloop' | 'wetanalytics' | 'other' | 'hot' | 'warm' | 'cold';
export type LeadSource = 'camera' | 'upload' | 'manual';

/** On device → Synced → In CRM, or Check/Failed (SYNC-02). */
export type LeadStatus = 'waiting' | 'synced' | 'in_crm' | 'check';

export type LicenceType = 'trial' | 'monthly' | 'annual';
export type LicenceStatus = 'active' | 'trial' | 'expires_soon' | 'grace' | 'read_only';
export type ConnectorKind = 'zoho_crm' | 'zoho_bigin' | 'hubspot' | 'salesforce' | 'webhook' | 'csv';

export interface Company {
  id: string;
  name: string;
  country: string;
  /** Postal address of the head office (Settings → Company). */
  headquarters: string;
  /** Interface language for new people in this company. */
  default_language: string;
  /** IANA zone, e.g. Europe/Berlin — used for “today”, exports and reminders. */
  time_zone: string;
  logo_url?: string | null;
  consent_text: string;
  consent_version: number;
  retention_leads_months: number;
  retention_photos_months: number;
  cloud_ai_enabled: boolean;
  offline_pack_enabled: boolean;
  /** A suspended company can sign in nowhere; scanning devices keep their leads (W6). */
  suspended: boolean;
  suspended_reason: string;
  /** What happens when the monthly scan allowance runs out. */
  scan_limit_action: ScanLimitAction;
  /** Organization follow-up message template dispatched by all staff scanners */
  follow_up_message?: string | null;
  follow_up_auto?: boolean;
}

/** Set by WeTano per company (LIC-05). */
export type ScanLimitAction = 'block' | 'overage' | 'notify';

export interface Licence {
  id: string;
  company_id: string;
  type: LicenceType;
  starts_on: string; // ISO date
  ends_on: string;
  seats: number;
  scans_per_month: number; // 0 = unlimited
  connectors_allowed: ConnectorKind[];
}

export interface Person {
  id: string;
  company_id: string | null; // null for super admins and individuals
  email: string;
  name: string;
  phone: string;
  role: Role;
  /** For individual users: subscription plan and scan count tracking */
  plan?: 'free' | 'pro';
  monthly_scans?: number;
  scans_reset_at?: string;
  created_at?: string;
  /** For organizers & referral event members */
  referral_code?: string;
  organizer_id?: string | null;
  max_logins?: number;
  event_ends_on?: string | null;
  /** Events this person may capture for; the first one is their default. */
  event_ids: string[];
  default_event_id: string | null;
  access_ends_on: string | null;
  active: boolean;
  invited: boolean; // true until first sign-in
  avatar_url: string | null;
  /** Super Admins sign in with a password; everyone else with an emailed code. */
  has_password?: boolean;
  mfa_enabled?: boolean;
}

export interface EventItem {
  id: string;
  company_id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  venue: string;
  booth: string;
  status: 'open' | 'closed';
  description: string;
  time_zone: string;
  template_id: string | null;
  attachments: Attachment[];
  organizer_id?: string | null;
  organizer_name?: string | null;
  max_logins?: number;
}

export interface OrganizerDetail extends Person {
  event_id?: string;
  event_name?: string;
  starts_on?: string;
  ends_on?: string;
  venue?: string;
  members_count: number;
  total_scans?: number;
  is_expired?: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Storage key in object storage, or an object URL / data URL in demo mode. */
  url: string;
  uploaded_at: string;
}

/** A named set of card fields (Settings → Card fields). Every company has one default. */
export interface FieldTemplate {
  id: string;
  company_id: string;
  name: string;
  description: string;
  is_default: boolean;
  field_count: number;
  updated_at: string;
}

/** Tags group leads (per company); staff can attach them while scanning. */
export interface Tag {
  id: string;
  company_id: string;
  name: string;
  colour: TagColour;
}

export type TagColour = 'green' | 'blue' | 'amber' | 'red' | 'purple' | 'slate';

export interface FieldDefinition {
  id: string;
  company_id: string;
  /** Which card-field template this field belongs to. */
  template_id: string;
  key: string;
  label: string;
  type: FieldType;
  options: string[]; // for 'choice'
  required: boolean;
  ai_hint: string;
  filled_by: 'ai' | 'staff';
  sort_order: number;
}

export interface FieldValue {
  value: string;
  by: FilledBy;
  confidence?: number; // 0..1, from AI
  reason?: string; // shown when uncertain (AI-03)
}

export interface CrmAttempt {
  at: string;
  ok: boolean;
  message: string;
}

export interface Lead {
  id: string; // device-generated UUID = idempotency key (SYNC-03)
  company_id: string;
  event_id: string;
  captured_by: string; // person id
  captured_by_name: string;
  device: string;
  source: LeadSource;
  fields: Record<string, FieldValue>;
  interest: Interest | null;
  notes: string;
  consent: boolean;
  consent_version: number;
  consent_at: string | null;
  status: LeadStatus;
  crm_error: string | null;
  crm_record_id: string | null;
  crm_history: CrmAttempt[];
  has_photo: boolean;
  has_back_photo: boolean; // SCAN-05: back of the card
  tag_ids: string[];
  /** Set on leads that came from an Excel/CSV import, so “View imported leads” shows exactly that file. */
  import_batch_id?: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  deleted_at: string | null;
}

export interface Connection {
  id: string;
  company_id: string;
  kind: ConnectorKind;
  status: 'connected' | 'error' | 'disconnected';
  record_type: string;
  mode: 'auto' | 'manual';
  mapping: Record<string, string>; // field key -> CRM field
  account_label: string;
}

export interface CompanySummary extends Company {
  licence: Licence;
  licence_status: LicenceStatus;
  seats_used: number;
  scans_this_month: number;
}

export interface LeadFilters {
  q: string;
  /** Multi-select: empty = all events. */
  event_ids: string[];
  /** Multi-select: empty = everyone. */
  captured_by: string[];
  /** Multi-select: empty = any tag. */
  tag_ids: string[];
  status: LeadStatus | '';
  interest: Interest | '';
  from: string; // yyyy-mm-dd
  to: string;
  /** Only the leads of one import (Import history → View imported leads). */
  import_batch_id?: string;
}

export const emptyFilters = (): LeadFilters => ({
  q: '', event_ids: [], captured_by: [], tag_ids: [], status: '', interest: '', from: '', to: '',
});

// ---------------------------------------------------------------- notifications
export type NotificationKind =
  | 'lead_failed' | 'leads_waiting' | 'licence_expiring' | 'licence_expired'
  | 'event_starting' | 'person_invited' | 'import_done' | 'support_reply' | 'subscription';

export interface AppNotification {
  id: string;
  company_id: string | null;
  person_id: string | null; // null = everyone in the company with the right role
  kind: NotificationKind;
  title: string;
  body: string;
  /** In-app route to open, e.g. /leads?status=check */
  link: string | null;
  /** Reminders are shown in the notifications panel until this time passes. */
  remind_at: string | null;
  created_at: string;
  read_at: string | null;
}

// ---------------------------------------------------------------- subscriptions (WeTano)
export interface Plan {
  id: string;
  name: string;
  description: string;
  /** Minor units (cents) to avoid rounding; currency is per plan. */
  price_month: number;
  price_year: number;
  currency: string;
  seats: number;
  scans_per_month: number; // 0 = unlimited
  connectors_allowed: ConnectorKind[];
  features: string[];
  active: boolean;
}

/** Individual/Solo account plans and limits (configured by Super Admin in Subscriptions). */
export interface IndividualPricingConfig {
  free_scans_limit: number;
  pro_price_month: number;
  pro_price_year: number;
  currency: string;
  free_features: string[];
  pro_features: string[];
  updated_at?: string;
}

export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled';

export interface Invoice {
  id: string;
  number: string;
  company_id: string;
  company_name: string;
  plan_id: string | null;
  plan_name: string;
  period_start: string;
  period_end: string;
  amount: number; // minor units
  tax: number;
  currency: string;
  status: InvoiceStatus;
  issued_on: string;
  due_on: string;
  paid_on: string | null;
  paid_by: string; // how it was paid, recorded by hand
  notes: string;
}

export interface Subscription {
  company_id: string;
  plan_id: string | null;
  billing_cycle: 'monthly' | 'annual';
  renews_on: string;
  auto_renew: boolean;
}

// ---------------------------------------------------------------- audit & support
export interface AuditEntry {
  id: string;
  at: string;
  actor_email: string;
  actor_role: Role | 'system';
  company_id: string | null;
  company_name: string;
  action: string;
  entity: string;
  entity_id: string | null;
  details: Record<string, unknown>;
}

export type TicketStatus = 'open' | 'waiting' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface SupportTicket {
  id: string;
  number: string;
  company_id: string;
  company_name: string;
  opened_by: string; // email
  subject: string;
  body: string;
  status: TicketStatus;
  priority: TicketPriority;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  messages: TicketMessage[];
}

export interface TicketMessage {
  id: string;
  at: string;
  author: string;
  from_wetano: boolean;
  body: string;
}

// ---------------------------------------------------------------- accounts & security
export interface DeviceSession {
  id: string;
  person_id: string;
  device: string;        // “Android · Chrome”
  ip: string;
  location: string;      // best effort, e.g. “Hannover, DE”
  created_at: string;
  last_seen_at: string;
  /** The device you are reading this on. */
  current: boolean;
}

export type LoginMethod = 'code' | 'password' | 'totp' | 'recovery';

export interface LoginEvent {
  id: string;
  at: string;
  email: string;
  method: LoginMethod;
  ok: boolean;
  /** Plain words when it failed: “wrong password”, “code expired”… */
  reason: string;
  device: string;
  ip: string;
  location: string;
}

/** Set by WeTano and applied across the whole application. */
export interface SecurityPolicy {
  min_length: number;
  require_upper: boolean;
  require_number: boolean;
  require_symbol: boolean;
  /** 0 = passwords never expire. */
  expiry_days: number;
  /** How many old passwords may not be reused. */
  reuse_block: number;
  lockout_attempts: number;
  lockout_minutes: number;
  /** Signed out after this long with no activity. 0 = never. */
  idle_timeout_minutes: number;
  /** Device sign-in lasts this many days before the code is asked again (AUTH-03). */
  device_session_days: number;
  mfa_required_super_admin: boolean;
  mfa_required_client_admin: boolean;
}

export interface RecoveryCodes {
  codes: string[];
  used: number;
  generated_at: string;
}

// ---------------------------------------------------------------- usage
export interface UsageRow {
  company_id: string;
  company_name: string;
  month: string; // yyyy-mm
  scans: number;
  scan_limit: number; // 0 = unlimited
  ai_reads: number;
  crm_pushes: number;
  syncs: number;
  storage_mb: number;
  seats_used: number;
  seats: number;
  suspended: boolean;
  scan_limit_action: ScanLimitAction;
}

export interface UsageAlert {
  id: string;
  /** null = every company. */
  company_id: string | null;
  metric: 'scans' | 'seats' | 'storage';
  threshold_pct: number;
  active: boolean;
  last_fired_at: string | null;
}

// ---------------------------------------------------------------- imports
export interface ImportBatch {
  id: string;
  company_id: string;
  at: string;
  by: string;          // email
  file_name: string;
  event_id: string;
  event_name: string;
  imported: number;
  skipped: number;
  tag_ids: string[];
}

// ---------------------------------------------------------------- sorting
export type SortDir = 'asc' | 'desc';
export interface Sort {
  key: string;
  dir: SortDir;
}
