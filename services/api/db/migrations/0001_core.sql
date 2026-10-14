-- 0001 · Core — tenants, people, credentials, sessions and the security policy.
--
-- Every table lives in `public` and is owned by wetasnap_service. The API uses two connections:
--   wetasnap_app      row-level security applies; every statement runs with app.person_id set
--   wetasnap_service  the owner, so it is not subject to the policies: sign-in (before anyone is
--                     identified), background jobs and migrations
-- Policies and grants are in 0005_rls.sql, so the shape of the data stays readable here.

-- ---------------------------------------------------------------- enums
create type app_role           as enum ('super_admin', 'client_admin', 'staff');
create type licence_type       as enum ('trial', 'monthly', 'annual');
create type scan_limit_action  as enum ('block', 'overage', 'notify');
create type login_method       as enum ('code', 'password', 'totp', 'recovery');
create type password_purpose   as enum ('reset', 'change');

-- ---------------------------------------------------------------- helpers
-- Who the current statement is for. Set per transaction by the API (see DbService).
create or replace function app_person_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.person_id', true), '')::uuid $$;

create or replace function app_company_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.company_id', true), '')::uuid $$;

create or replace function app_role() returns app_role
language sql stable as $$ select nullif(current_setting('app.role', true), '')::app_role $$;

create or replace function is_super_admin() returns boolean
language sql stable as $$ select app_role() = 'super_admin' $$;

create or replace function is_admin() returns boolean
language sql stable as $$ select app_role() in ('super_admin', 'client_admin') $$;

-- updated_at on every write, without each service remembering to set it.
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------- companies (the tenants)
create table companies (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null check (length(btrim(name)) between 1 and 200),
  country                 text not null default '',
  headquarters            text not null default '' check (length(headquarters) <= 500),
  default_language        text not null default 'en' check (default_language ~ '^[a-z]{2}(-[A-Za-z]{2,8})?$'),
  time_zone               text not null default 'UTC' check (length(time_zone) between 1 and 60),
  logo_url                text,
  consent_text            text not null default 'I agree that my contact details are stored and used to follow up on our conversation.',
  consent_version         integer not null default 1 check (consent_version >= 1),
  retention_leads_months  integer not null default 24 check (retention_leads_months between 1 and 120),
  retention_photos_months integer not null default 12 check (retention_photos_months between 1 and 120),
  cloud_ai_enabled        boolean not null default true,
  offline_pack_enabled    boolean not null default false,
  suspended               boolean not null default false,
  suspended_reason        text not null default '' check (length(suspended_reason) <= 500),
  scan_limit_action       scan_limit_action not null default 'notify',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create trigger companies_touch before update on companies for each row execute function touch_updated_at();

-- When a company was suspended: leads captured before it still sync (W5).
create table company_suspensions (
  company_id   uuid primary key references companies(id) on delete cascade,
  suspended_at timestamptz not null default now()
);

create table licences (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null unique references companies(id) on delete cascade,
  type               licence_type not null default 'trial',
  starts_on          date not null default current_date,
  ends_on            date not null,
  seats              integer not null check (seats between 1 and 10000),
  scans_per_month    integer not null default 0 check (scans_per_month >= 0),  -- 0 = unlimited
  connectors_allowed text[] not null default '{webhook,csv}',
  reminders_sent     integer[] not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint licences_dates check (ends_on >= starts_on)
);
create trigger licences_touch before update on licences for each row execute function touch_updated_at();

create table licence_history (
  id         bigserial primary key,
  licence_id uuid not null references licences(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  changed_by uuid,
  changed_at timestamptz not null default now(),
  action     text not null check (action in ('created', 'updated')),
  old_values jsonb,
  new_values jsonb not null,
  summary    text not null default ''
);
create index licence_history_company_idx on licence_history (company_id, changed_at desc);

-- ---------------------------------------------------------------- people (the users)
create table people (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid references companies(id) on delete cascade,
  email            text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 200),
  name             text not null default '',
  phone            text not null default '' check (length(phone) <= 40),
  role             app_role not null default 'staff',
  default_event_id uuid,
  access_ends_on   date,
  active           boolean not null default true,
  invited          boolean not null default true,     -- until the first-time setup is done
  has_password     boolean not null default false,
  mfa_enabled      boolean not null default false,
  avatar_url       text check (avatar_url is null or length(avatar_url) <= 500),
  deactivated_at   timestamptz,
  last_sign_in_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- WeTano accounts belong to no company; everyone else must have one.
  constraint people_role_company check ((role = 'super_admin') = (company_id is null))
);
create unique index people_email_key on people (lower(email));
create index people_company_idx on people (company_id) where company_id is not null;
create trigger people_touch before update on people for each row execute function touch_updated_at();

-- Secrets live apart from the profile: the app role has no grant on this table at all, so a
-- mistake in any ordinary query cannot read a password hash or a TOTP secret.
create table person_credentials (
  person_id        uuid primary key references people(id) on delete cascade,
  password_hash    text,                      -- scrypt: scrypt$N$r$p$salt$hash
  password_set_at  timestamptz,
  mfa_secret       text,                      -- base32, only while mfa_enabled
  mfa_pending      text,                      -- enrolment waiting for its first code
  failed_attempts  integer not null default 0,
  locked_until     timestamptz,
  updated_at       timestamptz not null default now()
);

create table password_history (
  id         bigserial primary key,
  person_id  uuid not null references people(id) on delete cascade,
  hash       text not null,
  changed_at timestamptz not null default now()
);
create index password_history_person_idx on password_history (person_id, changed_at desc);

create table recovery_codes (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references people(id) on delete cascade,
  code_hash  text not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index recovery_codes_person_idx on recovery_codes (person_id) where used_at is null;

-- ---------------------------------------------------------------- sessions
-- One row per signed-in device. The bearer token is never stored, only its SHA-256.
create type auth_stage as enum ('password', 'email_code', 'totp', 'ready');

create table device_sessions (
  id                 uuid primary key default gen_random_uuid(),
  person_id          uuid not null references people(id) on delete cascade,
  token_hash         text not null unique,
  stage              auth_stage not null default 'ready',
  portal             app_role,
  device             text not null default '' check (length(device) <= 200),
  ip                 inet,
  location           text not null default '' check (length(location) <= 120),
  user_agent         text not null default '' check (length(user_agent) <= 400),
  created_at         timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  expires_at         timestamptz not null,
  revoked_at         timestamptz
);
create index device_sessions_person_idx on device_sessions (person_id) where revoked_at is null;
create index device_sessions_expiry_idx on device_sessions (expires_at) where revoked_at is null;

-- The 6-digit code admins type after their password. One live code per session.
create table login_codes (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references people(id) on delete cascade,
  session_id uuid not null references device_sessions(id) on delete cascade,
  code_hash  text not null,
  attempts   integer not null default 0 check (attempts >= 0),
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index login_codes_session_idx on login_codes (session_id) where used_at is null;

-- Setting the first password, and resetting a forgotten one (AUTH-08).
create table password_codes (
  id         uuid primary key default gen_random_uuid(),
  email      text not null check (length(email) <= 200),
  person_id  uuid references people(id) on delete cascade,
  purpose    password_purpose not null default 'reset',
  code_hash  text not null,
  attempts   integer not null default 0 check (attempts >= 0),
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index password_codes_email_idx on password_codes (lower(email), purpose) where used_at is null;

-- Every sign-in attempt, good or bad. `counts_for_lockout` is what the lockout counts.
create table login_events (
  id                 bigserial primary key,
  at                 timestamptz not null default now(),
  email              text not null default '' check (length(email) <= 200),
  person_id          uuid references people(id) on delete set null,
  method             login_method not null default 'password',
  ok                 boolean not null default false,
  reason             text not null default '' check (length(reason) <= 300),
  device             text not null default '' check (length(device) <= 200),
  ip                 inet,
  location           text not null default '' check (length(location) <= 120),
  counts_for_lockout boolean not null default false
);
create index login_events_email_idx on login_events (lower(email), at desc);
create index login_events_person_idx on login_events (person_id, at desc);

-- ---------------------------------------------------------------- policy, limits, audit
create table security_policy (
  id                        text primary key default 'current' check (id = 'current'),
  min_length                integer not null default 12 check (min_length between 8 and 128),
  require_upper             boolean not null default true,
  require_number            boolean not null default true,
  require_symbol            boolean not null default true,
  expiry_days               integer not null default 180 check (expiry_days between 0 and 3650),
  reuse_block               integer not null default 5 check (reuse_block between 0 and 24),
  lockout_attempts          integer not null default 5 check (lockout_attempts between 1 and 50),
  lockout_minutes           integer not null default 15 check (lockout_minutes between 1 and 1440),
  idle_timeout_minutes      integer not null default 30 check (idle_timeout_minutes between 0 and 1440),
  device_session_days       integer not null default 30 check (device_session_days between 1 and 365),
  mfa_required_super_admin  boolean not null default false,  -- never required (client decision, 26 Sep 2026)
  mfa_required_client_admin boolean not null default false,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references people(id) on delete set null
);
insert into security_policy (id) values ('current');

create table audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  company_id uuid references companies(id) on delete set null,
  actor_id   uuid references people(id) on delete set null,
  actor_role app_role,
  actor_email text not null default '',
  action     text not null,
  entity     text not null,
  entity_id  text,
  ip         inet,
  details    jsonb not null default '{}'
);
create index audit_log_at_idx on audit_log (at desc);
create index audit_log_company_idx on audit_log (company_id, at desc);
create index audit_log_action_idx on audit_log (action, at desc);
