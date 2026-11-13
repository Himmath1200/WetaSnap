/**
 * Migrations — plain .sql files, applied in order, each in one transaction.
 *
 *   npm run migrate          apply everything new
 *   npm run migrate:status   what is applied and what is pending
 *   npm run db:reset         drop the schema and build it again (development only)
 *
 * They run on SERVICE_DATABASE_URL, the role that owns the schema. A file that has already been
 * applied is never re-run, and its checksum is compared so an edited migration is caught rather
 * than silently ignored.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { loadEnv } from '../src/common/env';

const DIR = join(__dirname, 'migrations');

const files = () =>
  readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

const checksum = (sql: string) => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);

function cleanDbUrl(url: string): string {
  return url.replace(/([?&])sslmode=[^&]+(&|$)/, '$1').replace(/[?&]$/, '');
}

async function connect(): Promise<Client> {
  const env = loadEnv();
  const client = new Client({ connectionString: cleanDbUrl(env.SERVICE_DATABASE_URL), ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  return client;
}

async function applied(c: Client): Promise<Map<string, string>> {
  await c.query(`create table if not exists schema_migrations (
    name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  const { rows } = await c.query<{ name: string; checksum: string }>('select name, checksum from schema_migrations');
  return new Map(rows.map((r) => [r.name, r.checksum]));
}

async function up() {
  const c = await connect();
  try {
    const done = await applied(c);
    let n = 0;
    for (const name of files()) {
      const sql = readFileSync(join(DIR, name), 'utf8');
      const sum = checksum(sql);
      const was = done.get(name);
      if (was) {
        if (was !== sum) {
          throw new Error(`${name} changed after it was applied (${was} → ${sum}). ` +
            'Add a new migration instead, or run db:reset on a development database.');
        }
        continue;
      }
      process.stdout.write(`  applying ${name} … `);
      await c.query('begin');
      try {
        await c.query(sql);
        await c.query('insert into schema_migrations (name, checksum) values ($1, $2)', [name, sum]);
        await c.query('commit');
        n += 1;
        console.log('ok');
      } catch (e) {
        await c.query('rollback');
        console.log('failed');
        throw e;
      }
    }
    console.log(n ? `${n} migration(s) applied.` : 'Already up to date.');
  } finally {
    await c.end();
  }
}

async function status() {
  const c = await connect();
  try {
    const done = await applied(c);
    for (const name of files()) {
      const sql = readFileSync(join(DIR, name), 'utf8');
      const was = done.get(name);
      const state = !was ? 'pending' : was === checksum(sql) ? 'applied' : 'CHANGED since it was applied';
      console.log(`  ${name.padEnd(28)} ${state}`);
    }
  } finally {
    await c.end();
  }
}

/**
 * Empties `public` without dropping it: the schema itself is only re-creatable by whoever owns
 * the database, and the API's own role may not. Everything an extension brought with it is left
 * alone — the extensions live in their own schema anyway.
 */
async function reset() {
  if (process.env.NODE_ENV === 'production') throw new Error('db:reset does not run in production.');
  const c = await connect();
  try {
    console.log('  emptying schema public …');
    await c.query(`
      do $$
      declare r record;
      begin
        for r in select c.oid::regclass as name from pg_class c
                  join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind in ('r', 'p')
                   and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
        loop
          execute format('drop table if exists %s cascade', r.name);
        end loop;

        for r in select p.oid::regprocedure as sig from pg_proc p
                  join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public'
                   and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        loop
          execute format('drop function if exists %s cascade', r.sig);
        end loop;

        for r in select t.oid::regtype as name from pg_type t
                  join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typtype = 'e'
                   and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e')
        loop
          execute format('drop type if exists %s cascade', r.name);
        end loop;
      end $$;`);
  } finally {
    await c.end();
  }
  await up();
}

const cmd = process.argv[2] ?? 'up';
const run = cmd === 'status' ? status : cmd === 'reset' ? reset : up;
run().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
