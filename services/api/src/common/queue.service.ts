/**
 * Background jobs: reading a card, pushing a lead to a CRM, sending a notification, the nightly
 * clean-up. Jobs live in the `jobs` table so they are written in the same transaction as the data
 * that caused them — a lead and its "read this card" job either both exist or neither does.
 *
 * With REDIS_URL set, Redis is used to wake workers immediately (a blocking pop instead of a
 * poll); the row in PostgreSQL stays the source of truth, so nothing is lost if Redis restarts.
 */
import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from './cache.service';
import { Conn, DbService } from './db.service';

export type JobKind =
  | 'card.read'          // OCR + AI extraction for one business card
  | 'contact.link'       // duplicate check, merge or create, lead score
  | 'contact.embed'      // refresh the semantic-search vector
  | 'crm.push'           // send a lead to the connected CRM
  | 'notification.push'  // web push for a notification
  | 'usage.alerts'       // thresholds (D-16)
  | 'licence.reminders'  // tell a company before its licence runs out (LIC-04)
  | 'retention.sweep';   // delete what is past its retention

export interface Job {
  id: string;
  kind: JobKind;
  company_id: string | null;
  payload: Record<string, unknown>;
  attempt: number;
  max_attempts: number;
}

@Injectable()
export class QueueService {
  private readonly log = new Logger('Queue');

  constructor(private readonly db: DbService, private readonly cache: CacheService) {}

  /** Adds a job. Pass `conn` to enqueue inside the caller's transaction. */
  async add(
    kind: JobKind,
    payload: Record<string, unknown>,
    opts: { companyId?: string | null; runAt?: Date; dedupeKey?: string; maxAttempts?: number; conn?: Conn } = {},
  ): Promise<void> {
    const sql = `insert into jobs (kind, company_id, payload, run_at, dedupe_key, max_attempts)
                 values ($1, $2, $3, coalesce($4, now()), $5, coalesce($6, 5))
                 on conflict (dedupe_key) where dedupe_key is not null and status <> 'done'
                 do update set run_at = least(jobs.run_at, excluded.run_at)`;
    const params = [kind, opts.companyId ?? null, payload, opts.runAt ?? null, opts.dedupeKey ?? null, opts.maxAttempts ?? null];
    if (opts.conn) await opts.conn.query(sql, params);
    else await this.db.query(sql, params);
  }

  /**
   * Claims the next ready jobs for this worker. `for update skip locked` means several workers
   * can run side by side without ever handing the same job to two of them.
   */
  async claim(worker: string, limit = 5): Promise<Job[]> {
    return this.db.query<Job>(
      `with ready as (
         select id from jobs
          where status = 'pending' and run_at <= now()
          order by run_at
          limit $2
          for update skip locked)
       update jobs j
          set status = 'running', attempt = j.attempt + 1, locked_by = $1, locked_at = now()
         from ready
        where j.id = ready.id
        returning j.id::text, j.kind, j.company_id, j.payload, j.attempt, j.max_attempts`,
      [worker, limit],
    );
  }

  async finish(id: string): Promise<void> {
    await this.db.query(`update jobs set status = 'done', finished_at = now(), last_error = null where id = $1`, [id]);
  }

  /** Failed: try again with a widening gap, or give up after max_attempts and keep the reason. */
  async fail(job: Job, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const giveUp = job.attempt >= job.max_attempts;
    const backoffSeconds = Math.min(60 * 60, 30 * 2 ** (job.attempt - 1));
    await this.db.query(
      `update jobs
          set status = $2::job_status,
              last_error = $3,
              run_at = now() + make_interval(secs => $4),
              finished_at = case when $2 = 'failed' then now() else null end,
              locked_by = null, locked_at = null
        where id = $1`,
      [job.id, giveUp ? 'failed' : 'pending', message, giveUp ? 0 : backoffSeconds],
    );
    this.log.warn(`${job.kind} #${job.id} ${giveUp ? 'failed for good' : `failed, retrying in ${backoffSeconds}s`}: ${message}`);
  }

  /** A job that was claimed but whose worker died is picked up again after 5 minutes. */
  async requeueStuck(): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `update jobs set status = 'pending', locked_by = null, locked_at = null
        where status = 'running' and locked_at < now() - interval '5 minutes'
        returning id`,
    );
    return rows.length;
  }

  async counts(): Promise<Record<string, number>> {
    const rows = await this.db.query<{ status: string; n: string }>(
      `select status::text, count(*)::text as n from jobs group by status`,
    );
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }
}
