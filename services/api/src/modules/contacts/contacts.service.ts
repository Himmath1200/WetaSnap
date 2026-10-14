/**
 * Steps 8 to 13: duplicate check → merge or create → enrichment → lead score → follow-up.
 *
 * A contact is the person behind the leads: meet the same buyer at two shows and there is one
 * contact with two leads, not two half-filled records. Matching is done in the order a human
 * would: the same e-mail address is the same person; the same mobile number almost always is; a
 * very similar name at the same company usually is, and anything less certain is left alone,
 * because a wrong merge is much harder to undo than a duplicate.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Conn, DbService, type Caller } from '../../common/db.service';
import { notFound } from '../../common/errors';
import { QueueService } from '../../common/queue.service';
import { domainOf, phoneKey, titleCase } from '../scan/pipeline/normalise';
import { DIMENSIONS, contactToText, embed, toVectorLiteral } from './embeddings';
import { followUpDate, scoreLead } from './score';

export interface ContactDto {
  id: string; company_id: string; full_name: string; first_name: string; last_name: string;
  job_title: string; org_name: string; org_domain: string; email: string; phone: string;
  website: string; country: string; address: string; emails: string[]; phones: string[];
  lead_score: number; times_met: number; first_seen_at: string; last_seen_at: string;
  follow_up_at: string | null;
}

interface LeadRow {
  id: string; company_id: string; contact_id: string | null; interest: 'hot' | 'warm' | 'cold' | null;
  notes: string; consent: boolean; has_photo: boolean;
  fields: Record<string, { value?: string }>;
}

/** How alike two names must be before they are treated as the same person. */
const NAME_SIMILARITY = 0.55;

@Injectable()
export class ContactsService {
  private readonly log = new Logger('Contacts');

  constructor(private readonly db: DbService, private readonly queue: QueueService) {}

  // ---------------------------------------------------------------- the pipeline's tail
  /**
   * Links one lead to a contact: finds the duplicate if there is one, merges what the new card
   * adds, scores it and sets the follow-up date. Runs as a background job, so a stand with no
   * signal never waits for it.
   */
  async linkLead(leadId: string): Promise<{ contactId: string; merged: boolean } | null> {
    const lead = await this.db.one<LeadRow>(
      `select id, company_id, contact_id, interest::text as interest, notes, consent, has_photo, fields
         from leads where id = $1 and deleted_at is null`,
      [leadId]);
    if (!lead) return null;

    const details = readCardFields(lead.fields);
    if (!details.full_name && !details.email && !details.phone) return null;   // nothing to link

    const match = await this.findDuplicate(lead.company_id, details, lead.contact_id);
    const result = await this.db.tx(async (c) => {
      const contactId = match
        ? await this.mergeInto(c, match.id, details)
        : await this.createContact(c, lead.company_id, details);

      await c.query('update leads set contact_id = $2 where id = $1', [lead.id, contactId]);

      const contact = await c.one<{ times_met: number; org_domain: string; job_title: string; email: string; phone: string }>(
        'select times_met, org_domain, job_title, email, phone from contacts where id = $1', [contactId]);
      const { score } = scoreLead({
        email: contact?.email ?? '', phone: contact?.phone ?? '', orgDomain: contact?.org_domain ?? '',
        jobTitle: contact?.job_title ?? '', interest: lead.interest, consent: lead.consent,
        notes: lead.notes ?? '', timesMet: contact?.times_met ?? 1, hasCardPhoto: lead.has_photo,
      });
      await c.query('update leads set lead_score = $2 where id = $1', [lead.id, score]);
      await c.query(
        `update contacts set lead_score = greatest(lead_score, $2), follow_up_at = coalesce(follow_up_at, $3::date),
                last_seen_at = now() where id = $1`,
        [contactId, score, followUpDate(lead.interest)]);

      if (match) {
        await c.query(
          `insert into activities (company_id, contact_id, lead_id, kind, summary)
           values ($1, $2, $3, 'merged', 'Matched an existing contact')`,
          [lead.company_id, contactId, lead.id]);
      }
      return { contactId, merged: !!match };
    });

    await this.queue.add('contact.embed', { contact_id: result.contactId }, {
      companyId: lead.company_id, dedupeKey: `contact.embed:${result.contactId}`,
    });
    return result;
  }

  /** Step 8: the duplicate check, strongest signal first. */
  private async findDuplicate(
    companyId: string,
    details: CardDetails,
    preferred: string | null,
  ): Promise<{ id: string; why: string } | null> {
    if (preferred) return { id: preferred, why: 'already linked' };

    if (details.email) {
      const byEmail = await this.db.one<{ id: string }>(
        `select id from contacts
          where company_id = $1 and merged_into is null and (lower(email) = $2 or $2 = any(emails))
          limit 1`,
        [companyId, details.email.toLowerCase()]);
      if (byEmail) return { id: byEmail.id, why: 'same email' };
    }

    if (details.phone) {
      const key = phoneKey(details.phone);
      if (key.length >= 7) {
        const byPhone = await this.db.one<{ id: string }>(
          `select id from contacts
            where company_id = $1 and merged_into is null
              and exists (select 1 from unnest(array_append(phones, phone)) p
                           where right(regexp_replace(p, '\\D', '', 'g'), 10) = $2)
            limit 1`,
          [companyId, key]);
        if (byPhone) return { id: byPhone.id, why: 'same phone number' };
      }
    }

    // A close name at the same company: "Jan Müller" and "J. Mueller" at Agro Expo.
    if (details.full_name && (details.org_name || details.org_domain)) {
      const byName = await this.db.one<{ id: string; score: number }>(
        `select id, similarity(lower(full_name), lower($2)) as score
           from contacts
          where company_id = $1 and merged_into is null
            and (lower(org_name) = lower($3) or (org_domain <> '' and org_domain = $4))
            and similarity(lower(full_name), lower($2)) > $5
          order by score desc limit 1`,
        [companyId, details.full_name, details.org_name, details.org_domain, NAME_SIMILARITY]);
      if (byName) return { id: byName.id, why: 'same name at the same company' };
    }
    return null;
  }

  /** Step 9a: merge — the new card fills gaps and adds addresses, but never overwrites. */
  private async mergeInto(c: Conn, contactId: string, d: CardDetails): Promise<string> {
    await c.query(
      `update contacts set
         full_name  = case when full_name  = '' then $2 else full_name end,
         first_name = case when first_name = '' then $3 else first_name end,
         last_name  = case when last_name  = '' then $4 else last_name end,
         job_title  = case when job_title  = '' then $5 else job_title end,
         org_name   = case when org_name   = '' then $6 else org_name end,
         org_domain = case when org_domain = '' then $7 else org_domain end,
         email      = case when email      = '' then $8 else email end,
         phone      = case when phone      = '' then $9 else phone end,
         website    = case when website    = '' then $10 else website end,
         country    = case when country    = '' then $11 else country end,
         address    = case when address    = '' then $12 else address end,
         emails     = case when $8 <> '' and not ($8 = any(emails)) then array_append(emails, $8) else emails end,
         phones     = case when $9 <> '' and not ($9 = any(phones)) then array_append(phones, $9) else phones end,
         times_met  = times_met + 1,
         last_seen_at = now()
       where id = $1`,
      [contactId, d.full_name, d.first_name, d.last_name, d.job_title, d.org_name, d.org_domain,
        d.email, d.phone, d.website, d.country, d.address]);
    return contactId;
  }

  /** Step 9b: a new contact, with step 10 (enrichment) folded in. */
  private async createContact(c: Conn, companyId: string, d: CardDetails): Promise<string> {
    const row = await c.one<{ id: string }>(
      `insert into contacts (company_id, full_name, first_name, last_name, job_title, org_name, org_domain,
                             email, phone, website, country, address, emails, phones)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               case when $8 <> '' then array[$8] else '{}' end,
               case when $9 <> '' then array[$9] else '{}' end)
       returning id`,
      [companyId, d.full_name, d.first_name, d.last_name, d.job_title, d.org_name, d.org_domain,
        d.email, d.phone, d.website, d.country, d.address]);
    return row!.id;
  }

  /** Keeps the search vector in step with the contact. */
  async refreshEmbedding(contactId: string): Promise<void> {
    const contact = await this.db.one<{ full_name: string; org_name: string; job_title: string; email: string; country: string }>(
      'select full_name, org_name, job_title, email, country from contacts where id = $1', [contactId]);
    if (!contact) return;
    const { vector, model } = await embed(contactToText(contact));
    const literal = (await this.hasPgvector()) ? toVectorLiteral(vector) : null;
    await this.db.query(
      literal
        ? `insert into contact_embeddings (contact_id, model, embedding) values ($1, $2, $3::vector)
             on conflict (contact_id) do update set model = excluded.model, embedding = excluded.embedding, updated_at = now()`
        : `insert into contact_embeddings (contact_id, model, embedding) values ($1, $2, $3::double precision[])
             on conflict (contact_id) do update set model = excluded.model, embedding = excluded.embedding, updated_at = now()`,
      [contactId, model, literal ?? vector],
    );
  }

  private pgvector: boolean | null = null;
  async hasPgvector(): Promise<boolean> {
    if (this.pgvector === null) {
      const row = await this.db.one<{ ok: boolean }>(`select exists (select 1 from pg_extension where extname = 'vector') as ok`);
      this.pgvector = !!row?.ok;
      if (!this.pgvector) this.log.warn('pgvector is not installed — contact search uses trigram matching only.');
    }
    return this.pgvector;
  }

  // ---------------------------------------------------------------- reading
  async search(me: Caller, q: string, limit = 50): Promise<(ContactDto & { why: string })[]> {
    const text = q.trim();
    if (!text) {
      return this.db.asQuery<ContactDto & { why: string }>(me,
        `select *, 'recent' as why from contacts where merged_into is null
          order by last_seen_at desc limit $1`, [limit]);
    }

    // Trigram first: it is exact enough for names and companies, and it uses an index.
    const direct = await this.db.asQuery<ContactDto & { why: string }>(me,
      `select *, 'name or company' as why from contacts
        where merged_into is null
          and (lower(full_name) % lower($1) or lower(org_name) % lower($1)
               or lower(email) like '%' || lower($1) || '%'
               or lower(full_name) like '%' || lower($1) || '%'
               or lower(org_name) like '%' || lower($1) || '%')
        order by greatest(similarity(lower(full_name), lower($1)), similarity(lower(org_name), lower($1))) desc
        limit $2`,
      [text, limit]);
    if (direct.length >= limit || !(await this.hasPgvector())) return direct;

    // Then the vector, for everything that was remembered rather than spelled.
    const { vector } = await embed(text.toLowerCase());
    const seen = new Set(direct.map((c) => c.id));
    const semantic = await this.db.asQuery<ContactDto & { why: string }>(me,
      `select c.*, 'similar' as why
         from contacts c join contact_embeddings e on e.contact_id = c.id
        where c.merged_into is null
        order by e.embedding <=> $1::vector
        limit $2`,
      [toVectorLiteral(vector), limit]);
    return [...direct, ...semantic.filter((c) => !seen.has(c.id))].slice(0, limit);
  }

  async detail(me: Caller, id: string) {
    const contact = await this.db.asOne<ContactDto>(me, 'select * from contacts where id = $1', [id]);
    if (!contact) throw notFound('That contact');
    const [leads, notes, activities] = await Promise.all([
      this.db.asQuery(me,
        `select l.id, l.event_id, l.created_at, l.interest::text as interest, l.status::text as status, l.lead_score,
                e.name as event_name
           from leads l left join events e on e.id = l.event_id
          where l.contact_id = $1 and l.deleted_at is null order by l.created_at desc`, [id]),
      this.db.asQuery(me,
        `select id, body, author, created_at from notes where contact_id = $1 order by created_at desc limit 100`, [id]),
      this.db.asQuery(me,
        `select id::text, kind::text as kind, summary, at from activities where contact_id = $1 order by at desc limit 100`, [id]),
    ]);
    return { contact, leads, notes, activities };
  }

  async addNote(me: Caller, input: { contact_id?: string; lead_id?: string; body: string }) {
    const person = await this.db.one<{ name: string }>('select name from people where id = $1', [me.personId]);
    const row = await this.db.asOne(me,
      `insert into notes (company_id, contact_id, lead_id, author_id, author, body)
       values ($1, $2, $3, $4, $5, $6) returning id, body, author, created_at`,
      [me.companyId, input.contact_id ?? null, input.lead_id ?? null, me.personId, person?.name ?? '', input.body.trim()]);
    await this.db.asQuery(me,
      `insert into activities (company_id, contact_id, lead_id, person_id, kind, summary)
       values ($1, $2, $3, $4, 'note', 'Note added')`,
      [me.companyId, input.contact_id ?? null, input.lead_id ?? null, me.personId]);
    return row;
  }

  /** Two contacts that are the same person: everything moves to `keepId`, the other is marked. */
  async merge(me: Caller, keepId: string, mergeId: string): Promise<void> {
    if (keepId === mergeId) return;
    await this.db.as(me, async (c) => {
      const loser = await c.one<ContactDto>('select * from contacts where id = $1', [mergeId]);
      const keeper = await c.one<ContactDto>('select * from contacts where id = $1', [keepId]);
      if (!loser || !keeper) throw notFound('That contact');
      await this.mergeInto(c, keepId, {
        full_name: loser.full_name, first_name: loser.first_name, last_name: loser.last_name,
        job_title: loser.job_title, org_name: loser.org_name, org_domain: loser.org_domain,
        email: loser.email, phone: loser.phone, website: loser.website, country: loser.country,
        address: loser.address,
      });
      await c.query('update leads set contact_id = $1 where contact_id = $2', [keepId, mergeId]);
      await c.query('update notes set contact_id = $1 where contact_id = $2', [keepId, mergeId]);
      await c.query('update activities set contact_id = $1 where contact_id = $2', [keepId, mergeId]);
      await c.query('update contacts set merged_into = $1 where id = $2', [keepId, mergeId]);
      await c.query(
        `insert into activities (company_id, contact_id, person_id, kind, summary)
         values ($1, $2, $3, 'merged', 'Merged a duplicate contact')`, [me.companyId, keepId, me.personId]);
    });
    await this.queue.add('contact.embed', { contact_id: keepId }, { companyId: me.companyId });
  }
}

// ---------------------------------------------------------------- card → contact
export interface CardDetails {
  full_name: string; first_name: string; last_name: string; job_title: string;
  org_name: string; org_domain: string; email: string; phone: string;
  website: string; country: string; address: string;
}

/** The company's fields are its own, so the usual keys are recognised by name and by shape. */
export function readCardFields(fields: Record<string, { value?: string }>): CardDetails {
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = fields[key]?.value?.trim();
      if (value) return value;
    }
    // Fall back to any field whose key contains the word, e.g. "work_email".
    for (const [key, field] of Object.entries(fields)) {
      if (keys.some((k) => key.includes(k)) && field?.value?.trim()) return field.value.trim();
    }
    return '';
  };

  const first = pick('first_name', 'firstname', 'given');
  const last = pick('last_name', 'lastname', 'surname', 'family');
  const full = pick('full_name', 'name') || [first, last].filter(Boolean).join(' ');
  const email = pick('email', 'mail').toLowerCase();
  const org = pick('company', 'organisation', 'organization', 'org', 'employer');
  const website = pick('website', 'web', 'url', 'site');

  return {
    full_name: titleCase(full),
    first_name: titleCase(first || full.split(' ')[0] || ''),
    last_name: titleCase(last || full.split(' ').slice(1).join(' ')),
    job_title: pick('job_title', 'title', 'position', 'role'),
    org_name: org,
    org_domain: domainOf(email) || hostOf(website),
    email,
    phone: pick('phone', 'mobile', 'tel', 'telephone', 'cell'),
    website,
    country: pick('country'),
    address: pick('address', 'street', 'city'),
  };
}

const hostOf = (website: string) => {
  try {
    return website ? new URL(website.startsWith('http') ? website : `https://${website}`).hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
};

export { DIMENSIONS };
