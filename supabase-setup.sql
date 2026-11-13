-- ============================================================================
-- WeTa Snap — Complete Supabase PostgreSQL Database Setup Script
-- ============================================================================
-- Run this script in the Supabase SQL Editor (https://supabase.com/dashboard/project/_/sql).
-- ============================================================================

-- 1. Enable Required Extensions
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists unaccent;
create extension if not exists vector;

-- 2. Enumerated Types
do $$ begin create type app_role as enum ('super_admin', 'client_admin', 'staff', 'individual', 'organizer'); exception when duplicate_object then null; end $$;
do $$ begin create type licence_type as enum ('trial', 'monthly', 'annual'); exception when duplicate_object then null; end $$;
do $$ begin create type scan_limit_action as enum ('block', 'overage', 'notify'); exception when duplicate_object then null; end $$;
do $$ begin create type login_method as enum ('code', 'password', 'totp', 'recovery'); exception when duplicate_object then null; end $$;
do $$ begin create type password_purpose as enum ('reset', 'change'); exception when duplicate_object then null; end $$;
do $$ begin create type event_status as enum ('open', 'closed'); exception when duplicate_object then null; end $$;
do $$ begin create type field_type as enum ('text', 'email', 'phone', 'link', 'choice', 'longtext'); exception when duplicate_object then null; end $$;
do $$ begin create type field_filler as enum ('ai', 'staff'); exception when duplicate_object then null; end $$;
do $$ begin create type tag_colour as enum ('green', 'blue', 'amber', 'red', 'purple', 'slate'); exception when duplicate_object then null; end $$;
do $$ begin create type connector_kind as enum ('zoho_crm', 'zoho_bigin', 'hubspot', 'salesforce', 'webhook', 'csv'); exception when duplicate_object then null; end $$;
do $$ begin create type connection_status as enum ('connected', 'error', 'disconnected'); exception when duplicate_object then null; end $$;
do $$ begin create type connection_mode as enum ('auto', 'manual'); exception when duplicate_object then null; end $$;
do $$ begin create type notification_kind as enum ('lead_failed', 'leads_waiting', 'licence_expiring', 'licence_expired', 'event_starting', 'person_invited', 'import_done', 'support_reply', 'subscription'); exception when duplicate_object then null; end $$;
do $$ begin create type lead_status as enum ('waiting', 'synced', 'in_crm', 'check'); exception when duplicate_object then null; end $$;
do $$ begin create type lead_interest as enum ('hot', 'warm', 'cold'); exception when duplicate_object then null; end $$;
do $$ begin create type lead_source as enum ('camera', 'upload', 'manual'); exception when duplicate_object then null; end $$;
do $$ begin create type ticket_status as enum ('open', 'pending', 'solved', 'closed'); exception when duplicate_object then null; end $$;
do $$ begin create type ticket_priority as enum ('low', 'normal', 'high', 'urgent'); exception when duplicate_object then null; end $$;
do $$ begin create type billing_cycle as enum ('monthly', 'annual'); exception when duplicate_object then null; end $$;
do $$ begin create type invoice_status as enum ('draft', 'sent', 'paid', 'overdue', 'cancelled'); exception when duplicate_object then null; end $$;

-- 3. Core Helper Functions
create or replace function app_person_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.person_id', true), '')::uuid $$;

create or replace function app_company_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.company_id', true), '')::uuid $$;

create or replace function app_role() returns app_role
language sql stable as $$ select nullif(current_setting('app.role', true), '')::app_role $$;

create or replace function is_super_admin() returns boolean
language sql stable as $$ select app_role() = 'super_admin' $$;

create or replace function is_admin() returns boolean
language sql stable as $$ select app_role() in ('super_admin', 'client_admin', 'organizer') $$;

create or replace function may_see_lead(p_company_id uuid, p_captured_by uuid) returns boolean
language sql stable as $$
  select is_super_admin()
      or (p_company_id is not null and p_company_id = app_company_id() and (is_admin() or p_captured_by = app_person_id()))
      or (p_company_id is null and (
            p_captured_by = app_person_id()
            or app_role() = 'organizer' and p_captured_by in (select id from people where organizer_id = app_person_id())
         ))
$$;

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- 4. Companies & Licences
create table if not exists companies (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null check (length(btrim(name)) between 1 and 200),
  country                 text not null default '',
  headquarters            text not null default '',
  default_language        text not null default 'en',
  time_zone               text not null default 'UTC',
  logo_url                text,
  consent_text            text not null default 'I agree that my contact details are stored and used to follow up on our conversation.',
  consent_version         integer not null default 1 check (consent_version >= 1),
  retention_leads_months  integer not null default 24 check (retention_leads_months between 1 and 120),
  retention_photos_months integer not null default 12 check (retention_photos_months between 1 and 120),
  cloud_ai_enabled        boolean not null default true,
  offline_pack_enabled    boolean not null default false,
  suspended               boolean not null default false,
  suspended_reason        text not null default '',
  scan_limit_action       scan_limit_action not null default 'notify',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table if not exists licences (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null unique references companies(id) on delete cascade,
  type               licence_type not null default 'trial',
  starts_on          date not null default current_date,
  ends_on            date not null,
  seats              integer not null default 5 check (seats between 1 and 10000),
  scans_per_month    integer not null default 0 check (scans_per_month >= 0),
  connectors_allowed text[] not null default '{webhook,csv}',
  reminders_sent     integer[] not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- 5. Users & Credentials
create table if not exists people (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid references companies(id) on delete cascade,
  email            text not null unique,
  name             text not null default '',
  phone            text not null default '',
  role             app_role not null default 'staff',
  plan             text not null default 'free' check (plan in ('free', 'pro')),
  monthly_scans    integer not null default 0 check (monthly_scans >= 0),
  scans_reset_at   timestamptz not null default (now() + interval '30 days'),
  default_event_id uuid,
  access_ends_on   date,
  active           boolean not null default true,
  invited          boolean not null default false,
  avatar_url       text,
  has_password     boolean not null default false,
  mfa_enabled      boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists person_credentials (
  person_id    uuid primary key references people(id) on delete cascade,
  password_hash text not null,
  history      text[] not null default '{}',
  changed_at   timestamptz not null default now(),
  mfa_secret   text,
  failed       integer not null default 0,
  locked_until timestamptz
);

create table if not exists device_sessions (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references people(id) on delete cascade,
  token_hash   text not null unique,
  device_label text not null default 'Unknown Device',
  ip           text not null default '',
  user_agent   text not null default '',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at   timestamptz not null
);

create table if not exists security_policy (
  id                        text primary key default 'current' check (id = 'current'),
  min_length                integer not null default 8 check (min_length between 8 and 128),
  require_upper             boolean not null default false,
  require_number            boolean not null default false,
  require_symbol            boolean not null default false,
  expiry_days               integer not null default 180 check (expiry_days between 0 and 3650),
  reuse_block               integer not null default 5 check (reuse_block between 0 and 24),
  lockout_attempts          integer not null default 10 check (lockout_attempts between 1 and 50),
  lockout_minutes           integer not null default 15 check (lockout_minutes between 1 and 1440),
  idle_timeout_minutes      integer not null default 30 check (idle_timeout_minutes between 0 and 1440),
  device_session_days       integer not null default 30 check (device_session_days between 1 and 365),
  mfa_required_super_admin  boolean not null default false,
  mfa_required_client_admin boolean not null default false,
  updated_at                timestamptz not null default now(),
  updated_by                uuid
);
insert into security_policy (id) values ('current') on conflict (id) do nothing;

create table if not exists login_events (
  id                 bigserial primary key,
  at                 timestamptz not null default now(),
  email              text not null default '',
  person_id          uuid references people(id) on delete set null,
  method             login_method not null default 'password',
  ok                 boolean not null default false,
  reason             text not null default '',
  device             text not null default '',
  ip                 inet,
  location           text not null default '',
  counts_for_lockout boolean not null default false
);

create table if not exists login_codes (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references people(id) on delete cascade,
  session_id uuid not null references device_sessions(id) on delete cascade,
  code_hash  text not null,
  attempts   integer not null default 0,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists password_codes (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  person_id  uuid references people(id) on delete cascade,
  purpose    password_purpose not null default 'reset',
  code_hash  text not null,
  attempts   integer not null default 0,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists recovery_codes (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references people(id) on delete cascade,
  code_hash  text not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  company_id  uuid,
  actor_id    uuid,
  actor_role  app_role,
  actor_email text not null default '',
  action      text not null,
  entity      text not null,
  entity_id   text,
  ip          inet,
  details     jsonb not null default '{}'
);

-- 6. Events, Fields & Tags
create table if not exists field_templates (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  name        text not null,
  description text not null default '',
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists field_definitions (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  template_id uuid not null references field_templates(id) on delete cascade,
  key         text not null,
  label       text not null,
  type        field_type not null default 'text',
  options     text[] not null default '{}',
  required    boolean not null default false,
  ai_hint     text not null default '',
  filled_by   field_filler not null default 'ai',
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (template_id, key)
);

create table if not exists events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references companies(id) on delete cascade,
  name        text not null,
  starts_on   date not null,
  ends_on     date not null,
  venue       text not null default '',
  booth       text not null default '',
  status      event_status not null default 'open',
  description text not null default '',
  time_zone   text not null default 'UTC',
  template_id uuid references field_templates(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists person_events (
  person_id  uuid not null references people(id) on delete cascade,
  event_id   uuid not null references events(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (person_id, event_id)
);

create table if not exists tags (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name       text not null,
  colour     tag_colour not null default 'green',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, name)
);

create table if not exists connections (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null unique references companies(id) on delete cascade,
  connector   connector_kind not null,
  status      connection_status not null default 'disconnected',
  mode        connection_mode not null default 'auto',
  mapping     jsonb not null default '{}',
  settings    jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 7. Leads & Contacts
create table if not exists leads (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid references companies(id) on delete cascade,
  event_id         text not null default '',
  captured_by      uuid not null references people(id) on delete cascade,
  captured_by_name text not null default '',
  device           text not null default '',
  source           lead_source not null default 'camera',
  fields           jsonb not null default '{}',
  interest         lead_interest,
  notes            text not null default '',
  consent          boolean not null default false,
  consent_version  integer not null default 1,
  consent_at       timestamptz,
  status           lead_status not null default 'waiting',
  crm_error        text,
  crm_record_id    text,
  tag_ids          uuid[] not null default '{}',
  has_photo        boolean not null default false,
  has_back_photo   boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  synced_at        timestamptz,
  deleted_at       timestamptz,
  search_text      text generated always as (lower((jsonb_path_query_array(fields, '$.*."value"'))::text || ' ' || notes)) stored
);

create index if not exists leads_search_idx on leads using gin (search_text gin_trgm_ops);

-- 8. Plans, Billing & Subscriptions
create table if not exists plans (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null unique,
  description        text not null default '',
  price_month        integer not null default 0,
  price_year         integer not null default 0,
  currency           text not null default 'USD',
  seats              integer not null default 5,
  scans_per_month    integer not null default 0,
  connectors_allowed text[] not null default '{webhook,csv}',
  features           text[] not null default '{}',
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists subscriptions (
  company_id    uuid primary key references companies(id) on delete cascade,
  plan_id       uuid references plans(id) on delete set null,
  billing_cycle billing_cycle not null default 'monthly',
  renews_on     date not null default (current_date + 30),
  auto_renew    boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists document_numbers (
  prefix     text not null,
  year       integer not null,
  next_value bigint not null default 10000,
  primary key (prefix, year)
);

create or replace function next_document_number(p_prefix text) returns text
language plpgsql as $$
declare
  v_year integer := extract(year from current_date);
  v_next bigint;
begin
  insert into document_numbers (prefix, year, next_value) values (p_prefix, v_year, 10001)
    on conflict (prefix, year) do update set next_value = document_numbers.next_value + 1
    returning next_value into v_next;
  return format('%s-%s-%s', p_prefix, v_year, v_next);
end $$;

create table if not exists invoices (
  id           uuid primary key default gen_random_uuid(),
  number       text not null unique,
  company_id   uuid not null references companies(id) on delete cascade,
  plan_id      uuid references plans(id) on delete set null,
  plan_name    text not null default '',
  period_start date not null,
  period_end   date not null,
  amount       bigint not null default 0,
  tax          bigint not null default 0,
  currency     text not null default 'EUR',
  status       invoice_status not null default 'draft',
  issued_on    date not null default current_date,
  due_on       date not null,
  paid_on      date,
  paid_by      text not null default '',
  notes        text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists individual_pricing (
  id                uuid primary key default gen_random_uuid(),
  free_scans_limit  integer not null default 5,
  pro_price_month   integer not null default 100,
  pro_price_year    integer not null default 1150,
  currency          text not null default 'USD',
  free_features     text[] not null default '{
    "5 business card scans per month",
    "Fast on-device document alignment",
    "Standard offline text extraction",
    "Single contact export",
    "Standard community support"
  }',
  pro_features      text[] not null default '{
    "Unlimited card scans every month",
    "Google Gemini AI OCR field verification",
    "Bulk Excel (.xlsx), CSV and PDF export",
    "Multi-device automatic cloud sync",
    "Voice memos & business card photo attachments",
    "Priority 24/7 customer support",
    "No overage fees or hidden charges"
  }',
  updated_at        timestamptz not null default now()
);

create table if not exists support_tickets (
  id           uuid primary key default gen_random_uuid(),
  number       text not null unique,
  company_id   text not null default '',
  company_name text not null default '',
  opened_by    text not null,
  subject      text not null,
  body         text not null,
  status       ticket_status not null default 'open',
  priority     ticket_priority not null default 'normal',
  assigned_to  text,
  messages     jsonb not null default '[]',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists support_messages (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid not null references support_tickets(id) on delete cascade,
  author      text not null default '',
  from_wetano boolean not null default false,
  body        text not null,
  at          timestamptz not null default now()
);

create table if not exists licence_history (
  id          bigserial primary key,
  licence_id  uuid,
  company_id  uuid references companies(id) on delete cascade,
  changed_by  uuid,
  changed_at  timestamptz not null default now(),
  action      text not null,
  old_values  jsonb,
  new_values  jsonb not null default '{}',
  summary     text not null default ''
);

create table if not exists password_history (
  id          bigserial primary key,
  person_id   uuid not null references people(id) on delete cascade,
  password_hash text not null,
  changed_at  timestamptz not null default now()
);

create table if not exists usage_alerts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  metric      text not null,
  threshold   integer not null,
  window_days integer not null default 1,
  notification_interval_hours integer not null default 24,
  last_alerted_at timestamptz,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists usage_events (
  id          bigserial primary key,
  company_id  uuid references companies(id) on delete cascade,
  person_id   uuid references people(id) on delete set null,
  event_type  text not null,
  count       integer not null default 1,
  recorded_at timestamptz not null default now()
);

-- 9. Starter Seed Data (Safe: only inserts if not already present)
insert into individual_pricing (free_scans_limit, pro_price_month, pro_price_year, currency)
select 5, 100, 1150, 'USD'
where not exists (select 1 from individual_pricing);

insert into plans (name, description, price_month, price_year, currency, seats, scans_per_month, connectors_allowed, features)
values 
  ('Starter', 'One booth, one exhibition', 4900, 49000, 'EUR', 3, 500, '{webhook,csv}', '{"Local card reading","CSV export"}'),
  ('Growth', 'A team on the road', 14900, 149000, 'EUR', 10, 2000, '{webhook,csv,hubspot}', '{"CRM connection","Shared tags","Import"}'),
  ('Scale', 'Multiple teams and halls', 39900, 399000, 'EUR', 50, 0, '{webhook,csv,hubspot,salesforce,zoho_crm}', '{"Unlimited scans","All connectors","Priority support"}')
on conflict (name) do nothing;

-- Super Admin Account: super@wetano.com / WetaSnap#2026
insert into people (id, email, name, role, has_password, active)
values ('00000000-0000-0000-0000-000000000001', 'super@wetano.com', 'WeTano Support', 'super_admin', true, true)
on conflict (email) do nothing;

insert into person_credentials (person_id, password_hash)
values (
  '00000000-0000-0000-0000-000000000001',
  'scrypt$32768$8$1$YnEBZwwwlo05GtkJIgEgaQ$Ij61a3s36pEjCKUjOxYA5FmV5aM9MGDFT5SIePIHxS0'
)
on conflict (person_id) do update set password_hash = excluded.password_hash;

select 'WeTa Snap Supabase database initialized successfully' as status;
