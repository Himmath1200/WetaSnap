/**
 * The audit log (S10). Every change worth answering for, and every failure the app reports, lands
 * here with who did it, from where, and to what. WeTano reads it; nobody can edit it.
 *
 * Details are scrubbed before they are written: no passwords, tokens, or long free text, and
 * e-mail addresses and phone numbers are masked, because an audit entry is read by WeTano staff
 * who have no business seeing a visitor's details.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Conn, DbService } from './db.service';

export interface AuditInput {
  action: string;                       // 'lead.delete', 'person.invite', 'error.TypeError'
  entity: string;                       // 'leads', 'people', 'client_error'
  entityId?: string | null;
  companyId?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
  conn?: Conn;                          // write inside the caller's transaction
}

export interface Actor {
  personId: string | null;
  companyId: string | null;
  role: 'super_admin' | 'client_admin' | 'staff' | 'individual' | 'organizer' | null;
  email?: string;
}

const SECRET_KEYS = /pass|secret|token|key|authorization|cookie|code$/i;

@Injectable()
export class AuditService {
  private readonly log = new Logger('Audit');

  constructor(private readonly db: DbService) {}

  async write(actor: Actor | null, input: AuditInput): Promise<void> {
    const sql = `insert into audit_log (company_id, actor_id, actor_role, actor_email, action, entity, entity_id, ip, details)
                 values ($1, $2, $3::app_role, $4, $5, $6, $7, $8::inet, $9)`;
    const params = [
      input.companyId ?? actor?.companyId ?? null,
      actor?.personId ?? null,
      actor?.role ?? null,
      actor?.email ?? '',
      input.action.slice(0, 120),
      input.entity.slice(0, 60),
      input.entityId ? String(input.entityId).slice(0, 120) : null,
      input.ip ?? null,
      scrub(input.details ?? {}),
    ];
    try {
      if (input.conn) await input.conn.query(sql, params);
      else await this.db.query(sql, params);
    } catch (e) {
      // An audit write must never break the thing it is recording.
      this.log.error(`could not record ${input.action}: ${(e as Error).message}`);
    }
  }
}

/** Masks anything personal or secret before it is stored. */
export function scrub(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = '[removed]';
    } else if (typeof v === 'string') {
      out[k] = scrubText(v).slice(0, 500);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = scrub(v as Record<string, unknown>);
    } else if (Array.isArray(v)) {
      out[k] = v.slice(0, 50).map((x) => (typeof x === 'string' ? scrubText(x).slice(0, 200) : x));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** a.person@company.com → a.p…@company.com; +49 151 2345678 → +49 151 ••••78; JWTs disappear. */
export function scrubText(text: string): string {
  return text
    .replace(/\b[\w.+-]+@([\w-]+\.)+\w{2,}\b/g, (m) => {
      const [user = '', domain = ''] = m.split('@');
      return `${user.slice(0, 3)}…@${domain}`;
    })
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]')
    .replace(/(\+?\d[\d ()-]{6,})(\d{2})\b/g, (_m, head: string, tail: string) => `${head.slice(0, 7)}••••${tail}`);
}
