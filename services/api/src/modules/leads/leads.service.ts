/**
 * Leads (S4/S5) — what the booth captured, and everything done to it afterwards.
 *
 * The device owns the id, so syncing is idempotent: the same lead sent twice (a flaky stand
 * network, a retry after a lost response) updates one row rather than making two. A lead that
 * arrives again with older content never overwrites newer content, so an offline phone catching up
 * cannot undo an edit made on the laptop in the meantime (SYNC-03).
 */
import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { Conn, DbService, type Caller } from '../../common/db.service';
import { DomainError, notFound } from '../../common/errors';
import { QueueService } from '../../common/queue.service';

export interface LeadDto {
  id: string; company_id: string; event_id: string; contact_id: string | null;
  captured_by: string; captured_by_name: string; device: string; source: string;
  fields: Record<string, { value: string; by: string; confidence?: number; reason?: string }>;
  interest: string | null; notes: string; consent: boolean; consent_version: number; consent_at: string | null;
  status: string; crm_error: string | null; crm_record_id: string | null; crm_history: unknown[];
  has_photo: boolean; has_back_photo: boolean; tag_ids: string[]; import_batch_id: string | null;
  lead_score: number; created_at: string; updated_at: string; synced_at: string | null; deleted_at: string | null;
}

export interface LeadFilters {
  q: string; event_ids: string[]; captured_by: string[]; tag_ids: string[];
  status: string; interest: string; from: string; to: string; import_batch_id?: string;
}

export const LEAD_COLUMNS = `
  id, company_id, event_id, contact_id, captured_by, captured_by_name, device, source::text as source,
  fields, interest::text as interest, notes, consent, consent_version, consent_at, status::text as status,
  crm_error, crm_record_id, crm_history, has_photo, has_back_photo, tag_ids, import_batch_id,
  lead_score, created_at, updated_at, synced_at, deleted_at`;

@Injectable()
export class LeadsService {
  constructor(private readonly db: DbService, private readonly queue: QueueService, private readonly audit: AuditService) {}

  // ---------------------------------------------------------------- reading
  async list(me: Caller, f: LeadFilters): Promise<LeadDto[]> {
    const where: string[] = ['deleted_at is null'];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace('$?', `$${params.length}`)); };

    if (me.role === 'individual') {
      add('captured_by = $?', me.personId);
    } else {
      if (f.event_ids.length) add('event_id::text = any($?)', f.event_ids);
      if (f.captured_by.length) add('captured_by::text = any($?)', f.captured_by);
    }
    if (f.tag_ids.length) add('tag_ids && $?', f.tag_ids);
    if (f.import_batch_id) add('import_batch_id::text = $?', f.import_batch_id);
    if (f.status) add('status::text = $?', f.status);
    if (f.interest) add('interest::text = $?', f.interest);
    if (f.from) add('created_at >= $?::date', f.from);
    if (f.to) add("created_at < ($?::date + 1)", f.to);
    for (const word of f.q.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)) {
      add('search_text like $?', `%${word}%`);
    }

    return this.db.asQuery<LeadDto>(me,
      `select ${LEAD_COLUMNS} from leads where ${where.join(' and ')} order by created_at desc limit 5000`,
      params);
  }

  async byIds(me: Caller, ids: string[]): Promise<LeadDto[]> {
    if (!ids.length) return [];
    return this.db.asQuery<LeadDto>(me, `select ${LEAD_COLUMNS} from leads where id = any($1)`, [ids.slice(0, 500)]);
  }

  async counters(me: Caller, eventId: string | null) {
    const row = await this.db.asOne<{ in_event: number; today: number; waiting: number; failed: number }>(me,
      `select
         count(*) filter (where $1::text is null or $1 = '' or event_id::text = $1)::int as in_event,
         count(*) filter (where created_at >= date_trunc('day', now()))::int as today,
         count(*) filter (where status = 'waiting')::int as waiting,
         count(*) filter (where status = 'check')::int as failed
       from leads where deleted_at is null`,
      [eventId]);
    return row ?? { in_event: 0, today: 0, waiting: 0, failed: 0 };
  }

  /** LEAD-05: has this address or number already been captured, by anyone in this company / event? */
  async exists(me: Caller, eventId: string, email: string, phone: string): Promise<string | null> {
    if (!email && !phone) return null;
    const isSolo = !eventId || eventId === 'solo' || me.role === 'individual';
    const row = await this.db.asOne<{ created_at: string }>(me,
      `select created_at from leads
        where deleted_at is null
          and ($1 = '' or event_id::text = $1)
          and (($2 <> '' and fields->'email'->>'value' ilike $2)
            or ($3 <> '' and (
              regexp_replace(coalesce(fields->'phone'->>'value', ''), '\\D', '', 'g') = regexp_replace($3, '\\D', '', 'g')
              or regexp_replace(coalesce(fields->'mobile'->>'value', ''), '\\D', '', 'g') = regexp_replace($3, '\\D', '', 'g')
            )))
        order by created_at limit 1`,
      [isSolo ? '' : eventId, email.trim(), phone.trim()]);
    return row?.created_at ?? null;
  }

  // ---------------------------------------------------------------- writing
  /**
   * Upsert from a device. Returns the row as it now stands, which is what the device stores, so
   * the two sides agree even when the server kept its own newer copy.
   */
  async sync(me: Caller, lead: Partial<LeadDto> & { id: string; event_id: string }): Promise<LeadDto> {
    const companyId = me.companyId ?? null;
    if (!companyId && me.role !== 'individual') throw new DomainError('WeTano accounts do not capture leads.', 400);

    if (companyId) {
      await this.assertCanScan(companyId, lead);
    }

    // Check if this lead already exists to avoid double-counting on update syncs
    const isNewLead = !(await this.db.asOne<{ id: string }>(me, 'select id from leads where id = $1', [lead.id]));

    // Verify scanning/capture access hasn't concluded for new leads
    const person = await this.db.one<any>(
      `select to_char(access_ends_on, 'YYYY-MM-DD') as access_ends_on,
              to_char(event_ends_on, 'YYYY-MM-DD') as event_ends_on
         from people where id = $1`,
      [me.personId],
    );
    const cutoff = person?.access_ends_on || person?.event_ends_on;
    if (cutoff && isNewLead) {
      const today = new Date().toISOString().slice(0, 10);
      if (today > cutoff) {
        throw new DomainError(
          `Your scanning access completed on ${cutoff}. Your account is in export-only mode. New lead capture is disabled.`,
          403,
          'scanning_ended',
        );
      }
    }

    const row = await this.db.as(me, async (c) => {
      const saved = await c.one<LeadDto>(
        `insert into leads (id, company_id, event_id, captured_by, captured_by_name, device, source, fields,
                            interest, notes, consent, consent_version, consent_at, status, tag_ids,
                            import_batch_id, created_at, updated_at, synced_at, has_photo, has_back_photo)
         values ($1, $2, $3, $4, $5, $6, $7::lead_source, $8, $9::lead_interest, $10, $11, $12, $13,
                 $14::lead_status, $15, $16, coalesce($17, now()), coalesce($18, now()), now(),
                 coalesce($19, false), coalesce($20, false))
         on conflict (id) do update set
            fields = case when excluded.updated_at >= leads.updated_at then excluded.fields else leads.fields end,
            interest = case when excluded.updated_at >= leads.updated_at then excluded.interest else leads.interest end,
            notes = case when excluded.updated_at >= leads.updated_at then excluded.notes else leads.notes end,
            consent = leads.consent or excluded.consent,
            consent_at = coalesce(leads.consent_at, excluded.consent_at),
            tag_ids = case when excluded.updated_at >= leads.updated_at then excluded.tag_ids else leads.tag_ids end,
            status = case when leads.status = 'in_crm' then leads.status else excluded.status end,
            has_photo = leads.has_photo or excluded.has_photo,
            has_back_photo = leads.has_back_photo or excluded.has_back_photo,
            updated_at = greatest(leads.updated_at, excluded.updated_at),
            synced_at = now()
         returning ${LEAD_COLUMNS}`,
        [lead.id, companyId, lead.event_id || null, lead.captured_by ?? me.personId, lead.captured_by_name ?? '',
          (lead.device ?? '').slice(0, 200), lead.source ?? 'manual', lead.fields ?? {}, lead.interest ?? null,
          (lead.notes ?? '').slice(0, 5000), lead.consent ?? false, lead.consent_version ?? 1, lead.consent_at ?? null,
          lead.status === 'waiting' ? 'synced' : (lead.status ?? 'synced'), lead.tag_ids ?? [],
          lead.import_batch_id ?? null, lead.created_at ?? null, lead.updated_at ?? null,
          lead.has_photo ?? false, lead.has_back_photo ?? false],
      );
      return saved!;
    });

    // Usage, de-duplication and the CRM all happen off the request: the device gets its answer now.
    if (companyId) {
      await this.recordUsage(companyId, me.personId, row);
      await this.queue.add('contact.link', { lead_id: row.id }, { companyId, dedupeKey: `contact.link:${row.id}` });
    } else if (me.role === 'individual' && isNewLead) {
      // Keep individual monthly scan quota in sync when leads arrive (online or batched after offline)
      await this.db.query(
        `update people set monthly_scans = monthly_scans + 1 where id = $1`,
        [me.personId],
      );
    }
    if (row.status !== 'in_crm') {
      await this.queue.add('crm.push', { lead_id: row.id }, { companyId, dedupeKey: `crm.push:${row.id}` });
    }
    return row;
  }

  async save(me: Caller, lead: Partial<LeadDto> & { id: string; event_id: string }, resend: boolean): Promise<LeadDto> {
    const row = await this.sync(me, { ...lead, updated_at: new Date().toISOString() });
    await this.audit.write(me, { action: 'lead.update', entity: 'leads', entityId: row.id });
    if (resend) {
      await this.db.asQuery(me, `update leads set status = 'synced', crm_error = null where id = $1`, [row.id]);
      await this.queue.add('crm.push', { lead_id: row.id, force: true }, { companyId: row.company_id });
    }
    return row;
  }

  /** Soft delete: staff may remove their own (client decision), admins anyone's in the company. */
  async remove(me: Caller, id: string): Promise<void> {
    const row = await this.db.asOne<{ id: string }>(me,
      `update leads set deleted_at = now()
        where id = $1 and deleted_at is null returning id`, [id]);
    if (!row) throw notFound('That lead');
    await this.audit.write(me, { action: 'lead.delete', entity: 'leads', entityId: id });
  }

  async restore(me: Caller, id: string): Promise<void> {
    let row: { id: string } | null;
    if (me.role === 'individual') {
      row = await this.db.asOne<{ id: string }>(me,
        `update leads set deleted_at = null, updated_at = now()
          where id = $1 and captured_by = $2 and deleted_at is not null returning id`, [id, me.personId]);
    } else if (me.role === 'client_admin') {
      row = await this.db.asOne<{ id: string }>(me,
        `update leads set deleted_at = null, updated_at = now()
          where id = $1 and company_id = $2 and deleted_at is not null returning id`, [id, me.companyId]);
    } else {
      row = await this.db.asOne<{ id: string }>(me,
        `update leads set deleted_at = null, updated_at = now()
          where id = $1 and captured_by = $2 and deleted_at is not null returning id`, [id, me.personId]);
    }
    if (!row) throw notFound('That deleted lead');
    await this.audit.write(me, { action: 'lead.restore', entity: 'leads', entityId: id });
  }

  async recycleBin(me: Caller): Promise<LeadDto[]> {
    if (me.role === 'individual') {
      return this.db.asQuery<LeadDto>(me,
        `select ${LEAD_COLUMNS} from leads
          where captured_by = $1 and deleted_at is not null
            and deleted_at > now() - interval '30 days'
          order by deleted_at desc limit 200`, [me.personId]);
    }
    if (me.role === 'client_admin') {
      return this.db.asQuery<LeadDto>(me,
        `select ${LEAD_COLUMNS} from leads
          where company_id = $1 and deleted_at is not null
            and deleted_at > now() - interval '30 days'
          order by deleted_at desc limit 200`, [me.companyId]);
    }
    return this.db.asQuery<LeadDto>(me,
      `select ${LEAD_COLUMNS} from leads
        where captured_by = $1 and deleted_at is not null
          and deleted_at > now() - interval '30 days'
        order by deleted_at desc limit 200`, [me.personId]);
  }

  async bulkTag(me: Caller, ids: string[], add: string[], remove: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.asQuery(me,
      `update leads
          set tag_ids = (
            select coalesce(array_agg(distinct t), '{}')
              from unnest(array_cat(tag_ids, $2::uuid[])) t
             where t <> all($3::uuid[]))
         where id = any($1) and deleted_at is null`,
      [ids, add, remove]);
    await this.audit.write(me, { action: 'lead.bulk_tag', entity: 'leads', details: { count: ids.length } });
  }

  async bulkDelete(me: Caller, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.asQuery(me,
      `update leads set deleted_at = now() where id = any($1) and deleted_at is null`,
      [ids]);
    await this.audit.write(me, { action: 'lead.bulk_delete', entity: 'leads', details: { count: ids.length } });
  }

  async bulkResend(me: Caller, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const rows = await this.db.asQuery<{ id: string; company_id: string }>(me,
      `update leads set status = 'synced', crm_error = null
        where id = any($1) and deleted_at is null returning id, company_id`, [ids]);
    for (const r of rows) {
      await this.queue.add('crm.push', { lead_id: r.id, force: true }, { companyId: r.company_id });
    }
  }

  // ---------------------------------------------------------------- devices
  async reportOutbox(me: Caller, device: string, waiting: number, oldest: string | null): Promise<void> {
    if (!me.companyId) return;
    await this.db.asQuery(me,
      `insert into device_status (person_id, device, company_id, waiting, oldest_waiting_at, reported_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (person_id, device) do update
          set waiting = excluded.waiting, oldest_waiting_at = excluded.oldest_waiting_at, reported_at = now()`,
      [me.personId, device.slice(0, 200) || 'device', me.companyId, Math.max(0, waiting), oldest]);
  }

  // ---------------------------------------------------------------- licence & usage
  /**
   * D-9: a company that has used up its monthly scans is either blocked, or billed for the extra,
   * or simply told — whichever WeTano set for it. Manual and imported leads never count as scans.
   */
  private async assertCanScan(companyId: string, lead: Partial<LeadDto>): Promise<void> {
    if (lead.source !== 'camera' && lead.source !== 'upload') return;
    const row = await this.db.one<{ status: string; action: string; used: string; allowed: number }>(
      `select licence_status($1) as status,
              c.scan_limit_action::text as action,
              scans_this_month($1)::text as used,
              coalesce(l.scans_per_month, 0) as allowed
         from companies c left join licences l on l.company_id = c.id
        where c.id = $1`,
      [companyId]);
    if (!row) throw notFound('That company');
    if (row.status === 'read_only') {
      throw new DomainError('This licence has ended. Ask WeTano to renew it — your leads stay safe in the meantime.', 403, 'licence_ended');
    }
    if (row.allowed > 0 && Number(row.used) >= row.allowed && row.action === 'block') {
      throw new DomainError(
        `This month's ${row.allowed} scans are used up. Ask WeTano to raise the limit — the lead is still safe on the device.`,
        409, 'scan_limit');
    }
  }

  private async recordUsage(companyId: string, personId: string, lead: LeadDto): Promise<void> {
    const kind = lead.source === 'camera' || lead.source === 'upload' ? 'scan' : null;
    await this.db.query(
      `insert into usage_events (company_id, person_id, kind, lead_id) values ($1, $2, $3::usage_kind, $4)`,
      [companyId, personId, kind ?? 'sync', lead.id]);
    if (kind) await this.queue.add('usage.alerts', { company_id: companyId }, { companyId, dedupeKey: `usage.alerts:${companyId}` });
  }

  /** Used by the pipeline and the CRM worker, which run without a person. */
  async systemUpdate(conn: Conn, id: string, patch: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    await conn.query(`update leads set ${sets} where id = $1`, [id, ...keys.map((k) => patch[k])]);
  }
}
