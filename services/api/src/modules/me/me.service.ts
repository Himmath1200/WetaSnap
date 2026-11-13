/**
 * The signed-in person's own account: profile, picture, devices, sign-in history, the security
 * policy and the authenticator. Everything here is about *me*, so it is scoped by person_id rather
 * than by company — except the policy, which WeTano sets for everyone.
 */
import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { AuditService } from '../../common/audit.service';
import { CacheService } from '../../common/cache.service';
import { hashCode, recoveryCode, signPath } from '../../common/crypto';
import { DbService, type Caller } from '../../common/db.service';
import { DomainError, notFound } from '../../common/errors';
import { SessionService } from '../../common/session.service';
import { StorageService } from '../../common/storage.service';
import { newSecret, otpauthUrl, verifyTotp } from '../../common/totp';
import type { Policy } from '../auth/password.service';

export interface DeviceSessionDto {
  id: string; person_id: string; device: string; ip: string; location: string;
  created_at: string; last_seen_at: string; current: boolean;
}

export interface LoginEventDto {
  id: string; at: string; email: string; method: string; ok: boolean;
  reason: string; device: string; ip: string; location: string;
}

export interface RecoveryCodesDto { codes: string[]; used: number; generated_at: string }

@Injectable()
export class MeService {
  constructor(
    private readonly db: DbService,
    private readonly sessions: SessionService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  async updateProfile(me: Caller, patch: { name: string; phone: string }): Promise<void> {
    await this.db.as(me, (c) => c.query(
      `update people set name = coalesce(nullif(btrim($2), ''), name), phone = $3 where id = $1`,
      [me.personId, patch.name, patch.phone.slice(0, 40)],
    ));
    await this.audit.write(me, { action: 'profile.save', entity: 'people', entityId: me.personId });
  }

  /**
   * Profile pictures are re-encoded here rather than stored as they arrive: that strips EXIF (and
   * with it the GPS position of wherever the photo was taken) and caps the size for everyone.
   */
  async saveAvatar(me: Caller, file: { data: string; mime: string } | null): Promise<string | null> {
    if (!file) {
      const old = await this.db.one<{ avatar_url: string | null }>('select avatar_url from people where id = $1', [me.personId]);
      if (old?.avatar_url) await this.storage.delete(StorageService.avatarKey(me.personId));
      await this.db.query('update people set avatar_url = null where id = $1', [me.personId]);
      return null;
    }
    const raw = Buffer.from(file.data, 'base64');
    if (raw.length > 4 * 1024 * 1024) throw new DomainError('Please use a picture under 4 MB.', 400);
    const jpeg = await sharp(raw).rotate().resize(256, 256, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();
    const key = StorageService.avatarKey(me.personId);
    await this.storage.put(key, jpeg, 'image/jpeg');
    const url = `/v1/files/avatar/${me.personId}`;
    await this.db.query('update people set avatar_url = $2 where id = $1', [me.personId, url]);
    await this.audit.write(me, { action: 'profile.avatar', entity: 'people', entityId: me.personId });
    return signPath(url);
  }

  // ---------------------------------------------------------------- devices
  async devices(me: Caller, currentSessionId: string): Promise<DeviceSessionDto[]> {
    const rows = await this.db.asQuery<DeviceSessionDto>(me,
      `select id, person_id, device, coalesce(host(ip), '') as ip, location,
              created_at, last_seen_at, false as current
         from device_sessions
        where person_id = $1 and revoked_at is null and expires_at > now()
        order by last_seen_at desc`,
      [me.personId]);
    return rows.map((r) => ({ ...r, current: r.id === currentSessionId }));
  }

  async revokeDevice(me: Caller, id: string): Promise<void> {
    const row = await this.db.asOne<{ id: string }>(me,
      `update device_sessions set revoked_at = now()
        where id = $1 and person_id = $2 and revoked_at is null returning id`, [id, me.personId]);
    if (!row) throw notFound('That device');
    await this.audit.write(me, { action: 'session.revoke', entity: 'device_sessions', entityId: id });
  }

  async revokeOtherDevices(me: Caller, keepSessionId: string): Promise<number> {
    const n = await this.sessions.revokeOthers(me.personId, keepSessionId);
    await this.audit.write(me, { action: 'session.revoke_others', entity: 'device_sessions', details: { count: n } });
    return n;
  }

  /** My own history, or — for an admin — one of my people's (AUTH-06). */
  async history(me: Caller, personId?: string): Promise<LoginEventDto[]> {
    return this.db.asQuery<LoginEventDto>(me,
      `select id::text, at, email, method::text as method, ok, reason, device,
              coalesce(host(ip), '') as ip, location
         from login_events
        where person_id::text = coalesce($1::text, $2::text)
        order by at desc limit 200`,
      [personId ?? null, me.personId]);
  }

  // ---------------------------------------------------------------- policy
  async policy(): Promise<Policy> {
    const row = await this.db.one<Policy>(`select * from security_policy where id = 'current'`);
    if (!row) throw new DomainError('The security policy is missing.', 500);
    return row;
  }

  /** WeTano only. Saved rules reach every device on its next sync. */
  async savePolicy(me: Caller, policy: Partial<Policy>): Promise<Policy> {
    const current = await this.policy();
    const next = { ...current, ...policy };
    const row = await this.db.asOne<Policy>(me,
      `update security_policy set
         min_length = $2, require_upper = $3, require_number = $4, require_symbol = $5,
         expiry_days = $6, reuse_block = $7, lockout_attempts = $8, lockout_minutes = $9,
         idle_timeout_minutes = $10, device_session_days = $11,
         updated_at = now(), updated_by = $1
       where id = 'current' returning *`,
      [me.personId, next.min_length, next.require_upper, next.require_number, next.require_symbol,
        next.expiry_days, next.reuse_block, next.lockout_attempts, next.lockout_minutes,
        next.idle_timeout_minutes, next.device_session_days],
    );
    if (!row) throw new DomainError('You do not have permission to change the security rules.', 403);
    await this.cache.del('security:policy');
    await this.audit.write(me, { action: 'security.policy', entity: 'security_policy', details: { ...policy } });
    return row;
  }

  // ---------------------------------------------------------------- authenticator (optional)
  /**
   * An authenticator is never required (client decision, 26 Sep 2026) — this is only for people
   * who want one. The secret is kept aside until the first code proves the app has it.
   */
  async startMfa(me: Caller): Promise<{ secret: string; otpauth_url: string }> {
    const person = await this.db.one<{ email: string }>('select email from people where id = $1', [me.personId]);
    // If there is already a pending MFA secret set up recently, reuse it so mobile app-switching doesn't invalidate it
    const existing = await this.db.one<{ mfa_pending: string | null }>(
      'select mfa_pending from person_credentials where person_id = $1',
      [me.personId],
    );
    const secret = existing?.mfa_pending || newSecret();
    await this.db.query(
      `insert into person_credentials (person_id, mfa_pending) values ($1, $2)
         on conflict (person_id) do update set mfa_pending = excluded.mfa_pending`,
      [me.personId, secret],
    );
    return { secret, otpauth_url: otpauthUrl(secret, person?.email ?? 'WeTa Snap') };
  }

  async confirmMfa(me: Caller, code: string): Promise<RecoveryCodesDto> {
    const row = await this.db.one<{ mfa_pending: string | null }>(
      'select mfa_pending from person_credentials where person_id = $1', [me.personId]);
    if (!row?.mfa_pending) throw new DomainError('Start the set-up again — no authenticator was waiting.', 400);
    if (!verifyTotp(row.mfa_pending, code)) throw new DomainError('That authenticator code is not right.', 400, 'bad_code');
    await this.db.tx(async (c) => {
      await c.query(
        `update person_credentials set mfa_secret = mfa_pending, mfa_pending = null where person_id = $1`,
        [me.personId]);
      await c.query('update people set mfa_enabled = true where id = $1', [me.personId]);
    });
    await this.audit.write(me, { action: 'mfa.enable', entity: 'people', entityId: me.personId });
    return this.regenerateRecoveryCodes(me);
  }

  async disableMfa(me: Caller, code: string): Promise<void> {
    const row = await this.db.one<{ mfa_secret: string | null }>(
      'select mfa_secret from person_credentials where person_id = $1', [me.personId]);
    if (!row?.mfa_secret) return;
    if (!verifyTotp(row.mfa_secret, code)) throw new DomainError('That authenticator code is not right.', 400, 'bad_code');
    await this.db.tx(async (c) => {
      await c.query('update person_credentials set mfa_secret = null, mfa_pending = null where person_id = $1', [me.personId]);
      await c.query('update people set mfa_enabled = false where id = $1', [me.personId]);
      await c.query('delete from recovery_codes where person_id = $1', [me.personId]);
    });
    await this.audit.write(me, { action: 'mfa.disable', entity: 'people', entityId: me.personId });
  }

  /** How many are left — the codes themselves are never shown again after they are made. */
  async recoveryStatus(me: Caller): Promise<RecoveryCodesDto> {
    const rows = await this.db.query<{ used_at: Date | null; created_at: Date }>(
      'select used_at, created_at from recovery_codes where person_id = $1 order by created_at', [me.personId]);
    return {
      codes: [],
      used: rows.filter((r) => r.used_at).length,
      generated_at: rows[0]?.created_at ? new Date(rows[0].created_at).toISOString() : new Date().toISOString(),
    };
  }

  async regenerateRecoveryCodes(me: Caller): Promise<RecoveryCodesDto> {
    const codes = Array.from({ length: 6 }, () => recoveryCode());
    await this.db.tx(async (c) => {
      await c.query('delete from recovery_codes where person_id = $1', [me.personId]);
      for (const code of codes) {
        await c.query('insert into recovery_codes (person_id, code_hash) values ($1, $2)',
          [me.personId, hashCode(code.replace('-', ''))]);
      }
    });
    await this.audit.write(me, { action: 'mfa.recovery_codes', entity: 'people', entityId: me.personId });
    return { codes, used: 0, generated_at: new Date().toISOString() };
  }

  // ---------------------------------------------------------------- individual billing
  async getIndividualPricing() {
    const row = await this.db.one<any>(`select * from individual_pricing limit 1`);
    return row ?? {
      free_scans_limit: 5,
      pro_price_month: 100,
      pro_price_year: 1150,
      currency: 'USD',
      free_features: [
        '5 business card scans per month',
        'Fast on-device document alignment',
        'Standard offline text extraction',
        'Single contact export',
        'Standard community support',
      ],
      pro_features: [
        'Unlimited card scans every month',
        'Google Gemini AI OCR field verification',
        'Bulk Excel (.xlsx), CSV and PDF export',
        'Multi-device automatic cloud sync',
        'Voice memos & business card photo attachments',
        'Priority 24/7 customer support',
        'No overage fees or hidden charges',
      ],
    };
  }

  async upgradePlan(me: Caller, plan: 'pro', cycle: 'monthly' | 'annual') {
    await this.db.query(
      `update people set plan = $2, monthly_scans = 0 where id = $1`,
      [me.personId, plan],
    );
    await this.audit.write(me, { action: 'billing.upgrade', entity: 'people', entityId: me.personId, details: { plan, cycle } });
    return { ok: true };
  }

  async recordScanUsage(me: Caller) {
    const person = await this.db.one<any>(`select plan, monthly_scans from people where id = $1`, [me.personId]);
    const pricing = await this.getIndividualPricing();
    const plan = person?.plan ?? 'free';
    const currentScans = person?.monthly_scans ?? 0;
    const limit = plan === 'pro' ? 999999 : (pricing.free_scans_limit || 5);

    if (plan !== 'pro' && currentScans >= limit) {
      return { allowed: false, count: currentScans, limit, plan: 'free' };
    }

    const nextCount = currentScans + 1;
    await this.db.query(`update people set monthly_scans = $2 where id = $1`, [me.personId, nextCount]);
    return { allowed: true, count: nextCount, limit, plan };
  }
}
