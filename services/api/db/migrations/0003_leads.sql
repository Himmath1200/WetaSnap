-- 0003 · Leads, cards and contacts — everything the scanning pipeline writes.
--
--   business_cards  one row per captured image: its quality, its crop, what OCR and the AI read
--   leads           what the booth captured, field by field, with consent and CRM state
--   contacts        the de-duplicated person behind the leads (one per human, per company)
--   notes           free-text notes on a lead or a contact, by whoever wrote them
--   activities      the timeline: scanned, merged, emailed, pushed to the CRM, exported

create type lead_source    as enum ('camera', 'upload', 'manual');
create type lead_status    as enum ('waiting', 'synced', 'in_crm', 'check');
create type interest_level as enum ('hot', 'warm', 'cold');
create type photo_side     as enum ('front', 'back');
create type card_stage     as enum ('captured', 'cropped', 'read', 'extracted', 'failed');
create type job_status     as enum ('pending', 'running', 'done', 'failed');
create type usage_kind     as enum ('scan', 'ai_read', 'crm_push', 'sync', 'storage');
create type usage_metric   as enum ('scans', 'seats', 'storage');
create type activity_kind  as enum ('scanned', 'imported', 'edited', 'merged', 'note', 'tagged',
                                    'crm_push', 'exported', 'emailed', 'called', 'deleted', 'restored');

-- ---------------------------------------------------------------- imports
create table import_batches (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  at         timestamptz not null default now(),
  by         text not null default '' check (length(by) <= 200),
  by_id      uuid references people(id) on delete set null,
  file_name  text not null default '' check (length(file_name) <= 300),
  event_id   uuid not null references events(id) on delete cascade,
  imported   integer not null default 0 check (imported >= 0),
  skipped    integer not null default 0 check (skipped >= 0),
  tag_ids    uuid[] not null default '{}'
);
create index import_batches_company_idx on import_batches (company_id, at desc);

-- ---------------------------------------------------------------- contacts
create table contacts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  full_name     text not null default '',
  first_name    text not null default '',
  last_name     text not null default '',
  job_title     text not null default '',
  org_name      text not null default '',
  org_domain    text not null default '',
  email         text not null default '',
  phone         text not null default '',
  website       text not null default '',
  country       text not null default '',
  address       text not null default '',
  -- Everything ever seen for this person, so a later card with a second address still matches.
  emails        text[] not null default '{}',
  phones        text[] not null default '{}',
  lead_score    integer not null default 0 check (lead_score between 0 and 100),
  times_met     integer not null default 1 check (times_met >= 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  follow_up_at  date,
  merged_into   uuid references contacts(id) on delete set null,   -- set on the losing row of a merge
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index contacts_company_idx on contacts (company_id, last_seen_at desc) where merged_into is null;
create unique index contacts_email_key on contacts (company_id, lower(email))
  where email <> '' and merged_into is null;
create index contacts_emails_idx on contacts using gin (emails);
create index contacts_phones_idx on contacts using gin (phones);
create index contacts_name_trgm on contacts using gin (lower(full_name) gin_trgm_ops);
create index contacts_org_trgm on contacts using gin (lower(org_name) gin_trgm_ops);
create trigger contacts_touch before update on contacts for each row execute function touch_updated_at();

-- ---------------------------------------------------------------- leads
create table leads (
  id              uuid primary key,                      -- made on the device: the idempotency key (SYNC-03)
  company_id      uuid not null references companies(id) on delete cascade,
  event_id        uuid not null references events(id) on delete cascade,
  contact_id      uuid references contacts(id) on delete set null,
  captured_by     uuid not null references people(id) on delete restrict,
  captured_by_name text not null default '',
  device          text not null default '',
  source          lead_source not null default 'manual',
  fields          jsonb not null default '{}'
                  check (jsonb_typeof(fields) = 'object' and pg_column_size(fields) < 65536),
  interest        interest_level,
  notes           text not null default '' check (length(notes) <= 5000),
  consent         boolean not null default false,
  consent_version integer not null default 1,
  consent_at      timestamptz,
  status          lead_status not null default 'synced',
  crm_error       text,
  crm_record_id   text,
  crm_history     jsonb not null default '[]' check (jsonb_typeof(crm_history) = 'array'),
  has_photo       boolean not null default false,
  has_back_photo  boolean not null default false,
  tag_ids         uuid[] not null default '{}',
  import_batch_id uuid references import_batches(id) on delete set null,
  ai_read_at      timestamptz,
  lead_score      integer not null default 0 check (lead_score between 0 and 100),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  synced_at       timestamptz,
  deleted_at      timestamptz,
  deleted_by      uuid references people(id) on delete set null,
  erase_requested_at timestamptz,
  -- Everything typed into the card, flattened once so search stays a single index lookup.
  search_text     text generated always as
                  (lower((jsonb_path_query_array(fields, '$.*."value"'))::text || ' ' || notes)) stored
);
create index leads_company_idx on leads (company_id, created_at desc) where deleted_at is null;
create index leads_event_idx on leads (event_id, created_at desc) where deleted_at is null;
create index leads_captured_by_idx on leads (captured_by, created_at desc) where deleted_at is null;
create index leads_status_idx on leads (company_id, status) where deleted_at is null;
create index leads_tags_idx on leads using gin (tag_ids);
create index leads_search_idx on leads using gin (search_text gin_trgm_ops);
create index leads_contact_idx on leads (contact_id) where contact_id is not null;
create trigger leads_touch before update on leads for each row execute function touch_updated_at();

-- ---------------------------------------------------------------- business cards (the images)
create table business_cards (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  lead_id       uuid references leads(id) on delete cascade,
  contact_id    uuid references contacts(id) on delete set null,
  side          photo_side not null default 'front',
  storage_key   text not null,                 -- object storage: companies/<id>/cards/<lead>/front.jpg
  mime          text not null default 'image/jpeg',
  size_bytes    integer not null default 0 check (size_bytes >= 0),
  width         integer not null default 0,
  height        integer not null default 0,
  stage         card_stage not null default 'captured',
  -- { sharpness, exposure, coverage, glare, verdict: 'good'|'poor', reasons: [] }
  quality       jsonb not null default '{}',
  -- { x, y, w, h, rotation, corners } — what the crop step decided, in the original's pixels
  crop          jsonb not null default '{}',
  ocr_text      text not null default '',
  ocr_engine    text not null default '',
  ocr_confidence real not null default 0,
  ai_model      text not null default '',
  extracted     jsonb not null default '{}',   -- { key: { value, confidence, reason } }
  error         text,
  created_at    timestamptz not null default now(),
  processed_at  timestamptz
);
create index business_cards_lead_idx on business_cards (lead_id, side);
create index business_cards_company_idx on business_cards (company_id, created_at desc);
create unique index business_cards_one_per_side on business_cards (lead_id, side) where lead_id is not null;

-- ---------------------------------------------------------------- notes & activities
create table notes (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  lead_id    uuid references leads(id) on delete cascade,
  contact_id uuid references contacts(id) on delete cascade,
  author_id  uuid references people(id) on delete set null,
  author     text not null default '',
  body       text not null check (length(btrim(body)) between 1 and 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notes_target check (lead_id is not null or contact_id is not null)
);
create index notes_lead_idx on notes (lead_id, created_at desc);
create index notes_contact_idx on notes (contact_id, created_at desc);
create trigger notes_touch before update on notes for each row execute function touch_updated_at();

create table activities (
  id         bigserial primary key,
  company_id uuid not null references companies(id) on delete cascade,
  contact_id uuid references contacts(id) on delete cascade,
  lead_id    uuid references leads(id) on delete cascade,
  person_id  uuid references people(id) on delete set null,
  kind       activity_kind not null,
  summary    text not null default '' check (length(summary) <= 500),
  meta       jsonb not null default '{}',
  at         timestamptz not null default now()
);
create index activities_contact_idx on activities (contact_id, at desc);
create index activities_lead_idx on activities (lead_id, at desc);
create index activities_company_idx on activities (company_id, at desc);

-- ---------------------------------------------------------------- usage
create table usage_events (
  id         bigserial primary key,
  company_id uuid not null references companies(id) on delete cascade,
  person_id  uuid references people(id) on delete set null,
  kind       usage_kind not null,
  quantity   bigint not null default 1,
  lead_id    uuid,
  meta       jsonb not null default '{}',
  at         timestamptz not null default now()
);
create index usage_events_company_idx on usage_events (company_id, at desc);
create index usage_events_month_idx on usage_events (company_id, kind, at);

create table usage_alerts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references companies(id) on delete cascade,   -- null = every company
  metric        usage_metric not null default 'scans',
  threshold_pct integer not null default 80 check (threshold_pct between 1 and 200),
  active        boolean not null default true,
  last_fired_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger usage_alerts_touch before update on usage_alerts for each row execute function touch_updated_at();

-- ---------------------------------------------------------------- background jobs
-- The queue is PostgreSQL by default (durable, and in the same transaction as the data that
-- caused it). With REDIS_URL set the API hands the same jobs to Redis for pickup instead.
create table jobs (
  id         bigserial primary key,
  kind       text not null,
  company_id uuid references companies(id) on delete cascade,
  payload    jsonb not null default '{}',
  status     job_status not null default 'pending',
  attempt    integer not null default 0,
  max_attempts integer not null default 5,
  run_at     timestamptz not null default now(),
  locked_by  text,
  locked_at  timestamptz,
  last_error text,
  dedupe_key text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index jobs_ready_idx on jobs (status, run_at) where status = 'pending';
create unique index jobs_dedupe_idx on jobs (dedupe_key) where dedupe_key is not null and status <> 'done';

-- ---------------------------------------------------------------- semantic search (pgvector)
-- Optional: without the extension the column is a plain float array and search falls back to
-- trigram matching on the name, company and e-mail, which is what most searches hit anyway.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'vector') then
    execute $ddl$
      create table contact_embeddings (
        contact_id uuid primary key references contacts(id) on delete cascade,
        model      text not null,
        embedding  vector(256) not null,
        updated_at timestamptz not null default now()
      )$ddl$;
    execute 'create index contact_embeddings_ann on contact_embeddings using hnsw (embedding vector_cosine_ops)';
  else
    execute $ddl$
      create table contact_embeddings (
        contact_id uuid primary key references contacts(id) on delete cascade,
        model      text not null,
        embedding  double precision[] not null,
        updated_at timestamptz not null default now()
      )$ddl$;
    raise notice 'pgvector is not installed: semantic contact search falls back to trigram matching.';
  end if;
end $$;
