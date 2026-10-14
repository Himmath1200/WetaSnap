-- 0006 · Row-level security and grants.
--
-- The API opens two pools. Anything a signed-in person asks for runs on `wetasnap_app`, inside a
-- transaction that first sets app.person_id / app.company_id / app.role. These policies then decide
-- what that statement may touch, so a missing WHERE in one query can never reach another company's
-- rows. Sign-in, background jobs and migrations run on `wetasnap_service`, which owns the tables and
-- is therefore not subject to the policies (PostgreSQL exempts the owner unless FORCE is set).
--
-- Tables with no grant at all for wetasnap_app: person_credentials, password_history,
-- password_codes, login_codes, recovery_codes, connection_secrets, jobs and document_numbers.
-- Those are only ever touched by the service connection.

-- ---------------------------------------------------------------- base grants
grant usage on schema public to wetasnap_app;
grant select, insert, update, delete on
  companies, licences, licence_history, people, person_events, device_sessions, login_events,
  security_policy, audit_log, field_templates, field_definitions, events, tags, connections,
  notifications, notification_reads, push_subscriptions, device_status, import_batches, contacts,
  leads, business_cards, notes, activities, usage_events, usage_alerts, contact_embeddings,
  plans, subscriptions, invoices, support_tickets, support_messages, company_suspensions
  to wetasnap_app;
grant usage, select on all sequences in schema public to wetasnap_app;
grant execute on all functions in schema public to wetasnap_app;

alter table companies            enable row level security;
alter table licences             enable row level security;
alter table licence_history      enable row level security;
alter table people               enable row level security;
alter table person_events        enable row level security;
alter table device_sessions      enable row level security;
alter table login_events         enable row level security;
alter table security_policy      enable row level security;
alter table audit_log            enable row level security;
alter table field_templates      enable row level security;
alter table field_definitions    enable row level security;
alter table events               enable row level security;
alter table tags                 enable row level security;
alter table connections          enable row level security;
alter table notifications        enable row level security;
alter table notification_reads   enable row level security;
alter table push_subscriptions   enable row level security;
alter table device_status        enable row level security;
alter table import_batches       enable row level security;
alter table contacts             enable row level security;
alter table leads                enable row level security;
alter table business_cards       enable row level security;
alter table notes                enable row level security;
alter table activities           enable row level security;
alter table usage_events         enable row level security;
alter table usage_alerts         enable row level security;
alter table contact_embeddings   enable row level security;
alter table plans                enable row level security;
alter table subscriptions        enable row level security;
alter table invoices             enable row level security;
alter table support_tickets      enable row level security;
alter table support_messages     enable row level security;
alter table company_suspensions  enable row level security;

-- ---------------------------------------------------------------- who am I
-- "My company" is the one on my people row; WeTano accounts see every company.
create or replace function same_company(p_company_id uuid) returns boolean
language sql stable as $$ select is_super_admin() or (p_company_id is not null and p_company_id = app_company_id()) $$;

-- LEAD-03: staff see the leads they captured; admins see the company's.
create or replace function may_see_lead(p_company_id uuid, p_captured_by uuid) returns boolean
language sql stable as $$
  select is_super_admin()
      or (p_company_id = app_company_id() and (is_admin() or p_captured_by = app_person_id()))
$$;

-- ---------------------------------------------------------------- tenants
create policy companies_read on companies for select using (same_company(id));
create policy companies_write on companies for update using (
  is_super_admin() or (id = app_company_id() and app_role() = 'client_admin'));
create policy companies_insert on companies for insert with check (is_super_admin());
create policy companies_delete on companies for delete using (is_super_admin());

create policy suspensions_read on company_suspensions for select using (same_company(company_id));
create policy suspensions_write on company_suspensions for all using (is_super_admin()) with check (is_super_admin());

create policy licences_read on licences for select using (same_company(company_id));
create policy licences_write on licences for all using (is_super_admin()) with check (is_super_admin());
create policy licence_history_read on licence_history for select using (same_company(company_id));
create policy licence_history_write on licence_history for insert with check (is_super_admin());

-- ---------------------------------------------------------------- people
create policy people_read on people for select using (
  is_super_admin() or company_id = app_company_id() or id = app_person_id());
create policy people_insert on people for insert with check (
  is_super_admin() or (company_id = app_company_id() and app_role() = 'client_admin'));
create policy people_update on people for update using (
  is_super_admin() or id = app_person_id()
  or (company_id = app_company_id() and app_role() = 'client_admin'));
create policy people_delete on people for delete using (is_super_admin());

create policy person_events_read on person_events for select using (same_company(company_id));
create policy person_events_write on person_events for all
  using (is_super_admin() or (company_id = app_company_id() and app_role() = 'client_admin'))
  with check (is_super_admin() or (company_id = app_company_id() and app_role() = 'client_admin'));

-- Your own devices and your own sign-in history; an admin may read their team's history.
create policy sessions_own on device_sessions for select using (person_id = app_person_id());
create policy sessions_revoke on device_sessions for update using (person_id = app_person_id());
create policy login_events_read on login_events for select using (
  person_id = app_person_id() or is_super_admin()
  or (app_role() = 'client_admin' and exists (
        select 1 from people p where p.id = login_events.person_id and p.company_id = app_company_id())));

create policy security_policy_read on security_policy for select using (true);
create policy security_policy_write on security_policy for update using (is_super_admin()) with check (is_super_admin());

create policy audit_read on audit_log for select using (is_super_admin());
create policy audit_insert on audit_log for insert with check (true);   -- everyone writes their own trail

-- ---------------------------------------------------------------- catalogue
create policy templates_read on field_templates for select using (same_company(company_id));
create policy templates_write on field_templates for all
  using (same_company(company_id) and is_admin()) with check (same_company(company_id) and is_admin());

create policy fields_read on field_definitions for select using (same_company(company_id));
create policy fields_write on field_definitions for all
  using (same_company(company_id) and is_admin()) with check (same_company(company_id) and is_admin());

create policy events_read on events for select using (same_company(company_id));
create policy events_write on events for all
  using (same_company(company_id) and is_admin()) with check (same_company(company_id) and is_admin());

create policy tags_read on tags for select using (same_company(company_id));
create policy tags_write on tags for all
  using (same_company(company_id) and is_admin()) with check (same_company(company_id) and is_admin());

create policy connections_read on connections for select using (same_company(company_id));
create policy connections_write on connections for all
  using (same_company(company_id) and is_admin()) with check (same_company(company_id) and is_admin());

create policy imports_read on import_batches for select using (same_company(company_id));
create policy imports_write on import_batches for all
  using (same_company(company_id) and is_admin()) with check (same_company(company_id) and is_admin());

create policy device_status_read on device_status for select using (same_company(company_id) and is_admin());
create policy device_status_write on device_status for all
  using (person_id = app_person_id()) with check (person_id = app_person_id());

-- ---------------------------------------------------------------- notifications
create policy notifications_read on notifications for select using (
  same_company(company_id) and (person_id is null or person_id = app_person_id()));
create policy notifications_update on notifications for update using (
  same_company(company_id) and (person_id is null or person_id = app_person_id()));
create policy notification_reads_own on notification_reads for all
  using (person_id = app_person_id()) with check (person_id = app_person_id());
create policy push_own on push_subscriptions for all
  using (person_id = app_person_id()) with check (person_id = app_person_id());

-- ---------------------------------------------------------------- leads and what hangs off them
create policy leads_read on leads for select using (may_see_lead(company_id, captured_by));
create policy leads_insert on leads for insert with check (
  company_id = app_company_id() and (is_admin() or captured_by = app_person_id()));
create policy leads_update on leads for update using (may_see_lead(company_id, captured_by));
create policy leads_delete on leads for delete using (is_super_admin());

create policy cards_read on business_cards for select using (
  same_company(company_id) and (
    lead_id is null or exists (select 1 from leads l where l.id = business_cards.lead_id)));
create policy cards_write on business_cards for all
  using (same_company(company_id)) with check (same_company(company_id));

-- A contact is the company's, but staff only meet the ones behind their own leads.
create policy contacts_read on contacts for select using (
  same_company(company_id) and (is_admin() or exists (
    select 1 from leads l where l.contact_id = contacts.id and l.captured_by = app_person_id())));
create policy contacts_write on contacts for all
  using (same_company(company_id)) with check (same_company(company_id));
create policy contact_embeddings_rw on contact_embeddings for all
  using (exists (select 1 from contacts c where c.id = contact_embeddings.contact_id))
  with check (exists (select 1 from contacts c where c.id = contact_embeddings.contact_id));

create policy notes_read on notes for select using (
  same_company(company_id) and (
    lead_id is null or exists (select 1 from leads l where l.id = notes.lead_id)));
create policy notes_write on notes for all
  using (same_company(company_id) and (author_id = app_person_id() or is_admin()))
  with check (same_company(company_id));

create policy activities_read on activities for select using (
  same_company(company_id) and (
    lead_id is null or exists (select 1 from leads l where l.id = activities.lead_id)));
create policy activities_write on activities for insert with check (same_company(company_id));

-- ---------------------------------------------------------------- usage, billing, support
create policy usage_events_read on usage_events for select using (same_company(company_id) and is_admin());
create policy usage_events_insert on usage_events for insert with check (company_id = app_company_id());
create policy usage_alerts_rw on usage_alerts for all using (is_super_admin()) with check (is_super_admin());

create policy plans_read on plans for select using (true);          -- the price list is not a secret
create policy plans_write on plans for all using (is_super_admin()) with check (is_super_admin());

create policy subscriptions_read on subscriptions for select using (same_company(company_id) and is_admin());
create policy subscriptions_write on subscriptions for all using (is_super_admin()) with check (is_super_admin());

-- Clients may read and download their own invoices; only WeTano may write them.
create policy invoices_read on invoices for select using (same_company(company_id) and is_admin());
create policy invoices_write on invoices for all using (is_super_admin()) with check (is_super_admin());

create policy tickets_read on support_tickets for select using (same_company(company_id) and is_admin());
create policy tickets_insert on support_tickets for insert with check (
  company_id = app_company_id() and is_admin());
create policy tickets_update on support_tickets for update using (
  is_super_admin() or (company_id = app_company_id() and is_admin()));
create policy ticket_messages_read on support_messages for select using (
  exists (select 1 from support_tickets t where t.id = support_messages.ticket_id));
create policy ticket_messages_insert on support_messages for insert with check (
  exists (select 1 from support_tickets t where t.id = support_messages.ticket_id));
