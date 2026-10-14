/**
 * Support (S11). A client admin opens a request and sees their company's; WeTano sees everyone's,
 * assigns them and closes them. Each reply notifies the other side.
 */
import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { DbService, type Caller } from '../../common/db.service';
import { notFound } from '../../common/errors';
import { MailService } from '../../common/mail.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface TicketDto {
  id: string; number: string; company_id: string; company_name: string; opened_by: string;
  subject: string; body: string; status: string; priority: string; assigned_to: string | null;
  created_at: string; updated_at: string;
  messages: { id: string; at: string; author: string; from_wetano: boolean; body: string }[];
}

const TICKET_SELECT = `
  select t.id, t.number, t.company_id, c.name as company_name, t.opened_by, t.subject, t.body,
         t.status::text as status, t.priority::text as priority, t.assigned_to, t.created_at, t.updated_at,
         coalesce((select jsonb_agg(jsonb_build_object(
                      'id', m.id, 'at', m.at, 'author', m.author,
                      'from_wetano', m.from_wetano, 'body', m.body) order by m.at)
                     from support_messages m where m.ticket_id = t.id), '[]'::jsonb) as messages
    from support_tickets t join companies c on c.id = t.company_id`;

@Injectable()
export class SupportService {
  constructor(
    private readonly db: DbService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  async list(me: Caller, filter: { status?: string; company_id?: string }): Promise<TicketDto[]> {
    return this.db.asQuery<TicketDto>(me,
      `${TICKET_SELECT}
        where ($1 = '' or t.status = $1::ticket_status)
          and ($2::uuid is null or t.company_id = $2)
        order by t.updated_at desc limit 500`,
      [filter.status ?? '', filter.company_id ?? null]);
  }

  async open(me: Caller, input: { subject: string; body: string; priority: string }): Promise<TicketDto> {
    const person = await this.db.one<{ email: string; name: string }>('select email, name from people where id = $1', [me.personId]);
    const number = await this.db.one<{ number: string }>(`select next_document_number('SUP') as number`);
    const id = await this.db.as(me, async (c) => {
      const row = await c.one<{ id: string }>(
        `insert into support_tickets (number, company_id, opened_by, subject, body, priority)
         values ($1, $2, $3, $4, $5, $6::ticket_priority) returning id`,
        [number!.number, me.companyId, person?.email ?? '', input.subject.trim(), input.body.trim(), input.priority]);
      await c.query(
        `insert into support_messages (ticket_id, author, from_wetano, body) values ($1, $2, false, $3)`,
        [row!.id, person?.name ?? person?.email ?? '', input.body.trim()]);
      return row!.id;
    });
    await this.notifications.notify({
      companyId: null, kind: 'support_reply', title: `New support request ${number!.number}`,
      body: input.subject, link: '/support', dedupeKey: `support:new:${id}`,
    });
    await this.audit.write(me, { action: 'support.open', entity: 'support_tickets', entityId: id, details: { subject: input.subject } });
    return this.byId(me, id);
  }

  async reply(me: Caller, id: string, body: string): Promise<TicketDto> {
    const person = await this.db.one<{ email: string; name: string }>('select email, name from people where id = $1', [me.personId]);
    const fromWetano = me.role === 'super_admin';
    const ticket = await this.db.asOne<{ company_id: string; number: string; subject: string }>(me,
      'select company_id, number, subject from support_tickets where id = $1', [id]);
    if (!ticket) throw notFound('That request');

    await this.db.as(me, async (c) => {
      await c.query(
        `insert into support_messages (ticket_id, author, from_wetano, body) values ($1, $2, $3, $4)`,
        [id, person?.name ?? '', fromWetano, body.trim()]);
      await c.query(
        `update support_tickets set status = case when $2 then 'waiting'::ticket_status else 'open'::ticket_status end,
                updated_at = now() where id = $1`,
        [id, fromWetano]);
    });

    if (fromWetano) {
      await this.notifications.notify({
        companyId: ticket.company_id, kind: 'support_reply',
        title: `WeTano replied to ${ticket.number}`, body: ticket.subject, link: '/support',
      });
      const admins = await this.db.query<{ email: string }>(
        `select email from people where company_id = $1 and role = 'client_admin' and active`, [ticket.company_id]);
      for (const admin of admins) {
        await this.mail.send({
          to: admin.email,
          subject: `WeTa Snap support — ${ticket.number}`,
          html: this.mail.supportReply(ticket.number, ticket.subject, body),
        });
      }
    } else {
      await this.notifications.notify({
        companyId: null, kind: 'support_reply', title: `Reply on ${ticket.number}`, body: ticket.subject, link: '/super-admin/support',
      });
    }
    return this.byId(me, id);
  }

  async setStatus(me: Caller, id: string, status: string, assignedTo: string | null): Promise<TicketDto> {
    const row = await this.db.asOne<{ id: string }>(me,
      `update support_tickets set status = $2::ticket_status,
              assigned_to = coalesce($3, assigned_to), updated_at = now()
        where id = $1 returning id`,
      [id, status, assignedTo]);
    if (!row) throw notFound('That request');
    await this.audit.write(me, { action: 'support.status', entity: 'support_tickets', entityId: id, details: { status } });
    return this.byId(me, id);
  }

  private async byId(me: Caller, id: string): Promise<TicketDto> {
    const row = await this.db.asOne<TicketDto>(me, `${TICKET_SELECT} where t.id = $1`, [id]);
    if (!row) throw notFound('That request');
    return row;
  }
}
