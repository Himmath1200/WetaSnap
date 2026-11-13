/**
 * What a company sets up before the booth opens: events, the card-field templates captured at
 * them, and the tags leads are grouped by (S7). Reads are open to everyone in the company — staff
 * need the fields to scan with — and writes are for admins, which the policies enforce.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { DbService, type Caller } from '../../common/db.service';
import { DomainError, notFound } from '../../common/errors';
import { StorageService } from '../../common/storage.service';

export interface EventDto {
  id: string; company_id: string; name: string; starts_on: string; ends_on: string;
  venue: string; booth: string; status: 'open' | 'closed'; description: string;
  time_zone: string; template_id: string | null; attachments: AttachmentDto[];
}
export interface AttachmentDto { id: string; name: string; mime: string; size: number; url: string; uploaded_at: string }
export interface FieldDto {
  id: string; company_id: string; template_id: string; key: string; label: string;
  type: string; options: string[]; required: boolean; ai_hint: string; filled_by: string; sort_order: number;
}
export interface TemplateDto {
  id: string; company_id: string; name: string; description: string; is_default: boolean;
  field_count: number; updated_at: string;
}
export interface TagDto { id: string; company_id: string; name: string; colour: string }

const EVENT_COLUMNS = `
  id, company_id, name, to_char(starts_on, 'YYYY-MM-DD') as starts_on, to_char(ends_on, 'YYYY-MM-DD') as ends_on,
  venue, booth, status::text as status, description, time_zone, template_id, attachments`;

const FIELD_COLUMNS = `
  id, company_id, template_id, key, label, type::text as type, options, required, ai_hint,
  filled_by::text as filled_by, sort_order`;

@Injectable()
export class CatalogueService {
  constructor(private readonly db: DbService, private readonly storage: StorageService, private readonly audit: AuditService) {}

  private companyOf(me: Caller): string {
    if (!me.companyId) throw new DomainError('WeTano accounts have no company of their own.', 400);
    return me.companyId;
  }

  // ---------------------------------------------------------------- events
  async events(me: Caller): Promise<EventDto[]> {
    // Super admins see only platform events created directly by Super Admin (where company_id is null / organizer events)
    if (me.role === 'super_admin') {
      return this.db.asQuery<EventDto>(
        me,
        `select ${EVENT_COLUMNS} from events where company_id is null order by starts_on desc`,
      );
    }

    // Company admins and company staff: only see events owned by their specific company
    if (me.companyId) {
      return this.db.asQuery<EventDto>(
        me,
        `select ${EVENT_COLUMNS} from events where company_id = $1 order by starts_on desc`,
        [me.companyId],
      );
    }

    // Organizers: only see events assigned to their organizer ID or their default event
    if (me.role === 'organizer') {
      return this.db.asQuery<EventDto>(
        me,
        `select ${EVENT_COLUMNS} from events where organizer_id = $1 or id in (select default_event_id from people where id = $1) order by starts_on desc`,
        [me.personId],
      );
    }

    // Attendee staff under an organizer: only see the organizer's assigned event
    return this.db.asQuery<EventDto>(
      me,
      `select ${EVENT_COLUMNS} from events where organizer_id in (select organizer_id from people where id = $1)
         or id in (select default_event_id from people where id = $1)
       order by starts_on desc`,
      [me.personId],
    );
  }

  async saveEvent(me: Caller, input: Partial<EventDto> & { id?: string }): Promise<EventDto> {
    const company = this.companyOf(me);
    const templateId = input.template_id && input.template_id.trim() ? input.template_id.trim() : null;
    const row = input.id
      ? await this.db.asOne<EventDto>(me,
        `update events set name = $2, starts_on = $3, ends_on = $4, venue = $5, booth = $6,
                status = $7::event_status, description = $8, time_zone = $9, template_id = $10
           where id = $1 returning ${EVENT_COLUMNS}`,
        [input.id, input.name, input.starts_on, input.ends_on, input.venue ?? '', input.booth ?? '',
          input.status ?? 'open', input.description ?? '', input.time_zone ?? 'UTC', templateId])
      : await this.db.asOne<EventDto>(me,
        `insert into events (company_id, name, starts_on, ends_on, venue, booth, status, description, time_zone, template_id)
         values ($1, $2, $3, $4, $5, $6, $7::event_status, $8, $9, $10) returning ${EVENT_COLUMNS}`,
        [company, input.name, input.starts_on, input.ends_on, input.venue ?? '', input.booth ?? '',
          input.status ?? 'open', input.description ?? '', input.time_zone ?? 'UTC', templateId]);
    if (!row) throw notFound('That event');
    await this.audit.write(me, { action: input.id ? 'event.update' : 'event.create', entity: 'events', entityId: row.id, details: { name: row.name } });
    return row;
  }

  async addAttachment(me: Caller, eventId: string, file: { name: string; mime: string; data: string }): Promise<EventDto> {
    const company = this.companyOf(me);
    const body = Buffer.from(file.data, 'base64');
    if (body.length > 10 * 1024 * 1024) throw new DomainError('Please keep attachments under 10 MB.', 400);
    const id = randomUUID();
    const ext = (file.name.split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
    const key = StorageService.attachmentKey(company, eventId, id, ext);
    await this.storage.put(key, body, file.mime || 'application/octet-stream');
    const attachment: AttachmentDto = {
      id, name: file.name.slice(0, 200), mime: file.mime || 'application/octet-stream',
      size: body.length, url: key, uploaded_at: new Date().toISOString(),
    };
    const row = await this.db.asOne<EventDto>(me,
      `update events set attachments = attachments || $2::jsonb where id = $1 returning ${EVENT_COLUMNS}`,
      [eventId, JSON.stringify([attachment])]);
    if (!row) throw notFound('That event');
    await this.audit.write(me, { action: 'event.attachment', entity: 'events', entityId: eventId, details: { name: attachment.name } });
    return row;
  }

  async removeAttachment(me: Caller, eventId: string, attachmentId: string): Promise<EventDto> {
    const before = await this.db.asOne<{ attachments: AttachmentDto[] }>(me,
      'select attachments from events where id = $1', [eventId]);
    const gone = (before?.attachments ?? []).find((a) => a.id === attachmentId);
    const row = await this.db.asOne<EventDto>(me,
      `update events set attachments = coalesce((
          select jsonb_agg(a) from jsonb_array_elements(attachments) a where a->>'id' <> $2), '[]'::jsonb)
        where id = $1 returning ${EVENT_COLUMNS}`,
      [eventId, attachmentId]);
    if (!row) throw notFound('That event');
    if (gone?.url) await this.storage.delete(gone.url);
    return row;
  }

  // ---------------------------------------------------------------- templates & fields
  async templates(me: Caller): Promise<TemplateDto[]> {
    return this.db.asQuery<TemplateDto>(me,
      `select t.id, t.company_id, t.name, t.description, t.is_default,
              (select count(*)::int from field_definitions f where f.template_id = t.id) as field_count,
              t.updated_at
         from field_templates t order by t.is_default desc, t.name`);
  }

  async saveTemplate(me: Caller, input: { id?: string; name: string; description: string; is_default: boolean; copy_from?: string }): Promise<TemplateDto> {
    const company = this.companyOf(me);
    const id = await this.db.as(me, async (c) => {
      let templateId = input.id ?? null;
      if (templateId) {
        await c.query('update field_templates set name = $2, description = $3 where id = $1',
          [templateId, input.name, input.description]);
      } else {
        const row = await c.one<{ id: string }>(
          'insert into field_templates (company_id, name, description) values ($1, $2, $3) returning id',
          [company, input.name, input.description]);
        templateId = row!.id;
        // A new template starts as a copy of the one it was made from, or of the default.
        const source = input.copy_from ?? null;
        await c.query(
          `insert into field_definitions (company_id, template_id, key, label, type, options, required, ai_hint, filled_by, sort_order)
           select company_id, $2, key, label, type, options, required, ai_hint, filled_by, sort_order
             from field_definitions
            where template_id = coalesce($3, (select id from field_templates where company_id = $1 and is_default limit 1))`,
          [company, templateId, source]);
      }
      if (input.is_default) {
        await c.query('update field_templates set is_default = (id = $2) where company_id = $1', [company, templateId]);
      }
      return templateId;
    });
    await this.audit.write(me, { action: input.id ? 'template.update' : 'template.create', entity: 'field_templates', entityId: id, details: { name: input.name } });
    const list = await this.templates(me);
    return list.find((t) => t.id === id)!;
  }

  async deleteTemplate(me: Caller, id: string): Promise<void> {
    const used = await this.db.asOne<{ n: string }>(me,
      `select count(*)::text as n from events where template_id = $1`, [id]);
    if (Number(used?.n ?? 0) > 0) {
      throw new DomainError('That template is used by an event. Point the event at another template first.', 409);
    }
    const row = await this.db.asOne<{ is_default: boolean }>(me,
      'delete from field_templates where id = $1 and not is_default returning is_default', [id]);
    if (!row) throw new DomainError('The default template cannot be deleted.', 409);
    await this.audit.write(me, { action: 'template.delete', entity: 'field_templates', entityId: id });
  }

  /** The fields in use for one event (its template, else the company default) — D-10. */
  async fieldsForEvent(me: Caller, eventId: string | null): Promise<FieldDto[]> {
    return this.db.asQuery<FieldDto>(me,
      `select ${FIELD_COLUMNS} from field_definitions
        where template_id = coalesce(
          (select e.template_id from events e where e.id::text = $1::text),
          (select t.id from field_templates t where t.is_default limit 1),
          (select t.id from field_templates t limit 1))
        order by sort_order, label`,
      [eventId ?? null]);
  }

  async fieldsOfTemplate(me: Caller, templateId: string): Promise<FieldDto[]> {
    return this.db.asQuery<FieldDto>(me,
      `select ${FIELD_COLUMNS} from field_definitions where template_id = $1 order by sort_order, label`,
      [templateId]);
  }

  async saveField(me: Caller, input: Partial<FieldDto> & { id?: string }): Promise<FieldDto> {
    const company = this.companyOf(me);
    const key = (input.key || slug(input.label ?? '')).slice(0, 40);
    const row = input.id
      ? await this.db.asOne<FieldDto>(me,
        `update field_definitions set key = $2, label = $3, type = $4::field_type, options = $5,
                required = $6, ai_hint = $7, filled_by = $8::field_filler, sort_order = $9
           where id = $1 returning ${FIELD_COLUMNS}`,
        [input.id, key, input.label, input.type ?? 'text', input.options ?? [], input.required ?? false,
          input.ai_hint ?? '', input.filled_by ?? 'ai', input.sort_order ?? 0])
      : await this.db.asOne<FieldDto>(me,
        `insert into field_definitions (company_id, template_id, key, label, type, options, required, ai_hint, filled_by, sort_order)
         values ($1, $2, $3, $4, $5::field_type, $6, $7, $8, $9::field_filler,
                 coalesce($10, (select coalesce(max(sort_order), 0) + 1 from field_definitions where template_id = $2)))
         returning ${FIELD_COLUMNS}`,
        [company, input.template_id, key, input.label, input.type ?? 'text', input.options ?? [],
          input.required ?? false, input.ai_hint ?? '', input.filled_by ?? 'ai', input.sort_order ?? null]);
    if (!row) throw notFound('That field');
    return row;
  }

  async deleteField(me: Caller, id: string): Promise<void> {
    await this.db.asQuery(me, 'delete from field_definitions where id = $1', [id]);
  }

  async reorderFields(me: Caller, ids: string[]): Promise<void> {
    await this.db.as(me, async (c) => {
      for (const [i, id] of ids.entries()) {
        await c.query('update field_definitions set sort_order = $2 where id = $1', [id, i]);
      }
    });
  }

  // ---------------------------------------------------------------- tags
  async tags(me: Caller): Promise<TagDto[]> {
    return this.db.asQuery<TagDto>(me, `select id, company_id, name, colour::text as colour from tags order by name`);
  }

  async saveTag(me: Caller, input: { id?: string; name: string; colour: string }): Promise<TagDto> {
    const company = this.companyOf(me);
    const row = input.id
      ? await this.db.asOne<TagDto>(me,
        `update tags set name = $2, colour = $3::tag_colour where id = $1
         returning id, company_id, name, colour::text as colour`, [input.id, input.name.trim(), input.colour])
      : await this.db.asOne<TagDto>(me,
        `insert into tags (company_id, name, colour) values ($1, $2, $3::tag_colour)
         returning id, company_id, name, colour::text as colour`, [company, input.name.trim(), input.colour]);
    if (!row) throw notFound('That tag');
    return row;
  }

  async deleteTag(me: Caller, id: string): Promise<void> {
    await this.db.as(me, async (c) => {
      await c.query('update leads set tag_ids = array_remove(tag_ids, $1) where $1 = any(tag_ids)', [id]);
      await c.query('delete from tags where id = $1', [id]);
    });
  }
}

/** "Mobile number" → mobile_number, so a field key is always usable in JSON and in a CSV header. */
const slug = (label: string) =>
  label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, '').trim().replace(/\s+/g, '_').replace(/^[^a-z]+/, '') || 'field';
