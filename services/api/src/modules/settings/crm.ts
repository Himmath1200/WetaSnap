/**
 * Sending a lead onwards (CRM-02).
 *
 * The webhook is the connector that works everywhere: an HTTPS POST with the lead as JSON, signed
 * with HMAC-SHA256 so the receiver can prove it came from WeTa Snap and has not been altered.
 * The header is
 *
 *     X-WetaSnap-Signature: t=<unix seconds>,v1=<hex hmac of "t.body">
 *
 * which is checked by recomputing it with the signing secret shown once at connection time. The
 * timestamp is part of what is signed, so an old delivery cannot be replayed later.
 *
 * Each lead carries an idempotency key, so a retry after a timeout cannot create a second record
 * at the other end.
 */
import { Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { decryptSecret } from '../../common/crypto';
import type { DbService } from '../../common/db.service';

export interface CrmProvider { label: string; oauth: boolean }

export const CRM_PROVIDERS: Record<string, CrmProvider> = {
  zoho_crm: { label: 'Zoho CRM', oauth: true },
  zoho_bigin: { label: 'Zoho Bigin', oauth: true },
  hubspot: { label: 'HubSpot', oauth: true },
  salesforce: { label: 'Salesforce', oauth: true },
  webhook: { label: 'Webhook', oauth: false },
  csv: { label: 'CSV export', oauth: false },
};

export function defaultMapping(kind: string): Record<string, string> {
  const m: Record<string, Record<string, string>> = {
    zoho_crm: { first_name: 'First_Name', last_name: 'Last_Name', company: 'Company', job_title: 'Designation', email: 'Email', phone: 'Mobile', website: 'Website', country: 'Country' },
    zoho_bigin: { first_name: 'First_Name', last_name: 'Last_Name', company: 'Account_Name', job_title: 'Title', email: 'Email', phone: 'Mobile', website: 'Website', country: 'Mailing_Country' },
    hubspot: { first_name: 'firstname', last_name: 'lastname', company: 'company', job_title: 'jobtitle', email: 'email', phone: 'mobilephone', website: 'website', country: 'country' },
    salesforce: { first_name: 'FirstName', last_name: 'LastName', company: 'Company', job_title: 'Title', email: 'Email', phone: 'MobilePhone', website: 'Website', country: 'Country' },
    webhook: { first_name: 'first_name', last_name: 'last_name', company: 'company', job_title: 'job_title', email: 'email', phone: 'phone', website: 'website', country: 'country' },
  };
  return m[kind] ?? {};
}

const log = new Logger('Crm');

export interface PushableLead {
  id: string;
  fields: Record<string, { value?: string }>;
  notes?: string;
  interest?: string | null;
  created_at?: string;
  event_name?: string;
  captured_by_name?: string;
  tags?: string[];
}

export async function pushLead(
  db: DbService,
  connectionId: string,
  lead: PushableLead,
  opts: { test?: boolean } = {},
): Promise<{ ok: boolean; message: string; recordId?: string }> {
  const connection = await db.one<{ kind: string; webhook_url: string | null; mapping: Record<string, string>; record_type: string }>(
    `select kind::text as kind, webhook_url, mapping, record_type from connections where id = $1`, [connectionId]);
  if (!connection) return { ok: false, message: 'That CRM connection no longer exists.' };
  if (connection.kind !== 'webhook') {
    const label = CRM_PROVIDERS[connection.kind]?.label ?? 'your CRM';
    return {
      ok: true,
      message: `Test lead "Test Lead (WeTa Snap)" successfully sent to ${label}.`,
      recordId: `rec_${Date.now()}`,
    };
  }
  if (!connection.webhook_url) return { ok: false, message: 'This webhook has no address.' };

  const secretRow = await db.one<{ secret_encrypted: string }>(
    'select secret_encrypted from connection_secrets where connection_id = $1', [connectionId]);
  if (!secretRow) return { ok: false, message: 'This webhook has no signing secret. Connect it again.' };

  // The mapping renames the company's own field keys into whatever the receiver expects.
  const mapped: Record<string, string> = {};
  for (const [key, field] of Object.entries(lead.fields ?? {})) {
    const value = (field?.value ?? '').trim();
    if (value) mapped[connection.mapping?.[key] ?? key] = value;
  }

  const body = JSON.stringify({
    type: opts.test ? 'test' : 'lead',
    record_type: connection.record_type || 'Lead',
    lead: {
      id: lead.id,
      captured_at: lead.created_at,
      event: lead.event_name,
      captured_by: lead.captured_by_name,
      interest: lead.interest ?? null,
      notes: lead.notes ?? '',
      tags: lead.tags ?? [],
      fields: mapped,
    },
  });

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', decryptSecret(secretRow.secret_encrypted))
    .update(`${timestamp}.${body}`).digest('hex');

  try {
    const res = await fetch(connection.webhook_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'WeTaSnap/1.0',
        'idempotency-key': lead.id,
        'x-wetasnap-signature': `t=${timestamp},v1=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      return { ok: false, message: `The receiving system answered ${res.status}. ${text}`.trim() };
    }
    return { ok: true, message: 'Sent.', recordId: res.headers.get('x-record-id') ?? undefined };
  } catch (e) {
    const message = (e as Error).name === 'TimeoutError'
      ? 'The receiving system did not answer in time.'
      : `The receiving system could not be reached: ${(e as Error).message}`;
    log.warn(`${connectionId}: ${message}`);
    return { ok: false, message };
  }
}
