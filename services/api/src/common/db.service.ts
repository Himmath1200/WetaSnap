/**
 * PostgreSQL access. Two pools, on purpose:
 *
 *   app      everything a signed-in person asks for. Each call runs in a transaction that first
 *            sets app.person_id / app.company_id / app.role, so the row-level security policies in
 *            0006_rls.sql apply. A query that forgets its WHERE still cannot cross a company.
 *   service  sign-in (nobody is identified yet), background jobs and anything that must see the
 *            whole database. This role owns the tables, so policies do not apply to it — every
 *            call site has to carry its own check, which is why they are few and named.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { loadEnv } from './env';
import { DomainError } from './errors';

export interface Caller {
  personId: string;
  companyId: string | null;
  role: 'super_admin' | 'client_admin' | 'staff';
}

export type Sql = TemplateStringsArray;

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly log = new Logger('Db');
  private readonly app: Pool;
  private readonly service: Pool;

  constructor() {
    const env = loadEnv();
    const ssl = env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined;
    const common = { max: env.DATABASE_POOL_MAX, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, ssl };
    this.app = new Pool({ connectionString: env.DATABASE_URL, ...common });
    this.service = new Pool({ connectionString: env.SERVICE_DATABASE_URL, ...common });
    for (const [name, pool] of [['app', this.app], ['service', this.service]] as const) {
      pool.on('error', (e) => this.log.error(`${name} pool: ${e.message}`));
    }
  }

  async onModuleDestroy() {
    await Promise.allSettled([this.app.end(), this.service.end()]);
  }

  /** True when both pools answer — used by /health and at start-up. */
  async ping(): Promise<void> {
    await Promise.all([this.app.query('select 1'), this.service.query('select 1')]);
  }

  // ---------------------------------------------------------------- service (no policies)
  async query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    try {
      const r = await this.service.query<T>(text, params);
      return r.rows;
    } catch (e) {
      throw translate(e);
    }
  }

  async one<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  /** Several statements in one transaction, on the service connection. */
  async tx<T>(fn: (c: Conn) => Promise<T>): Promise<T> {
    const client = await this.service.connect();
    try {
      await client.query('begin');
      const out = await fn(wrap(client));
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw translate(e);
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------- app (policies apply)
  /**
   * Runs `fn` as this person: one transaction, with the identity set for the policies. Everything
   * a request does should go through here, including reads, so the rules are never optional.
   */
  async as<T>(caller: Caller, fn: (c: Conn) => Promise<T>): Promise<T> {
    const client = await this.app.connect();
    try {
      await client.query('begin');
      // set_config(..., true) = local to this transaction, so a pooled connection never leaks
      // one person's identity into the next request.
      await client.query(
        `select set_config('app.person_id', $1, true),
                set_config('app.company_id', coalesce($2, ''), true),
                set_config('app.role', $3, true)`,
        [caller.personId, caller.companyId, caller.role],
      );
      const out = await fn(wrap(client));
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw translate(e);
    } finally {
      client.release();
    }
  }

  /** A single statement as this person. */
  async asQuery<T extends QueryResultRow = QueryResultRow>(caller: Caller, text: string, params: unknown[] = []): Promise<T[]> {
    return this.as(caller, (c) => c.query<T>(text, params));
  }

  async asOne<T extends QueryResultRow = QueryResultRow>(caller: Caller, text: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.asQuery<T>(caller, text, params);
    return rows[0] ?? null;
  }
}

export interface Conn {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]>;
  one<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T | null>;
}

function wrap(client: PoolClient): Conn {
  return {
    async query<T extends QueryResultRow>(text: string, params: unknown[] = []) {
      const r = await client.query<T>(text, params);
      return r.rows;
    },
    async one<T extends QueryResultRow>(text: string, params: unknown[] = []) {
      const r = await client.query<T>(text, params);
      return r.rows[0] ?? null;
    },
  };
}

/**
 * Database errors become plain sentences. Everything the rules raise on purpose (seats, the last
 * admin, a plan in use) already reads like a sentence, so it is passed through; the rest are
 * turned into something a person can act on, and never leak a column or constraint name.
 */
export function translate(e: unknown): Error {
  const err = e as { code?: string; message?: string; constraint?: string; hint?: string; detail?: string };
  const code = err?.code ?? '';
  const message = err?.message ?? 'Something went wrong.';

  if (code === '23505') {
    if (/people_email/.test(err.constraint ?? '')) return new DomainError('This person already has access.', 409, 'email_taken');
    if (/tags_company_id_name/.test(err.constraint ?? '')) return new DomainError('A tag with that name already exists.', 409);
    return new DomainError('That already exists.', 409);
  }
  if (code === '23503') return new DomainError(cleanMessage(message, 'That is still in use somewhere else.'), 409);
  if (code === '23514' || code === '23502') {
    if (err.hint === 'seats_exhausted') return new DomainError(message, 409, 'seats_exhausted');
    return new DomainError(cleanMessage(message, 'Some of those details are not valid.'), 400);
  }
  if (code === '42501') return new DomainError('You do not have permission to do this.', 403);
  // A missing table means the schema is not in step with the code, which is ours to fix, not theirs.
  if (code === '42P01' || code === '42703') return new DomainError('The server is not ready. Please try again in a moment.', 503, 'schema_mismatch');
  if (code === 'P0001') return new DomainError(message, 400);       // raise exception in a rule
  if (code === 'ECONNREFUSED' || code === '57P03') return new DomainError('The database is not reachable just now.', 503);

  return e instanceof Error ? e : new Error(message);
}

/** Keeps a rule's own wording, but never a raw Postgres sentence full of identifiers. */
function cleanMessage(message: string, fallback: string): string {
  const looksWritten = /[a-z] [a-z]+ [a-z]/i.test(message) && !/relation |column |constraint "|violates/i.test(message);
  return looksWritten ? message : fallback;
}
