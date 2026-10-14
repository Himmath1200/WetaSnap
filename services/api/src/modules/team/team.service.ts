/**
 * The team screen (S6): who can sign in, within the seats the licence paid for.
 *
 * Nobody signs themselves up. An admin adds a person here (or WeTano adds the first admin of a new
 * company) and the invitation email carries a 6-digit code and a "Set up password" button — the
 * first-time setup every account goes through (AUTH-08).
 */
import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { DbService, type Caller } from '../../common/db.service';
import { loadEnv } from '../../common/env';
import { DomainError, notFound } from '../../common/errors';
import { MailService } from '../../common/mail.service';
import { PasswordService, SETUP_MINUTES } from '../auth/password.service';
import { PERSON_COLUMNS } from '../auth/people.service';

export interface Invitation { setup_link: string; email_sent: boolean; resent: boolean }

export interface SeatInfo {
  used: number;
  seats: number;
  licence: Record<string, unknown>;
  status: string;
}

@Injectable()
export class TeamService {
  constructor(
    private readonly db: DbService,
    private readonly passwords: PasswordService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  async list(me: Caller) {
    return this.db.asQuery(me,
      `select ${PERSON_COLUMNS},
              (select e.name from events e where e.id = p.default_event_id) as event_name,
              (select count(*)::int from leads l where l.captured_by = p.id and l.deleted_at is null) as lead_count,
              case when not p.active then 'deactivated'
                   when p.access_ends_on is not null and p.access_ends_on < current_date then 'expired'
                   when p.invited then 'invited'
                   else 'active' end as status
         from people p
        where p.company_id = $1
        order by p.name`,
      [me.companyId]);
  }

  async seats(me: Caller): Promise<SeatInfo> {
    const row = await this.db.asOne<SeatInfo>(me,
      `select seats_used($1) as used,
              coalesce(l.seats, 0) as seats,
              licence_status($1) as status,
              to_jsonb(l) - 'reminders_sent' as licence
         from licences l where l.company_id = $1`,
      [me.companyId]);
    if (!row) throw new DomainError('This company has no licence.', 409);
    return row;
  }

  /** Creates the account without a password and emails the setup code and link. */
  async invite(me: Caller, input: {
    email: string; name: string; phone: string; role: 'staff' | 'client_admin';
    event_ids: string[]; default_event_id: string | null; access_ends_on: string | null;
    company_id?: string;
  }): Promise<Invitation> {
    const companyId = me.role === 'super_admin' ? input.company_id : me.companyId;
    if (!companyId) throw new DomainError('Choose the company to invite this person to.', 400);

    const company = await this.db.one<{ name: string }>('select name from companies where id = $1', [companyId]);
    if (!company) throw notFound('That company');

    const existing = await this.db.one<{ id: string; company_id: string; name: string; access_ends_on: string | null }>(
      'select id, company_id, name, to_char(access_ends_on, \'YYYY-MM-DD\') as access_ends_on from people where lower(email) = lower($1)',
      [input.email]);

    // The same answer whatever the other company is, so nobody learns who else uses WeTa Snap.
    if (existing && existing.company_id !== companyId) {
      throw new DomainError('This email address cannot be invited. Please use a different one.', 409, 'email_taken');
    }

    const person = existing ?? await this.create(companyId, input);
    const code = await this.passwords.mint(person.id, input.email, 'reset', SETUP_MINUTES);
    const link = `${loadEnv().APP_URL.replace(/\/$/, '')}/signin#setup=${encodeURIComponent(input.email)}`;
    const sent = await this.mail.send({
      to: input.email,
      fromName: `${company.name} via WeTa Snap`,
      subject: `${company.name} invited you to WeTa Snap`,
      html: this.mail.invitation(company.name, input.name || person.name, link, code, input.access_ends_on),
    });

    await this.audit.write(me, {
      action: existing ? 'person.reinvite' : 'person.invite', entity: 'people', entityId: person.id,
      companyId, details: { email: input.email, role: input.role },
    });
    return { setup_link: link, email_sent: sent.sent, resent: !!existing };
  }

  private async create(companyId: string, input: {
    email: string; name: string; phone: string; role: 'staff' | 'client_admin';
    event_ids: string[]; default_event_id: string | null; access_ends_on: string | null;
  }) {
    return this.db.tx(async (c) => {
      const events = await c.query<{ id: string }>(
        'select id from events where company_id = $1 and id = any($2)', [companyId, input.event_ids]);
      const allowed = events.map((e) => e.id);
      const defaultEvent = input.default_event_id && allowed.includes(input.default_event_id)
        ? input.default_event_id : allowed[0] ?? null;

      const person = await c.one<{ id: string; name: string }>(
        `insert into people (company_id, email, name, phone, role, default_event_id, access_ends_on,
                             active, invited, has_password)
         values ($1, $2, $3, $4, $5::app_role, $6, $7, true, true, false)
         returning id, name`,
        [companyId, input.email.toLowerCase(), input.name.trim() || input.email.split('@')[0], input.phone ?? '',
          input.role, defaultEvent, input.access_ends_on]);

      for (const eventId of allowed) {
        await c.query(
          'insert into person_events (person_id, event_id, company_id) values ($1, $2, $3) on conflict do nothing',
          [person!.id, eventId, companyId]);
      }
      await c.query(
        `insert into notifications (company_id, kind, title, body, link)
         values ($1, 'person_invited', $2, 'They set their own password from the invitation email.', '/team')`,
        [companyId, `${person!.name} was invited`]);
      return person!;
    });
  }

  async update(me: Caller, input: {
    id: string; name: string; phone: string; role: 'staff' | 'client_admin';
    event_ids: string[]; default_event_id: string | null; access_ends_on: string | null; active: boolean;
  }): Promise<void> {
    if (input.id === me.personId && !input.active) {
      throw new DomainError('You cannot deactivate your own account. Ask another admin to do it.', 409);
    }
    if (input.id === me.personId && input.role !== 'client_admin' && me.role === 'client_admin') {
      throw new DomainError('You cannot remove your own admin role. Ask another admin to do it.', 409);
    }

    await this.db.as(me, async (c) => {
      const events = await c.query<{ id: string }>(
        'select id from events where company_id = $1 and id = any($2)', [me.companyId, input.event_ids]);
      const allowed = events.map((e) => e.id);
      const defaultEvent = input.default_event_id && allowed.includes(input.default_event_id)
        ? input.default_event_id : allowed[0] ?? null;

      const row = await c.one<{ id: string }>(
        `update people set name = $2, phone = $3, role = $4::app_role, default_event_id = $5,
                access_ends_on = $6, active = $7,
                deactivated_at = case when $7 then null else coalesce(deactivated_at, now()) end
           where id = $1 returning id`,
        [input.id, input.name, input.phone, input.role, defaultEvent, input.access_ends_on, input.active]);
      if (!row) throw notFound('That person');

      await c.query('delete from person_events where person_id = $1', [input.id]);
      for (const eventId of allowed) {
        await c.query('insert into person_events (person_id, event_id, company_id) values ($1, $2, $3)',
          [input.id, eventId, me.companyId]);
      }
    });

    // Someone who may no longer sign in should not stay signed in either.
    if (!input.active) {
      await this.db.query('update device_sessions set revoked_at = now() where person_id = $1 and revoked_at is null', [input.id]);
    }
    await this.audit.write(me, { action: 'person.update', entity: 'people', entityId: input.id, details: { active: input.active, role: input.role } });
  }
}
