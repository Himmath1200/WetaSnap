-- WeTa Snap — one-time setup, for pgAdmin (the Query Tool cannot run psql's \set or \connect).
-- With psql, use setup.sql instead; it does both steps in one go.
--
-- Two names that are easy to mix up:
--   wetasnap_app / wetasnap_service   are LOGIN ROLES (users). They are not databases.
--   wetasnap                          is the DATABASE. There is only one.
--
-- Run STEP 1 with the Query Tool open on the "postgres" database, then refresh the server,
-- open a new Query Tool on the new "wetasnap" database and run STEP 2.
--
-- Change the password below if this is not a development machine, and put the same one in
-- services/api/.env.

-- ════════════════════════════════════════════════════════════════════════════
-- STEP 1 — on the "postgres" database
-- ════════════════════════════════════════════════════════════════════════════

-- The two roles the API connects as:
--   wetasnap_app      every request a signed-in person makes; row-level security applies to it
--   wetasnap_service  the owner — migrations, sign-in and background jobs
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'wetasnap_service') then
    create role wetasnap_service login password 'wetasnap_dev_8UY6I2LupwBmUNKK';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'wetasnap_app') then
    create role wetasnap_app login password 'wetasnap_dev_8UY6I2LupwBmUNKK';
  end if;
end $$;

-- A superuser cannot hand a database to a role it is not a member of.
grant wetasnap_service to current_user;

-- Select JUST this line and execute it on its own: pgAdmin wraps a whole script in one
-- transaction, and PostgreSQL will not create a database inside a transaction block
-- ("CREATE DATABASE cannot run inside a transaction block"). The same thing can be done from
-- the tree instead: Databases → right-click → Create → Database…, name "wetasnap",
-- owner "wetasnap_service".
create database wetasnap owner wetasnap_service encoding 'UTF8';

-- ════════════════════════════════════════════════════════════════════════════
-- STEP 2 — on the "wetasnap" database (open a new Query Tool there)
-- ════════════════════════════════════════════════════════════════════════════

grant connect on database wetasnap to wetasnap_app, wetasnap_service;
-- Whoever created the database (pgAdmin's dialog defaults to the postgres user), the service role
-- owns it from here on, so migrations and `npm run db:reset` need nobody with more rights.
alter database wetasnap owner to wetasnap_service;
grant create on database wetasnap to wetasnap_service;
create schema if not exists public authorization wetasnap_service;
alter schema public owner to wetasnap_service;
grant usage on schema public to wetasnap_app;

-- Extensions live in their own schema, so `npm run db:reset` (which drops `public`) leaves them.
create schema if not exists extensions authorization wetasnap_service;
grant usage on schema extensions to wetasnap_app, wetasnap_service;

create extension if not exists pgcrypto with schema extensions;   -- gen_random_uuid(), digests
create extension if not exists pg_trgm with schema extensions;    -- fuzzy name / company matching
create extension if not exists unaccent with schema extensions;   -- "Müller" matches "Muller"
-- Optional: semantic contact search. Without it the search falls back to trigram matching.
create extension if not exists vector with schema extensions;

-- So every session finds the extensions without naming the schema.
alter database wetasnap set search_path to public, extensions;
alter role wetasnap_app set search_path to public, extensions;
alter role wetasnap_service set search_path to public, extensions;

select 'wetasnap database ready' as status;
