/**
 * Reading a person and their company in the shape the app expects (lib/types.ts). Shared by
 * sign-in, "who am I" and the team screens, so there is one definition of a Person row.
 */
import { Injectable } from '@nestjs/common';
import { signPath } from '../../common/crypto';
import { DbService } from '../../common/db.service';
import { notFound } from '../../common/errors';

export interface PersonDto {
  id: string;
  company_id: string | null;
  email: string;
  name: string;
  phone: string;
  role: 'super_admin' | 'client_admin' | 'staff';
  event_ids: string[];
  default_event_id: string | null;
  access_ends_on: string | null;
  active: boolean;
  invited: boolean;
  avatar_url: string | null;
  has_password: boolean;
  mfa_enabled: boolean;
}

export interface CompanyDto {
  id: string;
  name: string;
  country: string;
  headquarters: string;
  default_language: string;
  time_zone: string;
  logo_url: string | null;
  consent_text: string;
  consent_version: number;
  retention_leads_months: number;
  retention_photos_months: number;
  cloud_ai_enabled: boolean;
  offline_pack_enabled: boolean;
  suspended: boolean;
  suspended_reason: string;
  scan_limit_action: 'block' | 'overage' | 'notify';
}

export const PERSON_COLUMNS = `
  p.id, p.company_id, p.email, p.name, p.phone, p.role::text as role,
  p.default_event_id, to_char(p.access_ends_on, 'YYYY-MM-DD') as access_ends_on,
  p.active, p.invited, p.avatar_url, p.has_password, p.mfa_enabled,
  coalesce((select array_agg(pe.event_id order by pe.created_at)
              from person_events pe where pe.person_id = p.id), '{}') as event_ids`;

export const COMPANY_COLUMNS = `
  c.id, c.name, c.country, c.headquarters, c.default_language, c.time_zone, c.logo_url,
  c.consent_text, c.consent_version, c.retention_leads_months, c.retention_photos_months,
  c.cloud_ai_enabled, c.offline_pack_enabled, c.suspended, c.suspended_reason,
  c.scan_limit_action::text as scan_limit_action`;

@Injectable()
export class PeopleService {
  constructor(private readonly db: DbService) {}

  async byId(personId: string): Promise<PersonDto> {
    const row = await this.db.one<PersonDto>(`select ${PERSON_COLUMNS} from people p where p.id = $1`, [personId]);
    if (!row) throw notFound('That account');
    return withDefaultFirst(row);
  }

  async byEmail(email: string): Promise<(PersonDto & { suspended: boolean; suspended_reason: string }) | null> {
    const row = await this.db.one<PersonDto & { suspended: boolean; suspended_reason: string }>(
      `select ${PERSON_COLUMNS},
              coalesce(c.suspended, false) as suspended, coalesce(c.suspended_reason, '') as suspended_reason
         from people p left join companies c on c.id = p.company_id
        where lower(p.email) = lower($1)`,
      [email.trim()],
    );
    return row ? (withDefaultFirst(row) as PersonDto & { suspended: boolean; suspended_reason: string }) : null;
  }

  async company(companyId: string | null): Promise<CompanyDto | null> {
    if (!companyId) return null;
    return this.db.one<CompanyDto>(`select ${COMPANY_COLUMNS} from companies c where c.id = $1`, [companyId]);
  }

  /** Records that this person got in, for "last seen" and the team list. */
  async markSignedIn(personId: string): Promise<void> {
    await this.db.query(`update people set last_sign_in_at = now(), invited = false where id = $1`, [personId]);
  }
}

/**
 * The app treats the first event as the default one, so it is put there — and the avatar link is
 * signed, because an <img> tag cannot carry a bearer token.
 */
function withDefaultFirst<T extends PersonDto>(row: T): T {
  const ids = row.event_ids ?? [];
  const sorted = row.default_event_id && ids.includes(row.default_event_id)
    ? [row.default_event_id, ...ids.filter((id) => id !== row.default_event_id)]
    : ids;
  const avatar = row.avatar_url && !row.avatar_url.includes('sig=')
    ? signPath(row.avatar_url.split('?')[0]!)
    : row.avatar_url;
  return { ...row, event_ids: sorted, avatar_url: avatar };
}
