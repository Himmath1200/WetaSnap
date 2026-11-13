/**
 * Notifications and reminders (the bell in the header).
 *
 * A note is either for one person or for a whole company — "a lead could not be sent" goes to the
 * admins, "your licence ends in a week" to all of them. Company-wide notes are marked read per
 * person, so one admin reading something does not clear it for the others.
 */
import { Injectable } from '@nestjs/common';
import { DbService, type Caller } from '../../common/db.service';

export interface NotificationDto {
  id: string; company_id: string | null; person_id: string | null; kind: string;
  title: string; body: string; link: string | null; remind_at: string | null;
  created_at: string; read_at: string | null;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly db: DbService) {}

  async feed(me: Caller): Promise<NotificationDto[]> {
    if (me.role === 'super_admin') {
      return this.db.asQuery<NotificationDto>(me,
        `select n.id, n.company_id, n.person_id, n.kind::text as kind, n.title, n.body, n.link,
                n.remind_at, n.created_at,
                coalesce(n.read_at, r.read_at) as read_at
           from notifications n
      left join notification_reads r on r.notification_id = n.id and r.person_id = $1
          where (n.person_id = $1 or (n.company_id is null and n.person_id is null))
            and (n.remind_at is null or n.remind_at <= now() + interval '7 days')
          order by n.created_at desc
          limit 100`,
        [me.personId]);
    }

    if (me.role === 'individual') {
      return this.db.asQuery<NotificationDto>(me,
        `select n.id, n.company_id, n.person_id, n.kind::text as kind, n.title, n.body, n.link,
                n.remind_at, n.created_at,
                coalesce(n.read_at, r.read_at) as read_at
           from notifications n
      left join notification_reads r on r.notification_id = n.id and r.person_id = $1
          where n.person_id = $1
            and (n.remind_at is null or n.remind_at <= now() + interval '7 days')
          order by n.created_at desc
          limit 100`,
        [me.personId]);
    }

    // Company users: company-wide notifications or direct notifications for this person
    return this.db.asQuery<NotificationDto>(me,
      `select n.id, n.company_id, n.person_id, n.kind::text as kind, n.title, n.body, n.link,
              n.remind_at, n.created_at,
              coalesce(n.read_at, r.read_at) as read_at
         from notifications n
    left join notification_reads r on r.notification_id = n.id and r.person_id = $1
        where n.company_id = $2
          and (n.person_id = $1 or n.person_id is null)
          and (n.remind_at is null or n.remind_at <= now() + interval '7 days')
        order by n.created_at desc
        limit 100`,
      [me.personId, me.companyId]);
  }

  async markRead(me: Caller, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.as(me, async (c) => {
      await c.query(`update notifications set read_at = now() where id = any($1) and person_id = $2 and read_at is null`,
        [ids, me.personId]);
      await c.query(
        `insert into notification_reads (notification_id, person_id)
         select n.id, $2 from notifications n where n.id = any($1) and n.person_id is null
         on conflict do nothing`,
        [ids, me.personId]);
    });
  }

  async savePushSubscription(me: Caller, sub: { endpoint: string; keys: { p256dh: string; auth: string } } | null, device: string): Promise<void> {
    if (!sub) {
      await this.db.asQuery(me, 'delete from push_subscriptions where person_id = $1', [me.personId]);
      return;
    }
    await this.db.asQuery(me,
      `insert into push_subscriptions (person_id, endpoint, p256dh, auth, device)
       values ($1, $2, $3, $4, $5)
       on conflict (endpoint) do update set person_id = excluded.person_id, device = excluded.device`,
      [me.personId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, device.slice(0, 120)]);
  }

  /** Used by the jobs: one note per thing, never twice for the same thing. */
  async notify(input: {
    companyId: string | null; personId?: string | null; kind: string; title: string;
    body?: string; link?: string | null; dedupeKey?: string; remindAt?: Date | null;
  }): Promise<void> {
    await this.db.query(
      `insert into notifications (company_id, person_id, kind, title, body, link, dedupe_key, remind_at)
       values ($1, $2, $3::notification_kind, $4, $5, $6, $7, $8)
       on conflict (dedupe_key) where dedupe_key is not null do nothing`,
      [input.companyId, input.personId ?? null, input.kind, input.title.slice(0, 200),
        (input.body ?? '').slice(0, 2000), input.link ?? null, input.dedupeKey ?? null, input.remindAt ?? null]);
  }
}
