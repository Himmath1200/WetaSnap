-- 0004 · Billing and support — what WeTano runs the business on.

create type billing_cycle   as enum ('monthly', 'annual');
create type invoice_status  as enum ('draft', 'sent', 'paid', 'overdue', 'cancelled');
create type ticket_status   as enum ('open', 'waiting', 'resolved', 'closed');
create type ticket_priority as enum ('low', 'normal', 'high', 'urgent');

create table plans (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (length(btrim(name)) between 1 and 80),
  description        text not null default '' check (length(description) <= 500),
  price_month        bigint not null default 0 check (price_month >= 0),   -- minor units
  price_year         bigint not null default 0 check (price_year >= 0),
  currency           text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  seats              integer not null default 1 check (seats between 1 and 10000),
  scans_per_month    integer not null default 0 check (scans_per_month >= 0),
  connectors_allowed text[] not null default '{webhook,csv}',
  features           text[] not null default '{}',
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger plans_touch before update on plans for each row execute function touch_updated_at();

create table subscriptions (
  company_id    uuid primary key references companies(id) on delete cascade,
  plan_id       uuid references plans(id) on delete set null,
  billing_cycle billing_cycle not null default 'monthly',
  renews_on     date not null default (current_date + 30),
  auto_renew    boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger subscriptions_touch before update on subscriptions for each row execute function touch_updated_at();

create table invoices (
  id           uuid primary key default gen_random_uuid(),
  number       text not null unique,
  company_id   uuid not null references companies(id) on delete cascade,
  plan_id      uuid references plans(id) on delete set null,
  -- Kept as text as well: a deleted or renamed plan must not change an issued invoice.
  plan_name    text not null default '',
  period_start date not null,
  period_end   date not null,
  amount       bigint not null default 0 check (amount >= 0),
  tax          bigint not null default 0 check (tax >= 0),
  currency     text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  status       invoice_status not null default 'draft',
  issued_on    date not null default current_date,
  due_on       date not null,
  paid_on      date,
  paid_by      text not null default '' check (length(paid_by) <= 200),
  notes        text not null default '' check (length(notes) <= 2000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint invoices_period check (period_end >= period_start)
);
create index invoices_company_idx on invoices (company_id, issued_on desc);
create index invoices_status_idx on invoices (status, due_on);
create trigger invoices_touch before update on invoices for each row execute function touch_updated_at();

-- D-29: a paid invoice is final.
create or replace function invoices_paid_is_final() returns trigger
language plpgsql as $$
begin
  if old.status = 'paid' and (new.amount <> old.amount or new.tax <> old.tax
     or new.currency <> old.currency or new.period_start <> old.period_start
     or new.period_end <> old.period_end or new.number <> old.number) then
    raise exception 'A paid invoice cannot be changed. Cancel it and issue a new one.';
  end if;
  return new;
end $$;
create trigger invoices_final before update on invoices for each row execute function invoices_paid_is_final();

-- Document numbers: SUP-2026-10001, INV-2026-10001 — never reused, never truncated (D-14).
create table document_numbers (
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

-- ---------------------------------------------------------------- support
create table support_tickets (
  id          uuid primary key default gen_random_uuid(),
  number      text not null unique,
  company_id  uuid not null references companies(id) on delete cascade,
  opened_by   text not null default '',
  subject     text not null check (length(btrim(subject)) between 1 and 200),
  body        text not null default '' check (length(body) <= 5000),
  status      ticket_status not null default 'open',
  priority    ticket_priority not null default 'normal',
  assigned_to text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index support_tickets_company_idx on support_tickets (company_id, created_at desc);
create index support_tickets_status_idx on support_tickets (status, updated_at desc);
create trigger support_tickets_touch before update on support_tickets for each row execute function touch_updated_at();

create table support_messages (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid not null references support_tickets(id) on delete cascade,
  author      text not null default '',
  from_wetano boolean not null default false,
  body        text not null check (length(btrim(body)) between 1 and 5000),
  at          timestamptz not null default now()
);
create index support_messages_ticket_idx on support_messages (ticket_id, at);
