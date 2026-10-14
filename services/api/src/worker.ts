/**
 * The background worker: everything that must happen but that nobody is waiting for.
 *
 *   card.read          re-read a stored card with the full pipeline (OCR + AI) and fill the gaps
 *   contact.link       duplicate check → merge or create → lead score → follow-up
 *   contact.embed      refresh the semantic-search vector
 *   crm.push           send a lead onwards, with retries that widen
 *   notification.push  deliver a notification to the browsers that asked for it
 *   usage.alerts       the thresholds WeTano set (D-16)
 *   retention.sweep    delete what is past its retention, nightly (§8.3)
 *   licence.reminders  tell a company before its licence runs out (LIC-04)
 *
 * Run it beside the API (`npm run worker`) or as its own process; several may run at once, because
 * jobs are claimed with `for update skip locked`.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { hostname } from 'node:os';
import { AppModule } from './app.module';
import { CacheService } from './common/cache.service';
import { DbService } from './common/db.service';
import { loadEnv } from './common/env';
import { QueueService, type Job } from './common/queue.service';
import { StorageService } from './common/storage.service';
import { sendPush, vapidConfigured } from './common/webpush';
import { ContactsService } from './modules/contacts/contacts.service';
import { NotificationsService } from './modules/notifications/notifications.service';
import { PipelineService } from './modules/scan/pipeline.service';
import { pushLead } from './modules/settings/crm';
import { measure } from './modules/scan/pipeline/quality';
import { mergeReads, readWithClaude, readWithOcr } from './modules/scan/pipeline/readers';
import { normaliseFields } from './modules/scan/pipeline/normalise';

const log = new Logger('Worker');
const WORKER = `${hostname()}:${process.pid}`;
const IDLE_MS = 2_000;

async function main() {
  loadEnv();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const db = app.get(DbService);
  const queue = app.get(QueueService);
  const cache = app.get(CacheService);
  const storage = app.get(StorageService);
  const contacts = app.get(ContactsService);
  const notifications = app.get(NotificationsService);

  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  log.log(`worker ${WORKER} started`);
  // The timed work does not need a scheduler: a job re-queues itself for the next run.
  await queue.add('retention.sweep', {}, { dedupeKey: 'retention.sweep', runAt: nextNight() });
  await queue.add('licence.reminders', {}, { dedupeKey: 'licence.reminders', runAt: nextNight() });

  while (!stopping) {
    // The loop itself must survive anything — a database restart, a migration running underneath
    // it — because nobody is watching this process. Only `stopping` ends it.
    try {
      const jobs = await queue.claim(WORKER, 5);
      if (!jobs.length) {
        await sleep(IDLE_MS);
        await queue.requeueStuck();
        continue;
      }
      for (const job of jobs) {
        try {
          await run(job);
          await queue.finish(job.id);
        } catch (e) {
          await queue.fail(job, e);
        }
      }
    } catch (e) {
      log.warn(`could not reach the queue: ${(e as Error).message}`);
      await sleep(5_000);
    }
  }

  log.log('worker stopping');
  await app.close();

  // ---------------------------------------------------------------- handlers
  async function run(job: Job): Promise<void> {
    switch (job.kind) {
      case 'card.read': return reRead(job);
      case 'contact.link': return link(job);
      case 'contact.embed': return embed(job);
      case 'crm.push': return crmPush(job);
      case 'notification.push': return push(job);
      case 'usage.alerts': return usageAlerts(job);
      case 'retention.sweep': return retention();
      case 'licence.reminders': return licenceReminders();
      default: log.warn(`unknown job kind: ${job.kind}`);
    }
  }

  /**
   * The device read the card on its own while the person waited; this reads the stored image
   * again with everything available and fills what is still empty. AI-04: a value a person typed
   * is never overwritten.
   */
  async function reRead(job: Job): Promise<void> {
    const leadId = String(job.payload.lead_id ?? '');
    const card = await db.one<{ id: string; storage_key: string; company_id: string }>(
      `select id, storage_key, company_id from business_cards where lead_id = $1 and side = 'front'`, [leadId]);
    const lead = await db.one<{ fields: Record<string, { value: string; by: string; confidence?: number }>; event_id: string; company_id: string }>(
      `select fields, event_id, company_id from leads where id = $1 and deleted_at is null`, [leadId]);
    if (!card || !lead) return;

    const image = await storage.get(card.storage_key);
    if (!image) return;

    const fields = await db.query<{ key: string; label: string; type: string; options: string[]; ai_hint: string; required: boolean }>(
      `select key, label, type::text as type, options, ai_hint, required
         from field_definitions
        where template_id = coalesce((select template_id from events where id = $1),
                                     (select id from field_templates where company_id = $2 and is_default limit 1))`,
      [lead.event_id, lead.company_id]);
    const cloudOk = await db.one<{ cloud_ai_enabled: boolean }>(
      'select cloud_ai_enabled from companies where id = $1', [lead.company_id]);

    const [ocr, ai] = await Promise.all([
      readWithOcr(image, 'image/jpeg', fields),
      cloudOk?.cloud_ai_enabled ? readWithClaude(image, 'image/jpeg', fields) : Promise.resolve(null),
    ]);
    if (!ocr && !ai) return;

    const read = normaliseFields(mergeReads(ocr, ai), fields);
    const merged = { ...lead.fields };
    let changed = false;
    for (const [key, value] of Object.entries(read)) {
      const current = merged[key];
      if (current?.by === 'person' && current.value) continue;        // AI-04
      if (!current?.value || (value.confidence ?? 0) > (current.confidence ?? 0) + 0.1) {
        merged[key] = { value: value.value, by: 'ai', confidence: value.confidence ?? 0.7, ...(value.reason ? { reason: value.reason } : {}) };
        changed = true;
      }
    }
    const quality = await measure(image);
    await db.tx(async (c) => {
      if (changed) await c.query('update leads set fields = $2, ai_read_at = now() where id = $1', [leadId, merged]);
      await c.query(
        `update business_cards set stage = 'extracted', extracted = $2, ocr_engine = $3, ai_model = $4,
                quality = $5, processed_at = now() where id = $1`,
        [card.id, read, ocr?.engine ?? '', ai?.engine ?? '', JSON.stringify(quality)]);
    });
    if (changed) await queue.add('contact.link', { lead_id: leadId }, { companyId: lead.company_id });
  }

  async function link(job: Job): Promise<void> {
    const leadId = job.payload.lead_id ? String(job.payload.lead_id) : null;
    if (leadId) {
      await contacts.linkLead(leadId);
      return;
    }
    // A whole import: link every lead in the batch.
    const batchId = String(job.payload.batch_id ?? '');
    const leads = await db.query<{ id: string }>(
      'select id from leads where import_batch_id = $1 and contact_id is null and deleted_at is null limit 5000', [batchId]);
    for (const lead of leads) await contacts.linkLead(lead.id);
  }

  async function embed(job: Job): Promise<void> {
    await contacts.refreshEmbedding(String(job.payload.contact_id ?? ''));
  }

  async function crmPush(job: Job): Promise<void> {
    const leadId = String(job.payload.lead_id ?? '');
    const lead = await db.one<{
      id: string; company_id: string; fields: Record<string, { value?: string }>; notes: string;
      interest: string | null; created_at: string; captured_by_name: string; status: string; event_name: string;
    }>(
      `select l.id, l.company_id, l.fields, l.notes, l.interest::text as interest, l.created_at,
              l.captured_by_name, l.status::text as status, coalesce(e.name, '') as event_name
         from leads l left join events e on e.id = l.event_id
        where l.id = $1 and l.deleted_at is null`, [leadId]);
    if (!lead || (lead.status === 'in_crm' && !job.payload.force)) return;

    const connection = await db.one<{ id: string; mode: string }>(
      `select id, mode::text as mode from connections
        where company_id = $1 and status <> 'disconnected' order by created_at limit 1`, [lead.company_id]);
    if (!connection) return;                               // nothing connected: the CSV export is the path
    if (connection.mode === 'manual' && !job.payload.force) return;

    const tags = await db.query<{ name: string }>(
      `select t.name from tags t where t.id = any((select tag_ids from leads where id = $1))`, [leadId]);
    const outcome = await pushLead(db, connection.id, { ...lead, tags: tags.map((t) => t.name) });

    await db.tx(async (c) => {
      await c.query(
        `update leads set status = $2::lead_status, crm_error = $3, crm_record_id = coalesce($4, crm_record_id),
                crm_history = (crm_history || jsonb_build_array(jsonb_build_object(
                  'at', now(), 'ok', $5::boolean, 'message', $3::text)))
          where id = $1`,
        [leadId, outcome.ok ? 'in_crm' : 'check', outcome.message, outcome.recordId ?? null, outcome.ok]);
      await c.query(
        `insert into usage_events (company_id, kind, lead_id, meta) values ($1, 'crm_push', $2, $3)`,
        [lead.company_id, leadId, { ok: outcome.ok }]);
      if (outcome.ok) {
        await c.query(
          `insert into activities (company_id, lead_id, kind, summary) values ($1, $2, 'crm_push', 'Sent to the CRM')`,
          [lead.company_id, leadId]);
      }
    });

    if (!outcome.ok) {
      await notifications.notify({
        companyId: lead.company_id, kind: 'lead_failed', title: 'A lead needs a check',
        body: outcome.message, link: '/leads?status=check', dedupeKey: `lead_failed:${leadId}`,
      });
      throw new Error(outcome.message);                    // let the queue retry with a wider gap
    }
  }

  async function push(job: Job): Promise<void> {
    if (!vapidConfigured()) return;
    const notification = await db.one<{ id: string; title: string; body: string; link: string | null; company_id: string | null; person_id: string | null }>(
      'select id, title, body, link, company_id, person_id from notifications where id = $1 and pushed_at is null',
      [String(job.payload.notification_id ?? '')]);
    if (!notification) return;

    const targets = await db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      `select s.id, s.endpoint, s.p256dh, s.auth
         from push_subscriptions s join people p on p.id = s.person_id
        where p.active and (($1::uuid is not null and p.id = $1)
                        or ($1::uuid is null and p.company_id = $2 and p.role = 'client_admin'))`,
      [notification.person_id, notification.company_id]);

    for (const target of targets) {
      const outcome = await sendPush(target, JSON.stringify({
        title: notification.title, body: notification.body, link: notification.link,
      }));
      if (outcome.gone) await db.query('delete from push_subscriptions where id = $1', [target.id]);
    }
    await db.query('update notifications set pushed_at = now() where id = $1', [notification.id]);
  }

  /** D-16: tell WeTano and the company when a threshold is crossed, once per month per alert. */
  async function usageAlerts(_job: Job): Promise<void> {
    const alerts = await db.query<{ id: string; company_id: string | null; metric: string; threshold_pct: number }>(
      `select id, company_id, metric::text as metric, threshold_pct from usage_alerts
        where active and (last_fired_at is null or last_fired_at < date_trunc('month', now()))`);
    for (const alert of alerts) {
      const rows = await db.query<{ id: string; name: string; used: string; allowed: number }>(
        `select c.id, c.name,
                case when $2 = 'seats' then seats_used(c.id)::text else scans_this_month(c.id)::text end as used,
                case when $2 = 'seats' then coalesce(l.seats, 0) else coalesce(l.scans_per_month, 0) end as allowed
           from companies c left join licences l on l.company_id = c.id
          where ($1::uuid is null or c.id = $1) and not c.suspended`,
        [alert.company_id, alert.metric]);
      let fired = false;
      for (const row of rows) {
        if (row.allowed <= 0) continue;
        const percent = Math.round((Number(row.used) / row.allowed) * 100);
        if (percent < alert.threshold_pct) continue;
        fired = true;
        const title = `${row.name}: ${percent}% of its ${alert.metric === 'seats' ? 'seats' : 'monthly scans'} used`;
        await notifications.notify({
          companyId: null, kind: 'subscription', title, link: '/super-admin/usage',
          dedupeKey: `usage:${alert.id}:${row.id}:${new Date().toISOString().slice(0, 7)}`,
        });
        await notifications.notify({
          companyId: row.id, kind: 'subscription',
          title: `${percent}% of this month's ${alert.metric === 'seats' ? 'seats' : 'scans'} are used`,
          link: '/settings?tab=billing',
          dedupeKey: `usage:company:${alert.id}:${row.id}:${new Date().toISOString().slice(0, 7)}`,
        });
      }
      if (fired) await db.query('update usage_alerts set last_fired_at = now() where id = $1', [alert.id]);
    }
  }

  /** §8.3: leads and photos only live as long as the company said they should. */
  async function retention(): Promise<void> {
    const photos = await db.query<{ id: string; storage_key: string }>(
      `select bc.id, bc.storage_key from business_cards bc
         join companies c on c.id = bc.company_id
        where bc.created_at < now() - make_interval(months => c.retention_photos_months)
        limit 500`);
    for (const photo of photos) {
      await storage.delete(photo.storage_key);
      await db.query('delete from business_cards where id = $1', [photo.id]);
    }

    const leads = await db.query<{ id: string }>(
      `delete from leads
        where id in (
          select l.id from leads l join companies c on c.id = l.company_id
           where l.created_at < now() - make_interval(months => c.retention_leads_months)
              or (l.deleted_at is not null and l.deleted_at < now() - interval '30 days')
           limit 500)
        returning id`);

    await db.query(`delete from login_events where at < now() - interval '1 year'`);
    await db.query(`delete from password_codes where created_at < now() - interval '30 days'`);
    await db.query(`delete from device_sessions where revoked_at < now() - interval '30 days'`);
    await db.query(`delete from jobs where status = 'done' and finished_at < now() - interval '7 days'`);

    if (photos.length || leads.length) log.log(`retention: ${photos.length} photos, ${leads.length} leads removed`);
    await queue.add('retention.sweep', {}, { dedupeKey: 'retention.sweep', runAt: nextNight() });
  }

  /** LIC-04: 30, 14, 7 and 1 day before the licence ends, and once after. */
  async function licenceReminders(): Promise<void> {
    const rows = await db.query<{ company_id: string; name: string; ends_on: string; days: number; reminders_sent: number[] }>(
      `select l.company_id, c.name, to_char(l.ends_on, 'YYYY-MM-DD') as ends_on,
              (l.ends_on - current_date) as days, l.reminders_sent
         from licences l join companies c on c.id = l.company_id
        where not c.suspended and l.ends_on <= current_date + 30`);
    for (const row of rows) {
      const step = [30, 14, 7, 1, 0].find((d) => row.days <= d && !row.reminders_sent.includes(d));
      if (step === undefined) continue;
      await notifications.notify({
        companyId: row.company_id, kind: row.days < 0 ? 'licence_expired' : 'licence_expiring',
        title: row.days < 0 ? 'Your WeTa Snap licence has ended' : `Your licence ends in ${row.days} day${row.days === 1 ? '' : 's'}`,
        body: `It runs to ${row.ends_on}. Scanning keeps working for two weeks after that.`,
        link: '/settings?tab=billing',
        dedupeKey: `licence:${row.company_id}:${step}`,
      });
      await db.query('update licences set reminders_sent = array_append(reminders_sent, $2) where company_id = $1',
        [row.company_id, step]);
    }
    await queue.add('licence.reminders', {}, { dedupeKey: 'licence.reminders', runAt: nextNight() });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 02:30 tonight, in the server's own zone. */
function nextNight(): Date {
  const when = new Date();
  when.setHours(2, 30, 0, 0);
  if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
  return when;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
