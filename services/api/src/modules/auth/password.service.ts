/**
 * Everything about a password: the rules, the lockout, the 6-digit codes that confirm a change,
 * and the first-time setup an invited person goes through (AUTH-04/07/08).
 *
 * The rules live in `security_policy`, set by WeTano and applied to everyone — the app shows the
 * same list while someone types, but the decision is made here.
 */
import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { hashCode, hashPassword, sixDigits, verifyPassword } from '../../common/crypto';
import { DbService } from '../../common/db.service';
import { DomainError } from '../../common/errors';
import { loadEnv } from '../../common/env';
import { MailService } from '../../common/mail.service';
import { SessionService } from '../../common/session.service';

export interface Policy {
  min_length: number;
  require_upper: boolean;
  require_number: boolean;
  require_symbol: boolean;
  expiry_days: number;
  reuse_block: number;
  lockout_attempts: number;
  lockout_minutes: number;
  idle_timeout_minutes: number;
  device_session_days: number;
  mfa_required_super_admin: boolean;
  mfa_required_client_admin: boolean;
}

/** How long a code lasts: minutes for a reset, a week for an invitation nobody reads at once. */
export const RESET_MINUTES = 10;
export const SETUP_MINUTES = 7 * 24 * 60;

@Injectable()
export class PasswordService {
  constructor(
    private readonly db: DbService,
    private readonly mail: MailService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async policy(): Promise<Policy> {
    const row = await this.db.one<Policy>(`select * from security_policy where id = 'current'`);
    if (!row) throw new DomainError('The security policy is missing.', 500);
    return row;
  }

  /** The reasons a password is refused, in the words the app shows under the box. */
  async problems(password: string): Promise<string[]> {
    const p = await this.policy();
    const out: string[] = [];
    if (password.length < p.min_length) out.push(`At least ${p.min_length} characters`);
    if (p.require_upper && !/[A-Z]/.test(password)) out.push('One capital letter');
    if (p.require_number && !/\d/.test(password)) out.push('One number');
    if (p.require_symbol && !/[^\w\s]/.test(password)) out.push('One symbol');
    if (password.length > 200) out.push('Shorter than 200 characters');
    if (/^(password|wetasnap|welcome|qwerty|12345)/i.test(password)) out.push('Something harder to guess');
    return out;
  }

  /** Sets a password after checking the rules and the "not one of your last N" history (D-30). */
  async set(personId: string, password: string): Promise<void> {
    const problems = await this.problems(password);
    if (problems.length) throw new DomainError(problems[0]!, 400, 'policy');

    const p = await this.policy();
    if (p.reuse_block > 0) {
      const old = await this.db.query<{ hash: string }>(
        `select hash from (
           select password_hash as hash, changed_at as at from person_credentials where person_id = $1 and password_hash is not null
           union all
           select password_hash as hash, changed_at as at from password_history where person_id = $1
         ) h where hash is not null order by at desc nulls last limit $2`,
        [personId, p.reuse_block],
      );
      for (const row of old) {
        if (await verifyPassword(password, row.hash)) {
          throw new DomainError(`Please choose a password you have not used in your last ${p.reuse_block}.`, 400, 'reuse');
        }
      }
    }

    const hash = await hashPassword(password);
    await this.db.tx(async (c) => {
      const current = await c.one<{ password_hash: string | null }>(
        `select password_hash from person_credentials where person_id = $1`, [personId]);
      if (current?.password_hash) {
        await c.query(`insert into password_history (person_id, password_hash) values ($1, $2)`, [personId, current.password_hash]);
        await c.query(
          `delete from password_history where id in (
             select id from password_history where person_id = $1 order by changed_at desc offset 24)`, [personId]);
      }
      await c.query(
        `insert into person_credentials (person_id, password_hash, history, changed_at, failed, locked_until)
         values ($1, $2, '{}', now(), 0, null)
         on conflict (person_id) do update
            set password_hash = excluded.password_hash, changed_at = now(),
                failed = 0, locked_until = null`,
        [personId, hash],
      );
      await c.query(`update people set has_password = true, invited = false where id = $1`, [personId]);
    });
  }

  /** True while this address is locked out, with how long is left. */
  async lockout(email: string): Promise<{ locked: boolean; minutesLeft: number }> {
    const p = await this.policy();
    const row = await this.db.one<{ fails: string; since: Date | null }>(
      `select count(*)::text as fails, min(at) as since
         from login_events
        where lower(email) = lower($1) and counts_for_lockout and not ok
          and at > now() - make_interval(mins => $2)`,
      [email, p.lockout_minutes],
    );
    const fails = Number(row?.fails ?? 0);
    if (fails < p.lockout_attempts) return { locked: false, minutesLeft: 0 };
    const since = row?.since ? new Date(row.since).getTime() : Date.now();
    const left = Math.max(1, Math.ceil((since + p.lockout_minutes * 60_000 - Date.now()) / 60_000));
    return { locked: true, minutesLeft: left };
  }

  /** Records an attempt. Only the ones that count move the lockout. */
  async record(input: {
    email: string; personId?: string | null; method?: 'password' | 'code' | 'totp' | 'recovery';
    ok: boolean; reason?: string; device?: string; ip?: string | null; counts?: boolean;
  }): Promise<void> {
    await this.db.query(
      `insert into login_events (email, person_id, method, ok, reason, device, ip, counts_for_lockout)
       values ($1, $2, $3::login_method, $4, $5, $6, $7::inet, $8)`,
      [input.email.toLowerCase().slice(0, 200), input.personId ?? null, input.method ?? 'password', input.ok,
        (input.reason ?? '').slice(0, 300), (input.device ?? '').slice(0, 200), input.ip ?? null,
        input.counts ?? (!input.ok)],
    );
  }

  async check(personId: string, password: string): Promise<boolean> {
    const row = await this.db.one<{ password_hash: string | null }>(
      `select password_hash from person_credentials where person_id = $1`, [personId]);
    return verifyPassword(password, row?.password_hash);
  }

  /** True when the policy says this password is too old to go on using (AUTH-07). */
  async expired(personId: string): Promise<boolean> {
    const p = await this.policy();
    if (p.expiry_days <= 0) return false;
    const row = await this.db.one<{ age: number }>(
      `select extract(day from now() - coalesce(changed_at, now()))::int as age
         from person_credentials where person_id = $1`, [personId]);
    return (row?.age ?? 0) > p.expiry_days;
  }

  // ---------------------------------------------------------------- codes
  /**
   * Makes the one live code for this purpose and e-mails it. Unknown or blocked addresses get the
   * same silence, so nobody can learn who has an account by watching the answer.
   */
  async sendCode(
    email: string,
    purpose: 'reset' | 'change',
    opts: { minutes?: number; personId?: string } = {},
  ): Promise<{ sent: boolean; code?: string; personId?: string }> {
    const person = await this.db.one<{ id: string; email: string; name: string; active: boolean; has_password: boolean; access_ends_on: string | null; suspended: boolean }>(
      `select p.id, p.email, p.name, p.active, p.has_password, p.access_ends_on,
              coalesce(c.suspended, false) as suspended
         from people p left join companies c on c.id = p.company_id
        where ($2::uuid is not null and p.id = $2) or ($2::uuid is null and lower(p.email) = lower($1))`,
      [email, opts.personId ?? null],
    );
    if (!person || !person.active || person.suspended) return { sent: false };
    if (person.access_ends_on && person.access_ends_on < new Date().toISOString().slice(0, 10)) return { sent: false };

    // No more than five codes to one address in a quarter of an hour.
    const recent = await this.db.one<{ n: string }>(
      `select count(*)::text as n from password_codes
        where lower(email) = lower($1) and created_at > now() - interval '15 minutes'`,
      [person.email],
    );
    if (Number(recent?.n ?? 0) >= 5) return { sent: false };

    const code = sixDigits();
    const minutes = opts.minutes ?? RESET_MINUTES;
    await this.db.tx(async (c) => {
      await c.query(
        `update password_codes set used_at = now()
          where lower(email) = lower($1) and purpose = $2::password_purpose and used_at is null`,
        [person.email, purpose],
      );
      await c.query(
        `insert into password_codes (email, person_id, purpose, code_hash, expires_at)
         values ($1, $2, $3::password_purpose, $4, now() + make_interval(mins => $5))`,
        [person.email.toLowerCase(), person.id, purpose, hashCode(code), minutes],
      );
    });

    const setup = purpose === 'reset' && !person.has_password;
    const sendPromise = this.mail.send({
      to: person.email,
      fromName: 'WeTano Support',
      subject: setup ? 'Choose your WeTa Snap password' : `Your WeTa Snap ${purpose === 'change' ? 'password change' : 'password reset'} code`,
      html: this.mail.passwordCode(person.name, code, setup),
    }).then((res) => {
      if (!res.sent) new Logger('PasswordService').error(`Password email not sent to ${person.email}: ${res.error}`);
    }).catch((e: Error) => {
      new Logger('PasswordService').error(`Password reset email failed to ${person.email}: ${e.message}`);
    });

    await Promise.race([sendPromise, new Promise((r) => setTimeout(r, 3500))]);
    return { sent: true, code, personId: person.id };
  }

  /**
   * Makes a code without sending anything — the invitation email carries it itself (AUTH-08).
   * Returns an empty string when the address may not have one (deactivated, suspended, flooded).
   */
  async mint(personId: string, email: string, purpose: 'reset' | 'change', minutes: number): Promise<string> {
    const cleanEmail = email.trim().toLowerCase();
    const recent = await this.db.one<{ n: string }>(
      `select count(*)::text as n from password_codes
        where lower(email) = $1 and created_at > now() - interval '15 minutes'`, [cleanEmail]);
    if (Number(recent?.n ?? 0) >= 5) return '';
    const code = sixDigits();
    await this.db.tx(async (c) => {
      await c.query(
        `insert into password_codes (email, person_id, purpose, code_hash, expires_at)
         values ($1, $2, $3::password_purpose, $4, now() + make_interval(mins => $5))`,
        [cleanEmail, personId, purpose, hashCode(code), minutes]);
    });
    return code;
  }

  /** Checks a code and spends it. Five wrong tries kill it. */
  async useCode(email: string, code: string, purpose: 'reset' | 'change'): Promise<string> {
    const cleanEmail = email.trim().toLowerCase();
    const cleanCode = code.trim();
    const expectedHash = hashCode(cleanCode);

    // 1. Look for an exact match among unspent, non-expired codes (within 7 days / duration)
    const row = await this.db.one<{ id: string; person_id: string; code_hash: string; attempts: number; expires_at: Date }>(
      `select id, person_id, code_hash, attempts, expires_at from password_codes
        where lower(email) = $1 and purpose = $2::password_purpose and code_hash = $3 and used_at is null
        order by created_at desc limit 1`,
      [cleanEmail, purpose, expectedHash],
    );

    if (row) {
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await this.db.query(`update password_codes set used_at = now() where id = $1`, [row.id]);
        throw new DomainError('That code has expired. Ask for a new one.', 400, 'bad_code');
      }
      if (row.attempts >= 5) {
        await this.db.query(`update password_codes set used_at = now() where id = $1`, [row.id]);
        throw new DomainError('Too many tries. Ask for a new code.', 400, 'bad_code');
      }
      // Spend it and clean up all older codes for this email and purpose
      await this.db.query(`update password_codes set used_at = now() where lower(email) = $1 and purpose = $2::password_purpose`, [cleanEmail, purpose]);
      return row.person_id;
    }

    // 2. Fallback: Check if the user entered a code that was created within the last 15 minutes (even if a second invite was triggered)
    const recentMatch = await this.db.one<{ id: string; person_id: string; attempts: number; expires_at: Date }>(
      `select id, person_id, attempts, expires_at from password_codes
        where lower(email) = $1 and purpose = $2::password_purpose and code_hash = $3 and created_at > now() - interval '15 minutes'
        order by created_at desc limit 1`,
      [cleanEmail, purpose, expectedHash],
    );

    if (recentMatch) {
      await this.db.query(`update password_codes set used_at = now() where lower(email) = $1 and purpose = $2::password_purpose`, [cleanEmail, purpose]);
      return recentMatch.person_id;
    }

    // 3. Code did not match: count an attempt on any active code so lockout is tracked
    const anyActive = await this.db.one<{ id: string; attempts: number; expires_at: Date }>(
      `select id, attempts, expires_at from password_codes
        where lower(email) = $1 and purpose = $2::password_purpose and used_at is null
        order by created_at desc limit 1`,
      [cleanEmail, purpose],
    );

    if (anyActive) {
      if (new Date(anyActive.expires_at).getTime() < Date.now()) {
        await this.db.query('update password_codes set used_at = now() where id = $1', [anyActive.id]);
        throw new DomainError('That code has expired. Ask for a new one.', 400, 'bad_code');
      }
      await this.db.query('update password_codes set attempts = attempts + 1 where id = $1', [anyActive.id]);
      if (anyActive.attempts + 1 >= 5) {
        await this.db.query('update password_codes set used_at = now() where id = $1', [anyActive.id]);
        throw new DomainError('Too many wrong codes. Ask for a new code.', 400, 'bad_code');
      }
      throw new DomainError('That code is not right. Please check your latest email.', 400, 'bad_code');
    }

    throw new DomainError('Ask for a new code — that one is no longer valid.', 400, 'bad_code');
  }

  /** After a reset every other device is signed out — that is the point of a reset. */
  async afterReset(personId: string, ip: string | null, email: string): Promise<void> {
    await this.sessions.revokeAllFor(personId);
    await this.record({ email, personId, ok: true, reason: 'password reset', ip, counts: false });
    await this.audit.write({ personId, companyId: null, role: null, email }, {
      action: 'password.reset', entity: 'people', entityId: personId, ip,
    });
  }
}
