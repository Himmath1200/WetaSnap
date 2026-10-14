-- 0002 · Catalogue — what a company sets up before the booth opens: events, the card fields
-- captured at them, tags, the CRM connection, and the notifications that come back.

create type event_status      as enum ('open', 'closed');
create type field_type        as enum ('text', 'email', 'phone', 'link', 'choice', 'longtext');
create type field_filler      as enum ('ai', 'staff');
create type tag_colour        as enum ('green', 'blue', 'amber', 'red', 'purple', 'slate');
create type connector_kind    as enum ('zoho_crm', 'zoho_bigin', 'hubspot', 'salesforce', 'webhook', 'csv');
create type connection_status as enum ('connected', 'error', 'disconnected');
create type connection_mode   as enum ('auto', 'manual');
create type notification_kind as enum ('lead_failed', 'leads_waiting', 'licence_expiring', 'licence_expired',
                                       'event_starting', 'person_invited', 'import_done', 'support_reply', 'subscription');

-- ---------------------------------------------------------------- card-field templates
create table field_templates (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 100),
  description text not null default '' check (length(description) <= 500),
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index field_templates_company_idx on field_templates (company_id);
-- Exactly one default per company.
create unique index field_templates_one_default on field_templates (company_id) where is_default;
create trigger field_templates_touch before update on field_templates for each row execute function touch_updated_at();

create table field_definitions (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  template_id uuid not null references field_templates(id) on delete cascade,
  key         text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label       text not null check (length(btrim(label)) between 1 and 100),
  type        field_type not null default 'text',
  options     text[] not null default '{}',
  required    boolean not null default false,
  ai_hint     text not null default '' check (length(ai_hint) <= 500),
  filled_by   field_filler not null default 'ai',
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (template_id, key)
);
create index field_definitions_template_idx on field_definitions (template_id, sort_order);
create trigger field_definitions_touch before update on field_definitions for each row execute function touch_updated_at();

-- ---------------------------------------------------------------- events
create table events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 200),
  starts_on   date not null,
  ends_on     date not null,
  venue       text not null default '',
  booth       text not null default '',
  status      event_status not null default 'open',
  description text not null default '' check (length(description) <= 2000),
  time_zone   text not null default 'UTC' check (length(time_zone) between 1 and 60),
  template_id uuid references field_templates(id) on delete set null,
  attachments jsonb not null default '[]' check (jsonb_typeof(attachments) = 'array' and pg_column_size(attachments) < 65536),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint events_dates check (ends_on >= starts_on)
);
create index events_company_idx on events (company_id, starts_on desc);
create trigger events_touch before update on events for each row execute function touch_updated_at();

alter table people add constraint people_default_event_fk
  foreign key (default_event_id) references events(id) on delete set null;

-- Which events a person may capture for (the first is their default).
create table person_events (
  person_id  uuid not null references people(id) on delete cascade,
  event_id   uuid not null references events(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (person_id, event_id)
);
create index person_events_event_idx on person_events (event_id);

-- ---------------------------------------------------------------- tags
create table tags (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 40),
  colour     tag_colour not null default 'green',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, name)
);
create trigger tags_touch before update on tags for each row execute function touch_updated_at();

-- ---------------------------------------------------------------- CRM connections
create table connections (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  kind          connector_kind not null check (kind <> 'csv'),
  status        connection_status not null default 'connected',
  record_type   text not null default '',
  mode          connection_mode not null default 'auto',
  mapping       jsonb not null default '{}' check (jsonb_typeof(mapping) = 'object'),
  account_label text not null default '',
  webhook_url   text check (webhook_url is null or webhook_url ~ '^https://[^\s]+$'),
  last_error    text,
  connected_by  uuid references people(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index connections_company_idx on connections (company_id);
create trigger connections_touch before update on connections for each row execute function touch_updated_at();

-- Tokens and signing secrets, encrypted with SECRET_KEY before they ever reach the database.
-- No grant for the app role: only the service connection (the CRM worker) can read them.
create table connection_secrets (
  connection_id uuid primary key references connections(id) on delete cascade,
  ciphertext    text not null,
  provider_meta jsonb not null default '{}',
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------- notifications
create table notifications (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  person_id  uuid references people(id) on delete cascade,   -- null = everyone who should see it
  kind       notification_kind not null,
  title      text not null check (length(btrim(title)) between 1 and 200),
  body       text not null default '' check (length(body) <= 2000),
  link       text check (link is null or link ~ '^/'),
  remind_at  timestamptz,
  dedupe_key text,
  pushed_at  timestamptz,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create unique index notifications_dedupe_idx on notifications (dedupe_key) where dedupe_key is not null;
create index notifications_company_idx on notifications (company_id, created_at desc);
create index notifications_person_idx on notifications (person_id, created_at desc);

-- A company-wide note is read per person.
create table notification_reads (
  notification_id uuid not null references notifications(id) on delete cascade,
  person_id       uuid not null references people(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, person_id)
);

create table push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references people(id) on delete cascade,
  endpoint   text not null unique check (endpoint ~ '^https://'),
  p256dh     text not null,
  auth       text not null,
  device     text not null default '',
  created_at timestamptz not null default now()
);
create index push_subscriptions_person_idx on push_subscriptions (person_id);

-- What each device still has waiting offline (ADM-07).
create table device_status (
  person_id         uuid not null references people(id) on delete cascade,
  device            text not null check (length(device) between 1 and 200),
  company_id        uuid not null references companies(id) on delete cascade,
  waiting           integer not null default 0 check (waiting >= 0),
  oldest_waiting_at timestamptz,
  reported_at       timestamptz not null default now(),
  primary key (person_id, device)
);
create index device_status_company_idx on device_status (company_id);
