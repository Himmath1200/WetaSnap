/**
 * The WeTano Console (S8–S12): client companies and their licences, plans, subscriptions,
 * invoices, usage and the audit log.
 *
 * Every method here is for super admins only — the guard says so and the row-level policies say so
 * again, so a mistake in one of them is not enough to open a door.
 */
import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { DbService, type Caller } from '../../common/db.service';
import { DomainError, notFound } from '../../common/errors';
import { TeamService, type Invitation } from '../team/team.service';

export interface CompanySummaryDto extends Record<string, unknown> {
  id: string; name: string; licence: Record<string, unknown>; licence_status: string;
  seats_used: number; scans_this_month: number;
}

const COMPANY_SUMMARY = `
  select c.id, c.name, c.country, c.headquarters, c.default_language, c.time_zone, c.logo_url,
         c.consent_text, c.consent_version, c.retention_leads_months, c.retention_photos_months,
         c.cloud_ai_enabled, c.offline_pack_enabled, c.suspended, c.suspended_reason,
         c.scan_limit_action::text as scan_limit_action,
         to_jsonb(l) - 'reminders_sent' as licence,
         licence_status(c.id) as licence_status,
         seats_used(c.id) as seats_used,
         scans_this_month(c.id)::int as scans_this_month
    from companies c left join licences l on l.company_id = c.id`;

@Injectable()
export class AdminService {
  constructor(private readonly db: DbService, private readonly team: TeamService, private readonly audit: AuditService) {}

  // ---------------------------------------------------------------- companies
  async companies(me: Caller): Promise<CompanySummaryDto[]> {
    return this.db.asQuery<CompanySummaryDto>(me, `${COMPANY_SUMMARY} order by c.name`);
  }

  async companyDetail(me: Caller, id: string) {
    const company = await this.db.asOne<CompanySummaryDto>(me, `${COMPANY_SUMMARY} where c.id = $1`, [id]);
    if (!company) throw notFound('That company');
    const [admins, subscription] = await Promise.all([
      this.db.asQuery(me,
        `select id, name, email, phone, active, invited, last_sign_in_at
           from people where company_id = $1 and role = 'client_admin' order by name`, [id]),
      this.db.asOne<{ plan_name: string; billing_cycle: string }>(me,
        `select coalesce(p.name, 'No plan') as plan_name, s.billing_cycle::text as billing_cycle
           from subscriptions s left join plans p on p.id = s.plan_id where s.company_id = $1`, [id]),
    ]);
    return {
      ...company,
      admins,
      plan_name: subscription?.plan_name ?? 'No plan',
      billing_cycle: subscription?.billing_cycle ?? 'monthly',
    };
  }

  /** LIC-01: company, licence, subscription and the first admin's invitation, in one step. */
  async createCompany(me: Caller, input: {
    name: string; country: string; admin_name: string; admin_email: string;
    licence: { type: string; starts_on: string; ends_on: string; seats: number; scans_per_month: number; connectors_allowed: string[] };
  }): Promise<Invitation & { company_id: string }> {
    const taken = await this.db.one<{ id: string }>('select id from people where lower(email) = lower($1)', [input.admin_email]);
    if (taken) throw new DomainError('This email already has access.', 409, 'email_taken');

    const companyId = await this.db.tx(async (c) => {
      const company = await c.one<{ id: string }>(
        'insert into companies (name, country) values ($1, $2) returning id', [input.name.trim(), input.country.trim()]);
      const id = company!.id;
      await c.query(
        `insert into licences (company_id, type, starts_on, ends_on, seats, scans_per_month, connectors_allowed)
         values ($1, $2::licence_type, $3, $4, $5, $6, $7)`,
        [id, input.licence.type, input.licence.starts_on, input.licence.ends_on, input.licence.seats,
          input.licence.scans_per_month, input.licence.connectors_allowed]);
      await c.query('insert into subscriptions (company_id) values ($1)', [id]);
      await c.query(
        `insert into licence_history (licence_id, company_id, changed_by, action, new_values, summary)
         select l.id, l.company_id, $2, 'created', to_jsonb(l),
                initcap($3) || ' licence created · ' || l.seats || ' seats · ' ||
                case when l.scans_per_month = 0 then 'unlimited' else l.scans_per_month::text end || ' scans'
           from licences l where l.company_id = $1`,
        [id, me.personId, input.licence.type]);

      // Every company starts with the standard card and its default template (D-7).
      const template = await c.one<{ id: string }>(
        `insert into field_templates (company_id, name, description, is_default)
         values ($1, 'Standard card', 'Created with the company', true) returning id`, [id]);
      const fields: [string, string, string, boolean][] = [
        ['full_name', 'Full name', 'text', true],
        ['job_title', 'Job title', 'text', false],
        ['company', 'Company', 'text', true],
        ['email', 'Email', 'email', true],
        ['phone', 'Phone', 'phone', false],
        ['mobile', 'Mobile', 'phone', false],
        ['website', 'Website', 'link', false],
        ['country', 'Country', 'text', false],
      ];
      for (const [i, [key, label, type, required]] of fields.entries()) {
        await c.query(
          `insert into field_definitions (company_id, template_id, key, label, type, required, sort_order)
           values ($1, $2, $3, $4, $5::field_type, $6, $7)`,
          [id, template!.id, key, label, type, required, i]);
      }
      return id;
    });

    await this.audit.write(me, { action: 'company.create', entity: 'companies', entityId: companyId, companyId, details: { name: input.name } });
    const invitation = await this.team.invite(me, {
      email: input.admin_email, name: input.admin_name, phone: '', role: 'client_admin',
      event_ids: [], default_event_id: null, access_ends_on: null, company_id: companyId,
    });
    return { ...invitation, company_id: companyId };
  }

  async setSuspended(me: Caller, id: string, suspended: boolean, reason: string): Promise<void> {
    await this.db.asQuery(me,
      'update companies set suspended = $2, suspended_reason = $3 where id = $1',
      [id, suspended, reason.slice(0, 500)]);
    if (suspended) {
      await this.db.query(
        `update device_sessions set revoked_at = now()
          where revoked_at is null and person_id in (select id from people where company_id = $1)`, [id]);
    }
    await this.audit.write(me, {
      action: suspended ? 'company.suspend' : 'company.restore', entity: 'companies', entityId: id,
      companyId: id, details: { reason },
    });
  }

  async setScanLimitAction(me: Caller, id: string, action: string): Promise<void> {
    await this.db.asQuery(me, 'update companies set scan_limit_action = $2::scan_limit_action where id = $1', [id, action]);
    await this.audit.write(me, { action: 'company.scan_limit', entity: 'companies', entityId: id, companyId: id, details: { action } });
  }

  async updateLicence(me: Caller, companyId: string, licence: {
    type: string; starts_on: string; ends_on: string; seats: number; scans_per_month: number; connectors_allowed: string[];
  }): Promise<void> {
    await this.db.as(me, async (c) => {
      const before = await c.one<Record<string, unknown>>('select * from licences where company_id = $1', [companyId]);
      if (!before) throw notFound('That licence');
      const after = await c.one<Record<string, unknown>>(
        `update licences set type = $2::licence_type, starts_on = $3, ends_on = $4, seats = $5,
                scans_per_month = $6, connectors_allowed = $7, reminders_sent = '{}'
           where company_id = $1 returning *`,
        [companyId, licence.type, licence.starts_on, licence.ends_on, licence.seats,
          licence.scans_per_month, licence.connectors_allowed]);
      const changes: string[] = [];
      if (before.ends_on !== after!.ends_on) changes.push(`valid till ${licence.ends_on}`);
      if (before.seats !== after!.seats) changes.push(`seats ${before.seats} → ${licence.seats}`);
      if (before.type !== after!.type) changes.push(`type ${before.type} → ${licence.type}`);
      if (before.scans_per_month !== after!.scans_per_month) {
        changes.push(`scans/month ${licence.scans_per_month || 'unlimited'}`);
      }
      await c.query(
        `insert into licence_history (licence_id, company_id, changed_by, action, old_values, new_values, summary)
         values ($1, $2, $3, 'updated', $4, $5, $6)`,
        [after!.id, companyId, me.personId, before, after, changes.join(' · ') || 'No change']);
    });
    await this.audit.write(me, { action: 'licence.update', entity: 'licences', entityId: companyId, companyId });
  }

  async licenceHistory(me: Caller, companyId: string) {
    const rows = await this.db.asQuery<{ changed_at: string; changed_by: string | null; summary: string }>(me,
      `select changed_at, changed_by::text, summary from licence_history
        where company_id = $1 order by changed_at desc limit 100`, [companyId]);
    return rows.map((r) => ({ at: r.changed_at, by: r.changed_by ? 'WeTano' : 'system', summary: r.summary }));
  }

  // ---------------------------------------------------------------- usage
  async usage(me: Caller, month: string) {
    return this.db.asQuery(me,
      `select c.id as company_id, c.name as company_name, $1 as month,
              coalesce(sum(u.quantity) filter (where u.kind = 'scan'), 0)::int as scans,
              coalesce(l.scans_per_month, 0) as scan_limit,
              coalesce(sum(u.quantity) filter (where u.kind = 'ai_read'), 0)::int as ai_reads,
              coalesce(sum(u.quantity) filter (where u.kind = 'crm_push'), 0)::int as crm_pushes,
              coalesce(sum(u.quantity) filter (where u.kind = 'sync'), 0)::int as syncs,
              coalesce((select round(sum(bc.size_bytes) / 1048576.0)::int from business_cards bc
                         where bc.company_id = c.id), 0) as storage_mb,
              seats_used(c.id) as seats_used,
              coalesce(l.seats, 0) as seats,
              c.suspended, c.scan_limit_action::text as scan_limit_action
         from companies c
    left join licences l on l.company_id = c.id
    left join usage_events u on u.company_id = c.id and to_char(u.at, 'YYYY-MM') = $1
        group by c.id, c.name, l.scans_per_month, l.seats, c.suspended, c.scan_limit_action
        order by scans desc, c.name`,
      [month]);
  }

  async usageAlerts(me: Caller) {
    return this.db.asQuery(me,
      `select id, company_id, metric::text as metric, threshold_pct, active, last_fired_at
         from usage_alerts order by created_at`);
  }

  async saveUsageAlert(me: Caller, input: { id?: string; company_id: string | null; metric: string; threshold_pct: number; active: boolean }) {
    const row = input.id
      ? await this.db.asOne(me,
        `update usage_alerts set company_id = $2, metric = $3::usage_metric, threshold_pct = $4, active = $5
           where id = $1 returning id, company_id, metric::text as metric, threshold_pct, active, last_fired_at`,
        [input.id, input.company_id, input.metric, input.threshold_pct, input.active])
      : await this.db.asOne(me,
        `insert into usage_alerts (company_id, metric, threshold_pct, active)
         values ($1, $2::usage_metric, $3, $4)
         returning id, company_id, metric::text as metric, threshold_pct, active, last_fired_at`,
        [input.company_id, input.metric, input.threshold_pct, input.active]);
    if (!row) throw notFound('That alert');
    return row;
  }

  async deleteUsageAlert(me: Caller, id: string) {
    await this.db.asQuery(me, 'delete from usage_alerts where id = $1', [id]);
  }

  // ---------------------------------------------------------------- plans & billing
  async plans(me: Caller) {
    return this.db.asQuery(me,
      `select id, name, description, price_month::int, price_year::int, currency, seats,
              scans_per_month, connectors_allowed, features, active
         from plans order by price_month`);
  }

  async savePlan(me: Caller, input: Record<string, unknown> & { id?: string }) {
    const row = input.id
      ? await this.db.asOne(me,
        `update plans set name = $2, description = $3, price_month = $4, price_year = $5, currency = $6,
                seats = $7, scans_per_month = $8, connectors_allowed = $9, features = $10, active = $11
           where id = $1
         returning id, name, description, price_month::int, price_year::int, currency, seats,
                   scans_per_month, connectors_allowed, features, active`,
        [input.id, input.name, input.description, input.price_month, input.price_year, input.currency,
          input.seats, input.scans_per_month, input.connectors_allowed, input.features, input.active])
      : await this.db.asOne(me,
        `insert into plans (name, description, price_month, price_year, currency, seats,
                            scans_per_month, connectors_allowed, features, active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning id, name, description, price_month::int, price_year::int, currency, seats,
                   scans_per_month, connectors_allowed, features, active`,
        [input.name, input.description, input.price_month, input.price_year, input.currency,
          input.seats, input.scans_per_month, input.connectors_allowed, input.features, input.active]);
    if (!row) throw notFound('That plan');
    await this.audit.write(me, { action: input.id ? 'plan.update' : 'plan.create', entity: 'plans', entityId: (row as { id: string }).id, details: { name: input.name } });
    return row;
  }

  /** SUB-01: refused while any company is on it or any invoice was billed on it. */
  async deletePlan(me: Caller, id: string): Promise<void> {
    const row = await this.db.asOne<{ name: string }>(me, 'delete from plans where id = $1 returning name', [id]);
    if (!row) throw notFound('That plan');
    await this.audit.write(me, { action: 'plan.delete', entity: 'plans', entityId: id, details: { name: row.name } });
  }

  async subscriptions(me: Caller) {
    return this.db.asQuery(me,
      `select s.company_id, c.name as company_name, s.plan_id, coalesce(p.name, 'No plan') as plan_name,
              s.billing_cycle::text as billing_cycle, to_char(s.renews_on, 'YYYY-MM-DD') as renews_on,
              s.auto_renew, coalesce(p.currency, 'EUR') as currency,
              case when s.billing_cycle = 'annual' then round(coalesce(p.price_year, 0) / 12.0)::int
                   else coalesce(p.price_month, 0)::int end as mrr
         from subscriptions s
         join companies c on c.id = s.company_id
    left join plans p on p.id = s.plan_id
        order by c.name`);
  }

  async setSubscription(me: Caller, companyId: string, input: { plan_id: string | null; billing_cycle: string; renews_on: string; auto_renew: boolean }) {
    await this.db.asQuery(me,
      `insert into subscriptions (company_id, plan_id, billing_cycle, renews_on, auto_renew)
       values ($1, $2, $3::billing_cycle, $4, $5)
       on conflict (company_id) do update
          set plan_id = excluded.plan_id, billing_cycle = excluded.billing_cycle,
              renews_on = excluded.renews_on, auto_renew = excluded.auto_renew`,
      [companyId, input.plan_id, input.billing_cycle, input.renews_on, input.auto_renew]);
    await this.audit.write(me, { action: 'subscription.update', entity: 'subscriptions', entityId: companyId, companyId });
  }

  async invoices(me: Caller, filter: { company_id?: string; status?: string }) {
    return this.db.asQuery(me,
      `select i.id, i.number, i.company_id, c.name as company_name, i.plan_id,
              coalesce(nullif(i.plan_name, ''), p.name, '') as plan_name,
              to_char(i.period_start, 'YYYY-MM-DD') as period_start,
              to_char(i.period_end, 'YYYY-MM-DD') as period_end,
              i.amount::int, i.tax::int, i.currency, i.status::text as status,
              to_char(i.issued_on, 'YYYY-MM-DD') as issued_on, to_char(i.due_on, 'YYYY-MM-DD') as due_on,
              to_char(i.paid_on, 'YYYY-MM-DD') as paid_on, i.paid_by, i.notes
         from invoices i join companies c on c.id = i.company_id
    left join plans p on p.id = i.plan_id
        where ($1::uuid is null or i.company_id = $1)
          and ($2 = '' or i.status = $2::invoice_status)
        order by i.issued_on desc, i.number desc`,
      [filter.company_id ?? null, filter.status ?? '']);
  }

  async createInvoice(me: Caller, input: Record<string, unknown>) {
    const number = await this.db.one<{ number: string }>(`select next_document_number('INV') as number`);
    const row = await this.db.asOne<{ id: string }>(me,
      `insert into invoices (number, company_id, plan_id, plan_name, period_start, period_end,
                             amount, tax, currency, status, issued_on, due_on, notes)
       values ($1, $2, $3, coalesce((select name from plans where id = $3), ''), $4, $5, $6, $7, $8,
               $9::invoice_status, $10, $11, $12)
       returning id`,
      [number!.number, input.company_id, input.plan_id ?? null, input.period_start, input.period_end,
        input.amount, input.tax, input.currency, input.status, input.issued_on, input.due_on, input.notes ?? '']);
    await this.audit.write(me, { action: 'invoice.create', entity: 'invoices', entityId: row!.id, companyId: String(input.company_id), details: { number: number!.number } });
    const [invoice] = await this.invoices(me, { company_id: String(input.company_id) });
    return invoice;
  }

  async setInvoiceStatus(me: Caller, id: string, status: string, paid: { paid_on: string; paid_by: string } | null) {
    const row = await this.db.asOne<{ company_id: string }>(me,
      `update invoices set status = $2::invoice_status,
              paid_on = case when $2 = 'paid' then coalesce($3::date, current_date) else null end,
              paid_by = case when $2 = 'paid' then coalesce($4, paid_by) else '' end
        where id = $1 returning company_id`,
      [id, status, paid?.paid_on ?? null, paid?.paid_by ?? null]);
    if (!row) throw notFound('That invoice');
    await this.audit.write(me, { action: 'invoice.status', entity: 'invoices', entityId: id, companyId: row.company_id, details: { status } });
    const invoices = await this.invoices(me, {});
    return invoices.find((i) => (i as { id: string }).id === id);
  }

  // ---------------------------------------------------------------- audit log
  async auditLog(me: Caller, filter: { q: string; company_id: string; action: string; from: string; to: string }) {
    return this.db.asQuery(me,
      `select a.id::text, a.at, coalesce(a.actor_email, '') as actor_email,
              coalesce(a.actor_role::text, 'system') as actor_role, a.company_id,
              coalesce(c.name, '') as company_name, a.action, a.entity, a.entity_id, a.details
         from audit_log a left join companies c on c.id = a.company_id
        where ($1 = '' or a.action ilike '%' || $1 || '%' or a.entity ilike '%' || $1 || '%'
               or a.actor_email ilike '%' || $1 || '%' or a.details::text ilike '%' || $1 || '%')
          and ($2::uuid is null or a.company_id = $2)
          and ($3 = '' or ($3 = 'error' and a.action like 'error.%') or a.action = $3)
          and ($4::timestamptz is null or a.at >= $4)
          and ($5::timestamptz is null or a.at <= $5)
        order by a.at desc limit 500`,
      [filter.q, filter.company_id || null, filter.action,
        filter.from ? `${filter.from}T00:00:00Z` : null, filter.to ? `${filter.to}T23:59:59Z` : null]);
  }
}
