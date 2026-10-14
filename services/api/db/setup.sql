-- WeTa Snap — one-time PostgreSQL setup (run once, as a superuser).
--
--   psql -U postgres -h 127.0.0.1 -p 5433 -f services/api/db/setup.sql
--
-- (5433 is PostgreSQL 15 on this machine — the one with pgvector. Use -p 5432 for a default install.)
--
-- It creates two roles, one database and the extensions:
--   wetasnap_app      what the API uses for anything a signed-in person does. It owns nothing and
--                     row-level security applies to it, so a bug in one request cannot read
--                     another company's rows.
--   wetasnap_service  the owner. Sign-in, background jobs and migrations use this one; it is the
--                     only role the policies do not apply to.
--
-- Extensions go in their own schema, so `npm run db:reset` (which drops `public`) leaves them
-- alone. Change the passwords here and in services/api/.env if this is not a development machine.

\set app_password 'wetasnap_dev_8UY6I2LupwBmUNKK'
\set service_password 'wetasnap_dev_8UY6I2LupwBmUNKK'

select format('create role wetasnap_service login password %L', :'service_password')
 where not exists (select 1 from pg_roles where rolname = 'wetasnap_service') \gexec
select format('create role wetasnap_app login password %L', :'app_password')
 where not exists (select 1 from pg_roles where rolname = 'wetasnap_app') \gexec

-- A superuser cannot hand a database to a role it is not a member of.
select 'grant wetasnap_service to ' || current_user
 where not pg_has_role(current_user, 'wetasnap_service', 'member') \gexec

select 'create database wetasnap owner wetasnap_service encoding ''UTF8'''
 where not exists (select 1 from pg_database where datname = 'wetasnap') \gexec

\connect wetasnap

grant connect on database wetasnap to wetasnap_app, wetasnap_service;
-- Whoever created the database, the service role owns it from here on, so migrations and
-- `npm run db:reset` need nobody with more rights.
alter database wetasnap owner to wetasnap_service;
grant create on database wetasnap to wetasnap_service;
create schema if not exists public authorization wetasnap_service;
alter schema public owner to wetasnap_service;
grant usage on schema public to wetasnap_app;

create schema if not exists extensions authorization wetasnap_service;
grant usage on schema extensions to wetasnap_app, wetasnap_service;

create extension if not exists pgcrypto with schema extensions;   -- gen_random_uuid(), digests
create extension if not exists pg_trgm with schema extensions;    -- fuzzy name / company matching
create extension if not exists unaccent with schema extensions;   -- "Müller" matches "Muller"
-- pgvector is optional: semantic contact search falls back to trigram matching without it.
-- Install it from https://github.com/pgvector/pgvector and run this file again to switch it on.
create extension if not exists vector with schema extensions;

-- So every session finds the extensions without naming the schema.
alter database wetasnap set search_path to public, extensions;
alter role wetasnap_app set search_path to public, extensions;
alter role wetasnap_service set search_path to public, extensions;

select 'wetasnap database ready' as status;
