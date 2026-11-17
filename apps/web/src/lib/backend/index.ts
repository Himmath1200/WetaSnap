import type {
  AppNotification, AuditEntry, Company, CompanySummary, Connection, ConnectorKind, DeviceSession, EventItem,
  FieldDefinition, FieldTemplate, FilledBy, ImportBatch, IndividualPricingConfig, Invoice, Lead, LeadFilters, Licence, LoginEvent, OrganizerDetail, Person,
  Plan, RecoveryCodes, Role, ScanLimitAction, SecurityPolicy, Subscription, SupportTicket, Tag, TicketStatus,
  UsageAlert, UsageRow,
} from '../types';

export interface SignedIn {
  token: string;
  person: Person;
  company: Company | null;
  /** This device's session row, so it can be listed and revoked (AUTH-03). */
  session_id?: string;
}

/**
 * Sign-in is password-first for everyone (client decision, 22 Sep 2026):
 *   Super Admin  password → 6-digit emailed code → authenticator (always)
 *   Client Admin password → 6-digit emailed code → authenticator (only if they turned it on)
 *   Staff        password
 * Each call returns the next step until `done`.
 */
/** Which sign-in page a request came from: the WeTano Console, or the shared company page. */
export type Door = 'console' | 'app';

export type AuthStep =
  | { next: 'email_code'; demoCode?: string }
  /** Only for accounts that set up an authenticator themselves, in Security. */
  | { next: 'totp' }
  | ({ next: 'done' } & SignedIn);

/** Anything that went wrong in the app, written to the audit log with its cause and place. */
export interface ClientErrorReport {
  /** What the person was doing, in plain words: “Save lead”, “Export leads”. */
  action: string;
  /** Error class or code: TypeError, NetworkError, 23505… */
  name: string;
  message: string;
  /** Best available root cause: the underlying error, the failing request, or the rule that refused it. */
  cause: string;
  /** Where it happened: screen and function, e.g. “Leads › exportLeads”. */
  where: string;
  route: string;
  stack: string;
  at: string;
  device: string;
  online: boolean;
}

export type ReadResult = Record<string, { value: string; confidence: number; reason?: string; by?: FilledBy }>;

export interface Counters { in_event: number; today: number; waiting: number; failed: number }
export interface SeatInfo { used: number; seats: number; licence: Licence; status: import('../types').LicenceStatus }
export interface PersonRow extends Person { event_name: string | null; lead_count: number; status: 'active' | 'invited' | 'expired' | 'deactivated' }
export interface LicenceChange { at: string; by: string; summary: string }

/**
 * What came of an invitation (AUTH-08). Every company account starts this way: the person is
 * created without a password and emailed a 6-digit code plus a link to the setup screen, where
 * they choose the password they will sign in with from then on.
 */
export interface Invitation {
  /** The link in the email — the setup screen with their address filled in. */
  setup_link: string;
  /** False when the email could not be sent: pass the link on by hand. */
  email_sent: boolean;
  /** This address had already been invited, so the invitation was sent again. */
  resent: boolean;
  /** Demo only (there is no email): the code the email would have carried. */
  demoCode?: string;
}

export interface ImportRow { fields: Record<string, string>; duplicate: boolean }
export interface ImportResult { imported: number; skipped: number; batch_id: string }

/** One company as the Super Admin sees it when opening its row. */
export interface CompanyDetail extends CompanySummary {
  admins: { id: string; name: string; email: string; phone: string; active: boolean; invited: boolean; last_sign_in_at: string | null }[];
  plan_name: string;
  billing_cycle: 'monthly' | 'annual';
  scans_this_month: number;
}

export interface NewCompanyInput {
  name: string; country: string; admin_name: string; admin_email: string;
  licence: Omit<Licence, 'id' | 'company_id'>;
}

/**
 * Everything the app needs from the server. Two implementations:
 *  - demo: in-browser mock (no setup needed; used when VITE_API_URL is empty)
 *  - api: the WeTa Snap API (see /services/api) — PostgreSQL, Redis-or-PostgreSQL, object storage
 */
export interface Backend {
  readonly mode: 'demo' | 'api';
  setToken(token: string | null): void;

  // S1 · sign-in (AUTH-01..04) — one portal per role, see lib/portal.ts
  /** Step 1. `role` is the portal being used; other roles are refused. */
  /**
   * `door` says which sign-in page this is: the WeTano Console (/super-admin) or the shared
   * company page. An account belonging to the other door is refused and told where to go.
   */
  signInWithPassword(email: string, password: string, door: Door): Promise<AuthStep>;
  /** Step 2 for admins: the 6-digit code emailed after the password. */
  verifyLoginCode(email: string, code: string): Promise<AuthStep>;
  resendLoginCode(email: string): Promise<{ demoCode?: string }>;
  /** Step 3: authenticator app or one recovery code. */
  verifyTotp(email: string, code: string): Promise<SignedIn>;
  /** Called on start-up and every sync; null = access ended → sign out (AUTH-05/06). */
  refresh(): Promise<SignedIn | null>;
  signOut(): Promise<void>;

  // configuration pulled to devices
  events(): Promise<EventItem[]>;
  /** Card fields for scanning at this event (its template, else the company default) — D-10. */
  fields(eventId?: string | null): Promise<FieldDefinition[]>;

  // scanning + sync
  readCard(photo: Blob): Promise<ReadResult>;
  syncLead(lead: Lead): Promise<Lead>;
  uploadPhoto(leadId: string, side: 'front' | 'back', photo: Blob): Promise<void>;
  leadsByIds(ids: string[]): Promise<Lead[]>;
  /** Feeds the admin's “waiting on devices” counter (ADM-07). */
  reportOutbox(device: string, waiting: number, oldest: string | null): Promise<void>;
  /** LEAD-05: was this email/phone already captured at this event (by anyone in the company)? Returns capture time. */
  leadExists(eventId: string, email: string, phone: string): Promise<string | null>;

  // leads (S4 online / S5)
  listLeads(f: LeadFilters): Promise<Lead[]>;
  saveLead(lead: Lead, resend: boolean): Promise<Lead>;
  deleteLead(id: string): Promise<void>;
  restoreLead(id: string): Promise<void>;
  recycleBinLeads(): Promise<Lead[]>;
  photoUrl(leadId: string): Promise<string | null>;
  counters(eventId: string): Promise<Counters>;
  exportCsv(f: LeadFilters): Promise<Blob>;

  // tags (leads + scan)
  tags(): Promise<Tag[]>;
  saveTag(t: Omit<Tag, 'company_id' | 'id'> & { id?: string }): Promise<Tag>;
  deleteTag(id: string): Promise<void>;

  /** Excel/CSV import with column mapping (Client Admin). */
  importLeads(rows: ImportRow[], eventId: string, tagIds: string[], fileName: string): Promise<ImportResult>;
  /** Past imports, so an admin can see and open what a file brought in. */
  importHistory(): Promise<ImportBatch[]>;

  // bulk actions on the leads list (checkbox selection)
  bulkTagLeads(ids: string[], add: string[], remove: string[]): Promise<void>;
  bulkDeleteLeads(ids: string[]): Promise<void>;
  /** Re-send to the CRM (admins) — the same path a single “Save & resend” takes. */
  bulkResendLeads(ids: string[]): Promise<void>;

  // notifications + reminders
  notifications(): Promise<AppNotification[]>;
  markNotificationsRead(ids: string[]): Promise<void>;
  /** Stores the browser push subscription for this device (null = unsubscribe). */
  savePushSubscription(sub: PushSubscriptionJSON | null): Promise<void>;

  // account, devices and security
  sessions(): Promise<DeviceSession[]>;
  revokeSession(id: string): Promise<void>;
  revokeOtherSessions(): Promise<void>;
  loginHistory(personId?: string): Promise<LoginEvent[]>;
  securityPolicy(): Promise<SecurityPolicy>;
  saveSecurityPolicy(p: SecurityPolicy): Promise<SecurityPolicy>;
  /** Profile picture; null removes it. */
  saveAvatar(file: File | null): Promise<string | null>;
  updateProfile(p: { name: string; phone: string }): Promise<void>;

  // passwords — every change is confirmed by email. New people set theirs with the same code flow.
  /** Sends a 6-digit code to the address; the same neutral answer for unknown emails. */
  requestPasswordReset(email: string): Promise<{ demoCode?: string }>;
  resetPassword(email: string, code: string, password: string): Promise<void>;
  /** Signed in: asks for the current password, then emails a code to confirm. */
  requestPasswordChange(currentPassword: string): Promise<{ demoCode?: string }>;
  confirmPasswordChange(code: string, password: string): Promise<void>;

  // two-factor + recovery codes
  startMfaEnrolment(): Promise<{ secret: string; otpauth_url: string }>;
  confirmMfaEnrolment(code: string): Promise<RecoveryCodes>;
  disableMfa(code: string): Promise<void>;
  recoveryCodes(): Promise<RecoveryCodes>;
  regenerateRecoveryCodes(): Promise<RecoveryCodes>;

  // S6 team
  people(): Promise<PersonRow[]>;
  seats(): Promise<SeatInfo>;
  /** Creates the account without a password and emails the setup code + link. */
  invite(p: { email: string; name: string; phone: string; role: Exclude<Role, 'super_admin'>; event_ids: string[]; default_event_id: string | null; access_ends_on: string | null }): Promise<Invitation>;
  updatePerson(p: Pick<Person, 'id' | 'name' | 'phone' | 'role' | 'event_ids' | 'default_event_id' | 'access_ends_on' | 'active'>): Promise<void>;

  // S7 settings
  templates(): Promise<FieldTemplate[]>;
  saveTemplate(t: { id?: string; name: string; description: string; is_default: boolean; copy_from?: string }): Promise<FieldTemplate>;
  deleteTemplate(id: string): Promise<void>;
  /** Fields of one template (the editor); `fields()` returns the fields in use for scanning. */
  templateFields(templateId: string): Promise<FieldDefinition[]>;
  uploadAttachment(eventId: string, file: File): Promise<EventItem>;
  deleteAttachment(eventId: string, attachmentId: string): Promise<EventItem>;
  saveEvent(e: Omit<EventItem, 'company_id' | 'id'> & { id?: string }): Promise<EventItem>;
  saveField(f: Omit<FieldDefinition, 'company_id' | 'id'> & { id?: string }): Promise<FieldDefinition>;
  deleteField(id: string): Promise<void>;
  reorderFields(ids: string[]): Promise<void>;
  company(): Promise<Company>;
  saveCompany(c: Partial<Company>): Promise<Company>;
  connections(): Promise<Connection[]>;
  allowedConnectors(): Promise<ConnectorKind[]>;
  connect(kind: ConnectorKind, opts?: { webhook_url?: string }): Promise<Connection>;
  saveConnection(c: Connection): Promise<void>;
  disconnect(id: string): Promise<void>;
  sendTestLead(connectionId: string): Promise<{ ok: boolean; message: string }>;

  // S8 super admin
  companies(): Promise<CompanySummary[]>;
  companyDetail(id: string): Promise<CompanyDetail>;
  /** Update a person's (e.g. company admin's) email address and optionally reinvite them. */
  updatePersonEmail(personId: string, email: string, reinvite?: boolean): Promise<{ ok: boolean; email: string; invitation?: Invitation | null }>;
  /** Suspend or restore a client company. */
  setCompanySuspended(id: string, suspended: boolean, reason: string): Promise<void>;
  setScanLimitAction(id: string, action: ScanLimitAction): Promise<void>;

  /** Written to the audit log (action “error.<name>”) so WeTano can see what failed, where and why. */
  recordClientError(e: ClientErrorReport): Promise<void>;

  // S12 usage (WeTano)
  usage(month: string): Promise<UsageRow[]>;
  usageAlerts(): Promise<UsageAlert[]>;
  saveUsageAlert(a: Omit<UsageAlert, 'id' | 'last_fired_at'> & { id?: string }): Promise<UsageAlert>;
  deleteUsageAlert(id: string): Promise<void>;
  /** Company + licence + its first admin, who is invited the same way as everyone else. */
  createCompany(input: NewCompanyInput): Promise<Invitation>;
  updateLicence(companyId: string, l: Omit<Licence, 'id' | 'company_id'>): Promise<void>;
  licenceHistory(companyId: string): Promise<LicenceChange[]>;

  // S9 subscriptions & billing (WeTano)
  plans(): Promise<Plan[]>;
  savePlan(p: Omit<Plan, 'id'> & { id?: string }): Promise<Plan>;
  /** Refused while any company subscribes to it or any invoice was billed on it (SUB-01). */
  deletePlan(id: string): Promise<void>;
  subscriptions(): Promise<(Subscription & { company_name: string; plan_name: string; mrr: number; currency: string })[]>;
  setSubscription(companyId: string, s: Omit<Subscription, 'company_id'>): Promise<void>;
  invoices(filter?: { company_id?: string; status?: Invoice['status'] | '' }): Promise<Invoice[]>;
  /** The signed-in company's own plan — Settings → Billing & plan (Client Admin). */
  mySubscription(): Promise<{ subscription: Subscription; plan: Plan | null; seats_used: number; scans_this_month: number } | null>;
  createInvoice(i: Omit<Invoice, 'id' | 'number' | 'company_name' | 'plan_name'>): Promise<Invoice>;
  setInvoiceStatus(id: string, status: Invoice['status'], paid: { paid_on: string; paid_by: string } | null): Promise<Invoice>;

  // S10 audit log (WeTano)
  auditLog(f: { q: string; company_id: string; action: string; from: string; to: string }): Promise<AuditEntry[]>;

  // S11 support (WeTano + Client Admin)
  tickets(f?: { status: TicketStatus | ''; company_id: string }): Promise<SupportTicket[]>;
  openTicket(t: { subject: string; body: string; priority: SupportTicket['priority'] }): Promise<SupportTicket>;
  replyTicket(id: string, body: string): Promise<SupportTicket>;
  setTicketStatus(id: string, status: TicketStatus, assigned_to?: string | null): Promise<SupportTicket>;

  sendPhoneOtp(phone: string): Promise<{ ok: boolean; demoCode?: string }>;

  // Individuals & Self-Registered Users (Solo scanner accounts)
  registerIndividual(input: { name: string; email: string; phone?: string; password?: string }): Promise<SignedIn>;
  listIndividuals(): Promise<Person[]>;
  updateIndividualPlan(id: string, plan: 'free' | 'pro'): Promise<void>;
  resetIndividualScans(id: string): Promise<void>;
  toggleIndividualStatus(id: string, active: boolean): Promise<void>;
  deleteIndividual(id: string): Promise<void>;
  upgradeMyPlan(plan: 'pro', cycle: 'monthly' | 'annual', paymentMethod?: string): Promise<void>;
  recordScanUsage(): Promise<{ allowed: boolean; count: number; limit: number; plan: 'free' | 'pro' }>;
  getIndividualPricing(): Promise<IndividualPricingConfig>;
  updateIndividualPricing(input: Partial<IndividualPricingConfig>): Promise<IndividualPricingConfig>;

  // Organizers & Event Referral Management (Super Admin)
  listOrganizers(): Promise<OrganizerDetail[]>;
  createOrganizer(input: {
    event_id?: string;
    event_name: string;
    starts_on: string;
    ends_on: string;
    venue?: string;
    organizer_name: string;
    organizer_email: string;
    password?: string;
    max_logins: number;
  }): Promise<{ organizer: Person; event: EventItem; referral_code: string }>;
  updateOrganizerLogins(organizerId: string, max_logins: number): Promise<void>;
  getOrganizerDetails(id: string): Promise<{ organizer: OrganizerDetail; members: (Person & { lead_count?: number })[]; total_scans: number }>;
  updateOrganizerMember(organizerId: string, memberId: string, input: { active?: boolean; name?: string; phone?: string }): Promise<void>;
  deleteOrganizerMember(organizerId: string, memberId: string): Promise<void>;
  updateOrganizerEvent(organizerId: string, input: { event_name: string; starts_on: string; ends_on: string; venue?: string; max_logins?: number }): Promise<void>;
  registerReferral(input: { name: string; email: string; phone?: string; password?: string; referral_code: string }): Promise<SignedIn>;
}

/**
 *  - api:  the WeTa Snap API (services/api or Vercel Serverless Functions)
 *  - demo: an in-browser mock, so the whole app can be clicked through with nothing installed
 */
const envApiUrl = import.meta.env.VITE_API_URL;
const isVercelHost = typeof window !== 'undefined' && window.location.hostname.endsWith('.vercel.app');
const useApi = (Boolean(envApiUrl) || import.meta.env.VITE_USE_API === 'true' || Boolean(import.meta.env.VERCEL) || isVercelHost) && import.meta.env.VITE_DEMO !== 'true';

let impl: Promise<Backend> | null = null;
/** Lazy so the demo code is never shipped to production users, and vice-versa. */
export function backend(): Promise<Backend> {
  if (!impl) {
    if (useApi) {
      // Check if backend API is reachable; if not, fall back cleanly to in-browser backend
      impl = import('./api')
        .then((m) => m.createApiBackend())
        .catch(() => import('./demo').then((m) => m.createDemoBackend()));
    } else {
      impl = import('./demo').then((m) => m.createDemoBackend());
    }
  }
  return impl;
}

export const isDemo = !useApi;
