-- 0005 · Rules that must hold whatever the API does — seats, licences, consent, the last admin.
-- These are the invariants it would be dangerous to leave to one code path.

-- ---------------------------------------------------------------- licences and seats
-- A seat is taken by anyone who can still sign in (ADM-02).
create or replace function holds_seat(p people) returns boolean
language sql immutable as $$
  select p.active and (p.access_ends_on is null or p.access_ends_on >= current_date)
$$;

create or replace function seats_used(p_company_id uuid) returns integer
language sql stable as $$
  select count(*)::integer from people p
   where p.company_id = p_company_id and holds_seat(p)
$$;

create or replace function company_suspended(p_company_id uuid) returns boolean
language sql stable as $$
  select coalesce((select c.suspended from companies c where c.id = p_company_id), false)
$$;

-- active | trial | expires_soon | grace | read_only (LIC-02/03)
create or replace function licence_status(p_company_id uuid) returns text
language sql stable as $$
  select case
           when l.id is null then 'read_only'
           when current_date > l.ends_on + 14 then 'read_only'
           when current_date > l.ends_on then 'grace'
           when l.ends_on - current_date <= 14 then 'expires_soon'
           when l.type = 'trial' then 'trial'
           else 'active'
         end
    from licences l where l.company_id = p_company_id
$$;

create or replace function scans_this_month(p_company_id uuid) returns bigint
language sql stable as $$
  select coalesce(sum(u.quantity), 0)::bigint from usage_events u
   where u.company_id = p_company_id and u.kind = 'scan'
     and u.at >= date_trunc('month', now())
$$;

-- ADM-02: never more people than seats, whatever path created the row.
create or replace function people_seat_guard() returns trigger
language plpgsql as $$
declare
  v_seats integer;
  v_used  integer;
begin
  if new.company_id is null then return new; end if;
  if tg_op = 'UPDATE' and holds_seat(old) then return new; end if;   -- already counted
  if not holds_seat(new) then return new; end if;
  select l.seats into v_seats from licences l where l.company_id = new.company_id;
  if v_seats is null then return new; end if;
  select count(*)::integer into v_used from people p
   where p.company_id = new.company_id and p.id <> new.id and holds_seat(p);
  if v_used >= v_seats then
    raise exception 'All % seats are in use. Deactivate someone or ask WeTano for more seats.', v_seats
      using errcode = 'check_violation', hint = 'seats_exhausted';
  end if;
  return new;
end $$;
create trigger people_seats before insert or update on people
  for each row execute function people_seat_guard();

-- D-18: a company must keep one admin who can still sign in.
create or replace function people_last_admin_guard() returns trigger
language plpgsql as $$
declare
  v_others integer;
begin
  if old.company_id is null or old.role <> 'client_admin' or not holds_seat(old) then return new; end if;
  if new.role = 'client_admin' and holds_seat(new) then return new; end if;
  select count(*)::integer into v_others from people p
   where p.company_id = old.company_id and p.id <> old.id
     and p.role = 'client_admin' and holds_seat(p);
  if v_others = 0 then
    raise exception 'This is the last active admin of the company. Make someone else an admin first.'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger people_last_admin before update on people
  for each row execute function people_last_admin_guard();

-- ---------------------------------------------------------------- consent (ADM-05)
-- Changing the consent wording starts a new version; leads keep the version they agreed to.
create or replace function companies_consent_version() returns trigger
language plpgsql as $$
begin
  if new.consent_text is distinct from old.consent_text then
    new.consent_version := old.consent_version + 1;
  end if;
  return new;
end $$;
create trigger companies_consent before update on companies
  for each row execute function companies_consent_version();

-- Suspending a company records when, so devices can still sync what they captured before (W5).
create or replace function companies_suspension_mark() returns trigger
language plpgsql as $$
begin
  if new.suspended and not old.suspended then
    insert into company_suspensions (company_id, suspended_at) values (new.id, now())
      on conflict (company_id) do update set suspended_at = now();
  elsif old.suspended and not new.suspended then
    delete from company_suspensions where company_id = new.id;
  end if;
  return new;
end $$;
create trigger companies_suspension after update on companies
  for each row execute function companies_suspension_mark();

-- ---------------------------------------------------------------- plans (SUB-01)
-- A plan may only go when nothing points at it: a live subscription would lose its plan and an
-- issued invoice would lose the name it was billed under. In use = hide it (active = false).
create or replace function plans_delete_guard() returns trigger
language plpgsql as $$
declare
  v_subs integer;
  v_invoices integer;
begin
  select count(*)::integer into v_subs from subscriptions s where s.plan_id = old.id;
  select count(*)::integer into v_invoices from invoices i where i.plan_id = old.id;
  if v_subs > 0 then
    raise exception 'Cannot delete %: % % on this plan. Move them to another plan first, or hide it instead.',
      old.name, v_subs, case when v_subs = 1 then 'company is' else 'companies are' end
      using errcode = 'foreign_key_violation';
  end if;
  if v_invoices > 0 then
    raise exception 'Cannot delete %: % % billed on this plan and would lose it. Hide the plan instead.',
      old.name, v_invoices, case when v_invoices = 1 then 'invoice was' else 'invoices were' end
      using errcode = 'foreign_key_violation';
  end if;
  return old;
end $$;
create trigger plans_delete before delete on plans for each row execute function plans_delete_guard();

-- ---------------------------------------------------------------- leads
-- A lead cannot be captured for an event of another company, or by someone outside it.
create or replace function leads_tenancy_guard() returns trigger
language plpgsql as $$
declare
  v_event_company uuid;
  v_person_company uuid;
begin
  select e.company_id into v_event_company from events e where e.id = new.event_id;
  select p.company_id into v_person_company from people p where p.id = new.captured_by;
  if v_event_company is null or v_event_company <> new.company_id then
    raise exception 'That event belongs to another company.' using errcode = 'check_violation';
  end if;
  if v_person_company is distinct from new.company_id then
    raise exception 'That person cannot capture for this company.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger leads_tenancy before insert or update of event_id, captured_by, company_id on leads
  for each row execute function leads_tenancy_guard();

-- Every lead that lands leaves a trace, whoever wrote it.
create or replace function leads_activity_trail() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into activities (company_id, lead_id, contact_id, person_id, kind, summary)
    values (new.company_id, new.id, new.contact_id, new.captured_by,
            (case when new.import_batch_id is not null then 'imported' else 'scanned' end)::activity_kind,
            case when new.import_batch_id is not null then 'Imported from a file' else 'Captured at the booth' end);
  elsif new.deleted_at is not null and old.deleted_at is null then
    insert into activities (company_id, lead_id, contact_id, person_id, kind, summary)
    values (new.company_id, new.id, new.contact_id, new.deleted_by, 'deleted', 'Lead deleted');
  elsif new.deleted_at is null and old.deleted_at is not null then
    insert into activities (company_id, lead_id, contact_id, person_id, kind, summary)
    values (new.company_id, new.id, new.contact_id, app_person_id(), 'restored', 'Lead restored');
  end if;
  return null;
end $$;
create trigger leads_trail after insert or update of deleted_at on leads
  for each row execute function leads_activity_trail();
