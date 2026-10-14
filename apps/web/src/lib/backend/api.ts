/**
 * The real backend: the WeTa Snap API (services/api) over HTTPS — NestJS, PostgreSQL, Redis or
 * PostgreSQL for the queue, and object storage for the card images.
 *
 * It mirrors the demo backend one for one, so every screen behaves the same whichever is in use.
 * Three things worth knowing while reading:
 *
 *   · the session is one opaque bearer token kept in localStorage; the server stores only its
 *     hash, so the row it keeps is useless to anyone who copies it
 *   · every call goes through `send`, which turns any failure into one plain sentence and keeps
 *     the server's reason code (scan_limit, seats_exhausted…) for the screens that react to it
 *   · images are fetched with the token and handed to the UI as object URLs, because an <img>
 *     tag cannot send an Authorization header
 */
import type {
  AuthStep, Backend, ClientErrorReport, CompanyDetail, Counters, Door, ImportResult, Invitation,
  LicenceChange, PersonRow, ReadResult, SeatInfo, SignedIn,
} from './index';
import type {
  AppNotification, AuditEntry, Company, CompanySummary, Connection, ConnectorKind, DeviceSession,
  EventItem, FieldDefinition, FieldTemplate, ImportBatch, Invoice, Lead, LoginEvent,
  Person, Plan, RecoveryCodes, ScanLimitAction, SecurityPolicy, Subscription, SupportTicket, Tag,
  TicketStatus, UsageAlert, UsageRow,
} from '../types';
import { OfflineError, isOnline } from '../net';

const BASE = String(import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const TOKEN_KEY = 'wetasnap-token';

export function createApiBackend(): Backend {
  let token: string | null = localStorage.getItem(TOKEN_KEY) ?? null;
  /** The event the app is working in, so a card is read with that event's fields (D-10). */
  let eventId: string | null = null;

  const setToken = (next: string | null) => {
    token = next;
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  };

  /** One place where a request is made, and the only place an error is turned into words. */
  async function send<T>(path: string, init: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<T> {
    if (!isOnline()) throw new OfflineError();
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method: init.method ?? (init.body ? 'POST' : 'GET'),
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
    } catch {
      throw new OfflineError();                           // DNS, TLS, the server is simply not there
    }

    if (res.status === 204) return undefined as T;
    if (init.raw && res.ok) return (await res.blob()) as T;

    const body = await res.json().catch(() => null) as { error?: string; code?: string } | null;
    if (!res.ok) {
      if (res.status === 401) setToken(null);             // this device has to sign in again
      const message = body?.error
        ?? (res.status >= 500 ? 'The server is not answering just now. Please try again in a moment.'
          : res.status === 404 ? 'That is not available on this deployment.'
            : 'Something went wrong. Please try again.');
      const error = new Error(message) as Error & { code?: string; status?: number };
      error.status = res.status;
      if (body?.code) {
        error.code = body.code;
        if (body.code === 'scan_limit') error.name = 'ScanLimitReached';
      }
      throw error;
    }
    return body as T;
  }

  /** An image the UI can put straight into an <img>, fetched with the session token. */
  async function objectUrl(path: string): Promise<string | null> {
    if (!isOnline()) return null;
    const res = await fetch(`${BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  }

  const toBase64 = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });

  /** What the app shows in "Active sessions": Android · Chrome. */
  const deviceLabel = () => {
    const ua = navigator.userAgent;
    const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Mac/i.test(ua) ? 'macOS'
      : /Windows/i.test(ua) ? 'Windows' : 'Other';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox/.test(ua) ? 'Firefox' : /Chrome/.test(ua) ? 'Chrome'
      : /Safari/.test(ua) ? 'Safari' : 'Browser';
    return `${os} · ${browser}`;
  };

  /** The server answers each sign-in step the same way; this keeps the token and passes it on. */
  function step(answer: AuthStep & { token?: string }): AuthStep {
    if (answer.token) setToken(answer.token);
    if (answer.next === 'done') {
      const done = answer as AuthStep & { token: string; session_id: string; person: Person; company: Company | null };
      return { next: 'done', token: done.token, person: done.person, company: done.company, session_id: done.session_id };
    }
    return { next: answer.next };
  }

  return {
    mode: 'api',
    setToken,

    // ---------------------------------------------------------------- S1 · sign-in
    async signInWithPassword(email, password, door: Door) {
      return step(await send<AuthStep & { token?: string }>('/v1/auth/password', {
        body: { email: email.trim().toLowerCase(), password, door, device: deviceLabel() },
      }));
    },
    async verifyLoginCode(_email, code) {
      return step(await send<AuthStep & { token?: string }>('/v1/auth/code/verify', { body: { code } }));
    },
    async resendLoginCode() {
      await send('/v1/auth/code/resend', { body: {} });
      return {};
    },
    async verifyTotp(_email, code) {
      const answer = step(await send<AuthStep & { token?: string }>('/v1/auth/totp/verify', { body: { code } }));
      if (answer.next !== 'done') throw new Error('Please sign in again.');
      return answer;
    },
    async refresh() {
      if (!token) return null;
      const who = await send<(SignedIn & { session_id: string }) | null>('/v1/auth/me').catch(() => null);
      return who ? { ...who, token: token! } : null;
    },
    async signOut() {
      await send('/v1/auth/signout', { body: {} }).catch(() => {});
      setToken(null);
    },

    // ---------------------------------------------------------------- passwords
    async requestPasswordReset(email) {
      await send('/v1/auth/password/forgot', { body: { email: email.trim().toLowerCase() } });
      return {};
    },
    async resetPassword(email, code, password) {
      await send('/v1/auth/password/reset', { body: { email: email.trim().toLowerCase(), code, password } });
    },
    async requestPasswordChange(currentPassword) {
      await send('/v1/auth/password/change/request', { body: { current_password: currentPassword } });
      return {};
    },
    async confirmPasswordChange(code, password) {
      await send('/v1/auth/password/change/confirm', { body: { code, password } });
    },

    // ---------------------------------------------------------------- two-factor
    async startMfaEnrolment() { return send('/v1/me/mfa/start', { body: {} }); },
    async confirmMfaEnrolment(code) { return send<RecoveryCodes>('/v1/me/mfa/confirm', { body: { code } }); },
    async disableMfa(code) { await send('/v1/me/mfa/disable', { body: { code } }); },
    async recoveryCodes() { return send<RecoveryCodes>('/v1/me/mfa/recovery-codes'); },
    async regenerateRecoveryCodes() { return send<RecoveryCodes>('/v1/me/mfa/recovery-codes', { body: {} }); },

    // ---------------------------------------------------------------- account & security
    async sessions() { return send<DeviceSession[]>('/v1/me/sessions'); },
    async revokeSession(id) { await send(`/v1/me/sessions/${id}`, { method: 'DELETE' }); },
    async revokeOtherSessions() { await send('/v1/me/sessions/revoke-others', { body: {} }); },
    async loginHistory(personId) {
      return send<LoginEvent[]>(`/v1/me/history${personId ? `?person_id=${personId}` : ''}`);
    },
    async securityPolicy() { return send<SecurityPolicy>('/v1/auth/policy'); },
    async saveSecurityPolicy(policy) { return send<SecurityPolicy>('/v1/me/policy', { method: 'PUT', body: policy }); },
    async saveAvatar(file) {
      if (!file) {
        await send('/v1/me/avatar', { method: 'PUT', body: { data: null } });
        return null;
      }
      if (file.size > 4 * 1024 * 1024) throw new Error('Please use a picture under 4 MB.');
      const answer = await send<{ avatar_url: string | null }>('/v1/me/avatar', {
        method: 'PUT', body: { data: await toBase64(file), mime: file.type || 'image/jpeg' },
      });
      return answer.avatar_url;
    },
    async updateProfile(patch) { await send('/v1/me/profile', { method: 'PUT', body: patch }); },

    // ---------------------------------------------------------------- configuration
    async events() { return send<EventItem[]>('/v1/events'); },
    async fields(event) {
      if (event !== undefined) eventId = event;
      return send<FieldDefinition[]>(`/v1/fields${event ? `?event_id=${event}` : ''}`);
    },

    // ---------------------------------------------------------------- scanning
    async readCard(photo) {
      const answer = await send<{ fields: ReadResult; raw_text?: string; engines?: string[] }>('/v1/scan/read', {
        body: { image: await toBase64(photo), mime: photo.type || 'image/jpeg', event_id: eventId },
      });
      // OCR-LOG: popup shows the raw OCR text right after the scan.
      const { pushOcrText } = await import('../ocrLog');
      const raw = typeof answer.raw_text === 'string' && answer.raw_text.trim()
        ? answer.raw_text
        : Object.values(answer.fields ?? {}).map((v) => v?.value).filter(Boolean).join('\n');
      pushOcrText(raw, `server read (${(answer.engines ?? []).join(', ') || 'ocr'})`);
      return answer.fields;
    },
    async syncLead(lead) {
      eventId = lead.event_id || eventId;
      return send<Lead>('/v1/leads/sync', { body: lead });
    },
    async uploadPhoto(leadId, side, photo) {
      await send('/v1/scan/photo', {
        body: { lead_id: leadId, side, image: await toBase64(photo), mime: photo.type || 'image/jpeg' },
      });
    },
    async leadsByIds(ids) { return send<Lead[]>('/v1/leads/by-ids', { body: { ids } }); },
    async reportOutbox(device, waiting, oldest) {
      await send('/v1/leads/outbox', { body: { device, waiting, oldest } }).catch(() => {});
    },
    async leadExists(event, email, phone) {
      const query = new URLSearchParams({ event_id: event, email, phone });
      const answer = await send<{ at: string | null }>(`/v1/leads/exists?${query}`);
      return answer.at;
    },

    // ---------------------------------------------------------------- leads
    async listLeads(filters) { return send<Lead[]>('/v1/leads/search', { body: filters }); },
    async saveLead(lead, resend) {
      return send<Lead>(`/v1/leads/${lead.id}`, { method: 'PUT', body: { ...lead, resend } });
    },
    async deleteLead(id) { await send(`/v1/leads/${id}`, { method: 'DELETE' }); },
    async photoUrl(leadId) { return objectUrl(`/v1/files/card/${leadId}/front`); },
    async counters(event) {
      return send<Counters>(`/v1/leads/counters${event ? `?event_id=${event}` : ''}`);
    },
    async exportCsv(filters) { return send<Blob>('/v1/leads/export', { body: filters, raw: true }); },

    // ---------------------------------------------------------------- tags
    async tags() { return send<Tag[]>('/v1/tags'); },
    async saveTag(tag) { return send<Tag>('/v1/tags', { body: tag }); },
    async deleteTag(id) { await send(`/v1/tags/${id}`, { method: 'DELETE' }); },

    // ---------------------------------------------------------------- import & bulk
    async importLeads(rows, event, tagIds, fileName) {
      return send<ImportResult>('/v1/leads/import', {
        body: { rows, event_id: event, tag_ids: tagIds, file_name: fileName },
      });
    },
    async importHistory() { return send<ImportBatch[]>('/v1/leads/imports'); },
    async bulkTagLeads(ids, add, remove) { await send('/v1/leads/bulk/tag', { body: { ids, add, remove } }); },
    async bulkDeleteLeads(ids) { await send('/v1/leads/bulk/delete', { body: { ids } }); },
    async bulkResendLeads(ids) { await send('/v1/leads/bulk/resend', { body: { ids } }); },

    // ---------------------------------------------------------------- notifications
    async notifications() { return send<AppNotification[]>('/v1/notifications'); },
    async markNotificationsRead(ids) { await send('/v1/notifications/read', { body: { ids } }); },
    async savePushSubscription(sub) {
      await send('/v1/notifications/push', {
        body: { subscription: sub, device: navigator.userAgent.slice(0, 120) },
      });
    },

    // ---------------------------------------------------------------- team
    async people() { return send<PersonRow[]>('/v1/team'); },
    async seats() { return send<SeatInfo>('/v1/team/seats'); },
    async invite(person) { return send<Invitation>('/v1/team/invite', { body: person }); },
    async updatePerson(person) {
      await send(`/v1/team/${person.id}`, { method: 'PUT', body: person });
    },

    // ---------------------------------------------------------------- settings
    async templates() { return send<FieldTemplate[]>('/v1/templates'); },
    async saveTemplate(template) { return send<FieldTemplate>('/v1/templates', { body: template }); },
    async deleteTemplate(id) { await send(`/v1/templates/${id}`, { method: 'DELETE' }); },
    async templateFields(templateId) { return send<FieldDefinition[]>(`/v1/fields?template_id=${templateId}`); },
    async uploadAttachment(event, file) {
      if (file.size > 10 * 1024 * 1024) throw new Error('Please keep attachments under 10 MB.');
      return send<EventItem>(`/v1/events/${event}/attachments`, {
        body: { name: file.name, mime: file.type || 'application/octet-stream', data: await toBase64(file) },
      });
    },
    async deleteAttachment(event, attachmentId) {
      return send<EventItem>(`/v1/events/${event}/attachments/${attachmentId}`, { method: 'DELETE' });
    },
    async saveEvent(event) { return send<EventItem>('/v1/events', { body: event }); },
    async saveField(field) { return send<FieldDefinition>('/v1/fields', { body: field }); },
    async deleteField(id) { await send(`/v1/fields/${id}`, { method: 'DELETE' }); },
    async reorderFields(ids) { await send('/v1/fields/reorder', { body: { ids } }); },
    async company() { return send<Company>('/v1/company'); },
    async saveCompany(patch) { return send<Company>('/v1/company', { method: 'PATCH', body: patch }); },

    // ---------------------------------------------------------------- CRM
    async connections() { return send<Connection[]>('/v1/connections'); },
    async allowedConnectors() {
      const answer = await send<{ allowed: ConnectorKind[] }>('/v1/connectors');
      return answer.allowed;
    },
    async connect(kind, opts) {
      const answer = await send<{ connection: Connection; signing_secret?: string }>('/v1/connections', {
        body: { kind, webhook_url: opts?.webhook_url },
      });
      if (answer.signing_secret) {
        alert(`Webhook connected.\n\nSigning secret (shown once — store it in the receiving system to verify the X-WetaSnap-Signature header):\n\n${answer.signing_secret}`);
      }
      return answer.connection;
    },
    async saveConnection(connection) {
      await send(`/v1/connections/${connection.id}`, {
        method: 'PUT',
        body: { record_type: connection.record_type, mode: connection.mode, mapping: connection.mapping },
      });
    },
    async disconnect(id) { await send(`/v1/connections/${id}`, { method: 'DELETE' }); },
    async sendTestLead() { return send<{ ok: boolean; message: string }>('/v1/connections/test', { body: {} }); },

    // ---------------------------------------------------------------- errors
    async recordClientError(report: ClientErrorReport) {
      // Error reporting must never cause another error.
      await send('/v1/client-errors', { body: report }).catch(() => {});
    },

    // ---------------------------------------------------------------- S8 · WeTano
    async companies() { return send<CompanySummary[]>('/v1/admin/companies'); },
    async companyDetail(id) { return send<CompanyDetail>(`/v1/admin/companies/${id}`); },
    async setCompanySuspended(id, suspended, reason) {
      await send(`/v1/admin/companies/${id}/suspend`, { body: { suspended, reason } });
    },
    async setScanLimitAction(id, action: ScanLimitAction) {
      await send(`/v1/admin/companies/${id}/scan-limit`, { body: { action } });
    },
    async createCompany(input) { return send<Invitation>('/v1/admin/companies', { body: input }); },
    async updateLicence(companyId, licence) {
      await send(`/v1/admin/companies/${companyId}/licence`, { method: 'PUT', body: licence });
    },
    async licenceHistory(companyId) {
      return send<LicenceChange[]>(`/v1/admin/companies/${companyId}/licence-history`);
    },

    // ---------------------------------------------------------------- usage
    async usage(month) { return send<UsageRow[]>(`/v1/admin/usage?month=${month}`); },
    async usageAlerts() { return send<UsageAlert[]>('/v1/admin/usage/alerts'); },
    async saveUsageAlert(alert) { return send<UsageAlert>('/v1/admin/usage/alerts', { body: alert }); },
    async deleteUsageAlert(id) { await send(`/v1/admin/usage/alerts/${id}`, { method: 'DELETE' }); },

    // ---------------------------------------------------------------- plans & billing
    async plans() { return send<Plan[]>('/v1/admin/plans'); },
    async savePlan(plan) { return send<Plan>('/v1/admin/plans', { body: plan }); },
    async deletePlan(id) { await send(`/v1/admin/plans/${id}`, { method: 'DELETE' }); },
    async subscriptions() {
      return send<(Subscription & { company_name: string; plan_name: string; mrr: number; currency: string })[]>('/v1/admin/subscriptions');
    },
    async setSubscription(companyId, subscription) {
      await send(`/v1/admin/subscriptions/${companyId}`, { method: 'PUT', body: subscription });
    },
    async mySubscription() {
      return send<{ subscription: Subscription; plan: Plan | null; seats_used: number; scans_this_month: number } | null>('/v1/subscription');
    },
    async invoices(filter) {
      const query = new URLSearchParams();
      if (filter?.company_id) query.set('company_id', filter.company_id);
      if (filter?.status) query.set('status', filter.status);
      // One route for both: a client admin gets their own company's, WeTano every company's.
      return send<Invoice[]>(`/v1/invoices?${query}`);
    },
    async createInvoice(invoice) { return send<Invoice>('/v1/admin/invoices', { body: invoice }); },
    async setInvoiceStatus(id, status, paid) {
      return send<Invoice>(`/v1/admin/invoices/${id}/status`, { method: 'PUT', body: { status, paid } });
    },

    // ---------------------------------------------------------------- audit & support
    async auditLog(filters) {
      const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]);
      return send<AuditEntry[]>(`/v1/admin/audit?${query}`);
    },
    async tickets(filter) {
      const query = new URLSearchParams();
      if (filter?.status) query.set('status', filter.status);
      if (filter?.company_id) query.set('company_id', filter.company_id);
      return send<SupportTicket[]>(`/v1/support?${query}`);
    },
    async openTicket(ticket) { return send<SupportTicket>('/v1/support', { body: ticket }); },
    async replyTicket(id, body) { return send<SupportTicket>(`/v1/support/${id}/reply`, { body: { body } }); },
    async setTicketStatus(id, status: TicketStatus, assignedTo) {
      return send<SupportTicket>(`/v1/support/${id}/status`, {
        method: 'PUT', body: { status, assigned_to: assignedTo ?? null },
      });
    },
  };
}
