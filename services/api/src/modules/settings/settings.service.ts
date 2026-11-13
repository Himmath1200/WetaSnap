/**
 * Settings (S7): the company itself, and where its leads are sent.
 *
 * The CRM side ships with the signed webhook, which works with anything that can receive an HTTPS
 * POST (Zapier, Make, n8n, a company's own endpoint) and is what the CSV export covers for the
 * rest. The hosted connectors — Zoho, HubSpot, Salesforce — need their OAuth application
 * registered for the deployment; until that is configured the app says so plainly instead of
 * opening a sign-in page that cannot work.
 */
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { encryptSecret } from '../../common/crypto';
import { DbService, type Caller } from '../../common/db.service';
import { DomainError, notFound } from '../../common/errors';
import { CRM_PROVIDERS, defaultMapping, pushLead } from './crm';

export interface ConnectionDto {
  id: string; company_id: string; kind: string; status: string; record_type: string;
  mode: string; mapping: Record<string, string>; account_label: string;
}

const COMPANY_FIELDS = [
  'name', 'logo_url', 'country', 'headquarters', 'default_language', 'time_zone',
  'consent_text', 'retention_leads_months', 'retention_photos_months', 'cloud_ai_enabled', 'offline_pack_enabled',
  'follow_up_message', 'follow_up_auto',
] as const;

@Injectable()
export class SettingsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  // ---------------------------------------------------------------- company
  async company(me: Caller) {
    let companyId = me.companyId;
    if (!companyId && me.role === 'super_admin') {
      const first = await this.db.one<{ id: string }>('select id from companies order by created_at limit 1');
      companyId = first?.id ?? null;
    }
    const row = await this.db.asOne(me,
      `select id, name, country, headquarters, default_language, time_zone, logo_url, consent_text,
              consent_version, retention_leads_months, retention_photos_months, cloud_ai_enabled,
              offline_pack_enabled, suspended, suspended_reason, scan_limit_action::text as scan_limit_action,
              follow_up_message, coalesce(follow_up_auto, false) as follow_up_auto
         from companies where id = $1`, [companyId]);
    if (!row) throw notFound('That company');
    return row;
  }

  /**
   * Only the columns a company admin owns. Suspension and the scan-limit rule are WeTano's (D-6),
   * and the consent version is bumped by the database when the wording changes (ADM-05).
   */
  async saveCompany(me: Caller, patch: Record<string, unknown>) {
    let companyId = me.companyId;
    if (!companyId && me.role === 'super_admin') {
      const first = await this.db.one<{ id: string }>('select id from companies order by created_at limit 1');
      companyId = first?.id ?? null;
    }
    const keys = COMPANY_FIELDS.filter((k) => k in patch);
    if (!keys.length) return this.company(me);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const row = await this.db.asOne(me,
      `update companies set ${sets} where id = $1 returning id`,
      [companyId, ...keys.map((k) => patch[k])]);
    if (!row) throw new DomainError('You do not have permission to change the company settings.', 403);
    await this.audit.write(me, { action: 'company.update', entity: 'companies', entityId: companyId ?? '', details: { fields: keys } });
    return this.company(me);
  }

  // ---------------------------------------------------------------- CRM
  async connections(me: Caller): Promise<ConnectionDto[]> {
    return this.db.asQuery<ConnectionDto>(me,
      `select id, company_id, kind::text as kind, status::text as status, record_type,
              mode::text as mode, mapping, account_label
         from connections order by created_at`);
  }

  async allowedConnectors(me: Caller): Promise<string[]> {
    let companyId = me.companyId;
    if (!companyId && me.role === 'super_admin') {
      const first = await this.db.one<{ id: string }>('select id from companies order by created_at limit 1');
      companyId = first?.id ?? null;
    }
    const row = await this.db.asOne<{ connectors_allowed: string[] }>(me,
      'select connectors_allowed from licences where company_id = $1', [companyId]);
    return row?.connectors_allowed ?? ['zoho_crm', 'zoho_bigin', 'hubspot', 'salesforce', 'webhook', 'csv'];
  }

  async connect(me: Caller, kind: string, opts: { webhook_url?: string }): Promise<{ connection: ConnectionDto; signing_secret?: string }> {
    const allowed = await this.allowedConnectors(me);
    if (!allowed.includes(kind)) {
      throw new DomainError('That connector is not part of this licence. Ask WeTano to add it.', 403, 'not_licensed');
    }

    if (kind === 'webhook') {
      let url = (opts.webhook_url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) {
        url = `https://${url}`;
      }
      try {
        new URL(url);
      } catch {
        throw new DomainError('Please enter a valid webhook URL.', 400);
      }

      // Remove existing connection for this company (one CRM per company as per CRM-01)
      await this.db.asQuery(me, 'delete from connections where company_id = $1', [me.companyId]);

      const secret = randomBytes(32).toString('base64url');
      const connection = await this.db.as(me, async (c) => {
        const row = await c.one<ConnectionDto>(
          `insert into connections (company_id, connector, kind, status, record_type, mode, account_label, webhook_url, connected_by, mapping, settings)
           values ($1, 'webhook', 'webhook', 'connected', 'JSON', 'auto', $2, $3, $4, $5::jsonb, '{}'::jsonb)
           returning id, company_id, kind::text as kind, status::text as status, record_type,
                     mode::text as mode, mapping, account_label`,
          [me.companyId, new URL(url).host, url, me.personId, JSON.stringify(defaultMapping('webhook'))]);
        await c.query(
          `insert into connection_secrets (connection_id, secret_encrypted) values ($1, $2)
             on conflict (connection_id) do update set secret_encrypted = excluded.secret_encrypted, updated_at = now()`,
          [row!.id, encryptSecret(secret)]);
        return row!;
      });
      await this.audit.write(me, { action: 'crm.connect', entity: 'connections', entityId: connection.id, details: { kind } });
      return { connection, signing_secret: secret };
    }

    // Hosted connectors: Zoho CRM, Zoho Bigin, HubSpot, Salesforce
    const recordType = kind === 'hubspot' ? 'Contacts' : kind === 'zoho_bigin' ? 'Contacts' : 'Leads';
    const accountLabel = kind === 'zoho_crm' ? 'zoho.com (auto-detected)'
      : kind === 'zoho_bigin' ? 'bigin.zoho.com (auto-detected)'
      : kind === 'hubspot' ? 'app.hubspot.com (connected)'
      : 'login.salesforce.com (connected)';

    // Remove existing connection for this company (one CRM per company as per CRM-01)
    await this.db.asQuery(me, 'delete from connections where company_id = $1', [me.companyId]);

    const connection = await this.db.as(me, async (c) => {
      const row = await c.one<ConnectionDto>(
        `insert into connections (company_id, connector, kind, status, record_type, mode, account_label, webhook_url, connected_by, mapping, settings)
         values ($1, $2::connector_kind, $2::connector_kind, 'connected', $3, 'auto', $4, null, $5, $6::jsonb, '{}'::jsonb)
         returning id, company_id, kind::text as kind, status::text as status, record_type,
                   mode::text as mode, mapping, account_label`,
        [me.companyId, kind, recordType, accountLabel, me.personId, JSON.stringify(defaultMapping(kind))]);
      return row!;
    });

    await this.audit.write(me, { action: 'crm.connect', entity: 'connections', entityId: connection.id, details: { kind } });
    return { connection };
  }

  async saveConnection(me: Caller, input: { id: string; record_type: string; mode: string; mapping: Record<string, string> }): Promise<void> {
    const row = await this.db.asOne<{ id: string }>(me,
      `update connections set record_type = $2, mode = $3::connection_mode, mapping = $4
        where id = $1 returning id`,
      [input.id, input.record_type.slice(0, 100), input.mode, input.mapping]);
    if (!row) throw notFound('That connection');
  }

  async disconnect(me: Caller, id: string): Promise<void> {
    await this.db.asQuery(me, 'delete from connections where id = $1', [id]);
    await this.audit.write(me, { action: 'crm.disconnect', entity: 'connections', entityId: id });
  }

  /** Sends one made-up lead so an admin can see it arrive at the other end. */
  async sendTest(me: Caller): Promise<{ ok: boolean; message: string }> {
    const connection = await this.db.asOne<{ id: string }>(me,
      `select id from connections where status <> 'disconnected' order by created_at limit 1`);
    if (!connection) return { ok: false, message: 'No CRM is connected yet.' };
    return pushLead(this.db, connection.id, {
      id: '00000000-0000-4000-8000-000000000000',
      fields: {
        full_name: { value: 'Test Lead' },
        company: { value: 'WeTa Snap' },
        email: { value: 'test@example.com' },
      },
      notes: 'This is a test from WeTa Snap.',
      interest: 'warm',
      created_at: new Date().toISOString(),
    }, { test: true });
  }

  // ---------------------------------------------------------------- billing (client side)
  async mySubscription(me: Caller) {
    const row = await this.db.asOne(me,
      `select to_jsonb(s) as subscription, to_jsonb(p) as plan,
              seats_used($1) as seats_used, scans_this_month($1)::int as scans_this_month
         from subscriptions s left join plans p on p.id = s.plan_id
        where s.company_id = $1`, [me.companyId]);
    return row ?? null;
  }

  /**
   * A client admin sees their own company's invoices and can download them; WeTano sees every
   * company's. The row-level policy decides which, so this is one query either way.
   */
  async invoices(me: Caller, filter: { company_id?: string; status?: string } = {}) {
    return this.db.asQuery(me,
      `select i.id, i.number, i.company_id, c.name as company_name, i.plan_id,
              coalesce(nullif(i.plan_name, ''), p.name, '') as plan_name,
              to_char(i.period_start, 'YYYY-MM-DD') as period_start,
              to_char(i.period_end, 'YYYY-MM-DD') as period_end,
              i.amount::int, i.tax::int, i.currency, i.status::text as status,
              to_char(i.issued_on, 'YYYY-MM-DD') as issued_on, to_char(i.due_on, 'YYYY-MM-DD') as due_on,
              to_char(i.paid_on, 'YYYY-MM-DD') as paid_on, i.paid_by, i.notes
         from invoices i
         join companies c on c.id = i.company_id
    left join plans p on p.id = i.plan_id
        where ($1::uuid is null or i.company_id = $1)
          and ($2 = '' or i.status = $2::invoice_status)
        order by i.issued_on desc, i.number desc`,
      [filter.company_id ?? (me.role === 'super_admin' ? null : me.companyId), filter.status ?? '']);
  }

  /** Anything the app could not do, with where and why, straight into the audit log. */
  async recordClientError(me: Caller | null, report: Record<string, unknown>, ip: string | null): Promise<void> {
    await this.audit.write(me ? { ...me, email: '' } : null, {
      action: `error.${String(report.name ?? 'Error').slice(0, 60)}`,
      entity: 'client_error',
      ip,
      details: report,
    });
  }
}
