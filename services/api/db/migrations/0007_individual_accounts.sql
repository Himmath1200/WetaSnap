-- 0007 · Individual Accounts, Free/Pro Tiers and Solo Scanners.

-- 1. Add 'individual' to app_role enum if not already present
alter type app_role add value if not exists 'individual';

-- 2. Allow nullable company_id for individual accounts in people and leads
alter table people alter column company_id drop not null;
alter table leads alter column company_id drop not null;

-- 3. Add individual plan and quota tracking columns to people
alter table people add column if not exists plan text not null default 'free' check (plan in ('free', 'pro'));
alter table people add column if not exists monthly_scans integer not null default 0 check (monthly_scans >= 0);
alter table people add column if not exists scans_reset_at timestamptz not null default (now() + interval '30 days');

-- 4. Create individual pricing configuration table
create table if not exists individual_pricing (
  id                uuid primary key default gen_random_uuid(),
  free_scans_limit  integer not null default 5 check (free_scans_limit >= 1),
  pro_price_month   integer not null default 100 check (pro_price_month >= 1),
  pro_price_year    integer not null default 1150 check (pro_price_year >= 1),
  currency          text not null default 'USD' check (length(currency) = 3),
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

-- Seed default individual pricing config if empty
insert into individual_pricing (free_scans_limit, pro_price_month, pro_price_year, currency)
select 5, 100, 1150, 'USD'
where not exists (select 1 from individual_pricing);

-- 5. Row-level security for individual pricing and individual accounts
alter table individual_pricing enable row level security;

create policy individual_pricing_read on individual_pricing
  for select using (true);

create policy individual_pricing_write on individual_pricing
  for all using (is_super_admin()) with check (is_super_admin());

-- Update leads policy to allow individuals to see and manage only their own leads
create or replace function may_see_lead(p_company_id uuid, p_captured_by uuid) returns boolean
language sql stable as $$
  select is_super_admin()
      or (p_company_id is not null and p_company_id = app_company_id() and (is_admin() or p_captured_by = app_person_id()))
      or (p_company_id is null and p_captured_by = app_person_id())
$$;

-- Allow wetasnap_app to access individual_pricing
grant select on individual_pricing to wetasnap_app;
grant insert, update, delete on individual_pricing to wetasnap_app;
