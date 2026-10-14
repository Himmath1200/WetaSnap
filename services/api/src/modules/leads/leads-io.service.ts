/**
 * Leads in and out: the Excel/CSV import an admin runs, and the CSV export (LEAD-06).
 *
 * Both work from the company's own card fields, so a file carries the columns that company
 * actually captures — not a fixed list — and a round trip loses nothing.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { DbService, type Caller } from '../../common/db.service';
import { DomainError } from '../../common/errors';
import { QueueService } from '../../common/queue.service';
import type { LeadFilters } from './leads.service';
import { LeadsService } from './leads.service';

export interface ImportRow { fields: Record<string, string>; duplicate: boolean }
export interface ImportResult { imported: number; skipped: number; batch_id: string }
export interface ImportBatchDto {
  id: string; company_id: string; at: string; by: string; file_name: string;
  event_id: string; event_name: string; imported: number; skipped: number; tag_ids: string[];
}

@Injectable()
export class LeadsIoService {
  constructor(
    private readonly db: DbService,
    private readonly leads: LeadsService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  /** One batch, one transaction: either the whole file lands or none of it does. */
  async import(me: Caller, rows: ImportRow[], eventId: string, tagIds: string[], fileName: string): Promise<ImportResult> {
    if (!me.companyId) throw new DomainError('WeTano accounts do not import leads.', 400);
    if (!rows.length) throw new DomainError('That file had no rows to import.', 400);
    if (rows.length > 5000) throw new DomainError('Please import at most 5000 rows at a time.', 400);

    const person = await this.db.one<{ name: string; email: string }>(
      'select name, email from people where id = $1', [me.personId]);

    const result = await this.db.as(me, async (c) => {
      const batch = await c.one<{ id: string }>(
        `insert into import_batches (company_id, by, by_id, file_name, event_id, tag_ids)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [me.companyId, person?.email ?? '', me.personId, fileName.slice(0, 300), eventId, tagIds]);

      let imported = 0;
      let skipped = 0;
      for (const row of rows) {
        if (row.duplicate) { skipped += 1; continue; }
        const fields = Object.fromEntries(
          Object.entries(row.fields)
            .filter(([, v]) => String(v ?? '').trim() !== '')
            .map(([k, v]) => [k, { value: String(v).slice(0, 500), by: 'person' }]));
        if (!Object.keys(fields).length) { skipped += 1; continue; }
        await c.query(
          `insert into leads (id, company_id, event_id, captured_by, captured_by_name, device, source,
                              fields, status, tag_ids, import_batch_id, synced_at)
           values ($1, $2, $3, $4, $5, 'import', 'manual', $6, 'synced', $7, $8, now())`,
          [randomUUID(), me.companyId, eventId, me.personId, person?.name ?? '', fields, tagIds, batch!.id]);
        imported += 1;
      }
      await c.query('update import_batches set imported = $2, skipped = $3 where id = $1', [batch!.id, imported, skipped]);
      return { imported, skipped, batch_id: batch!.id };
    });

    await this.audit.write(me, {
      action: 'lead.import', entity: 'import_batches', entityId: result.batch_id,
      details: { file: fileName, imported: result.imported, skipped: result.skipped },
    });
    await this.queue.add('contact.link', { batch_id: result.batch_id }, { companyId: me.companyId });
    return result;
  }

  async history(me: Caller): Promise<ImportBatchDto[]> {
    return this.db.asQuery<ImportBatchDto>(me,
      `select b.id, b.company_id, b.at, b.by, b.file_name, b.event_id,
              coalesce(e.name, '') as event_name, b.imported, b.skipped, b.tag_ids
         from import_batches b left join events e on e.id = b.event_id
        order by b.at desc limit 100`);
  }

  /** The columns are the company's own fields, plus the context that makes a row useful. */
  async exportCsv(me: Caller, filters: LeadFilters): Promise<string> {
    const [rows, fields, events, people, tags] = await Promise.all([
      this.leads.list(me, filters),
      this.db.asQuery<{ key: string; label: string }>(me,
        `select distinct on (key) key, label from field_definitions order by key, sort_order`),
      this.db.asQuery<{ id: string; name: string }>(me, 'select id, name from events'),
      this.db.asQuery<{ id: string; name: string }>(me, 'select id, name from people'),
      this.db.asQuery<{ id: string; name: string }>(me, 'select id, name from tags'),
    ]);
    const eventName = new Map(events.map((e) => [e.id, e.name]));
    const personName = new Map(people.map((p) => [p.id, p.name]));
    const tagName = new Map(tags.map((t) => [t.id, t.name]));

    const header = ['Captured at', 'Event', 'Captured by', ...fields.map((f) => f.label), 'Interest', 'Tags', 'Notes', 'Consent', 'Status'];
    const lines = [header.map(csv).join(',')];
    for (const lead of rows) {
      lines.push([
        new Date(lead.created_at).toISOString().replace('T', ' ').slice(0, 16),
        eventName.get(lead.event_id) ?? '',
        lead.captured_by_name || personName.get(lead.captured_by) || '',
        ...fields.map((f) => lead.fields?.[f.key]?.value ?? ''),
        lead.interest ?? '',
        (lead.tag_ids ?? []).map((id) => tagName.get(id) ?? '').filter(Boolean).join('; '),
        lead.notes ?? '',
        lead.consent ? 'yes' : 'no',
        lead.status,
      ].map(csv).join(','));
    }
    await this.audit.write(me, { action: 'lead.export', entity: 'leads', details: { rows: rows.length } });
    // The BOM is what makes Excel open UTF-8 correctly on Windows.
    return `﻿${lines.join('\r\n')}\r\n`;
  }
}

/** Quotes a value, and defuses anything a spreadsheet would treat as a formula. */
function csv(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
