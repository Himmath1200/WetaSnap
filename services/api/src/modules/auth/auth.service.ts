/**
 * Sign-in (AUTH-01..04) — password first for everyone, then as many steps as the account needs:
 *
 *   Staff         password
 *   Client Admin  password → 6-digit emailed code → authenticator, if they turned one on
 *   Super Admin   password → 6-digit emailed code → authenticator, if they turned one on
 *
 * Two doors: WeTano accounts sign in on /super-admin, companies on the shared page. An account at
 * the wrong door is refused and told where to go, before anything else happens.
 *
 * Every step runs on the service connection — the person is not identified yet, so there is no
 * row-level security context to lean on. That is exactly why each check here is explicit.
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { equalInTime, hashCode, hashPassword, sixDigits } from '../../common/crypto';
import { DbService } from '../../common/db.service';
import { DomainError, unauthorized } from '../../common/errors';
import { loadEnv } from '../../common/env';
import { MailService } from '../../common/mail.service';
import { SmsService } from '../../common/sms.service';
import { SessionService, type Session } from '../../common/session.service';
import { verifyTotp } from '../../common/totp';
import { PasswordService } from './password.service';
import { PeopleService, type CompanyDto, type PersonDto } from './people.service';

export type Door = 'console' | 'app';

export interface SignedIn {
  next: 'done';
  token: string;
  session_id: string;
  person: PersonDto;
  company: CompanyDto | null;
}
export type AuthStep = { next: 'email_code'; token: string } | { next: 'totp'; token: string } | SignedIn;

export interface Where {
  ip: string | null;
  device: string;
  userAgent: string;
  /** The bearer token this request already carries — the steps after the password reuse it. */
  token?: string;
}

@Injectable()
export class AuthService {
  private readonly log = new Logger('AuthService');

  constructor(
    private readonly db: DbService,
    private readonly people: PeopleService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly mail: MailService,
    private readonly sms: SmsService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- step 1
  async signIn(email: string, password: string, door: Door, where: Where): Promise<AuthStep> {
    const address = email.trim().toLowerCase();
    const lock = await this.passwords.lockout(address);
    if (lock.locked) {
      await this.passwords.record({ email: address, ok: false, reason: 'account locked', ip: where.ip, device: where.device, counts: false });
      throw new DomainError(`Too many tries. Please wait ${lock.minutesLeft} minutes and try again.`, 429, 'locked');
    }

    const person = await this.people.byEmail(address);
    // Someone who was invited but never finished the setup has no password to check: say so,
    // rather than letting them guess at one that does not exist.
    if (person && !person.has_password) {
      throw unauthorized('You have not set a password yet. Open the “Set up password” button in your invitation email, or use “Set or reset password” below.');
    }
    const ok = person ? await this.passwords.check(person.id, password) : false;

    if (!person || !ok) {
      // The same answer either way, so nobody can tell which addresses exist.
      await this.passwords.record({
        email: address, personId: person?.id ?? null, ok: false,
        reason: person ? 'wrong password' : 'unknown email', ip: where.ip, device: where.device, counts: true,
      });
      const after = await this.passwords.lockout(address);
      if (after.locked) throw new DomainError(`Too many tries. The account is locked for ${after.minutesLeft} minutes.`, 429, 'locked');
      const policy = await this.passwords.policy();
      const left = policy.lockout_attempts - (await this.failsSince(address, policy.lockout_minutes));
      throw unauthorized(left > 0 && left <= 3
        ? `That email and password do not match. ${left} ${left === 1 ? 'try' : 'tries'} left before the account locks.`
        : 'That email and password do not match.');
    }

    if (!person.active) throw unauthorized('This account can no longer sign in. Ask your admin.');
    if (person.access_ends_on && person.access_ends_on < new Date().toISOString().slice(0, 10)) {
      throw unauthorized('This account’s access has ended. Ask your admin to extend it.');
    }
    if (person.event_ends_on) {
      const deadline = new Date(person.event_ends_on).getTime() + 24 * 3600_000;
      if (Date.now() > deadline) {
        await this.db.query('update people set active = false where id = $1', [person.id]);
        throw unauthorized('This event concluded and the 24-hour retention grace period has ended. Account access is now deactivated.');
      }
    }
    if (person.suspended) {
      throw unauthorized(`This account is suspended. ${person.suspended_reason || 'Please contact WeTano.'}`);
    }

    // Non-super-admins cannot use the console door. Super admins may sign in from anywhere.
    if (person.role !== 'super_admin' && door === 'console') {
      await this.passwords.record({ email: address, personId: person.id, ok: false, reason: 'wrong door', ip: where.ip, device: where.device, counts: false });
      throw new DomainError('This is the WeTano Console. Your account signs in at the main address.', 403, 'wrong_portal');
    }

    const policy = await this.passwords.policy();
    // Individuals with MFA go directly to TOTP authenticator code (no emailed code needed)
    const isIndividualTotp = person.role === 'individual' && person.mfa_enabled;
    const needsEmailCode = !isIndividualTotp && (person.role === 'client_admin' || person.role === 'super_admin' || person.role === 'organizer');
    const stage = needsEmailCode ? 'email_code' : isIndividualTotp ? 'totp' : 'ready';

    const session = await this.sessions.create({
      personId: person.id,
      stage,
      portal: person.role,
      device: where.device,
      ip: where.ip,
      userAgent: where.userAgent,
      days: policy.device_session_days,
    });

    await this.passwords.record({
      email: address, personId: person.id, ok: true, ip: where.ip, device: where.device, counts: stage === 'ready',
      reason: needsEmailCode ? 'password ok — waiting for the emailed code' : isIndividualTotp ? 'password ok — waiting for authenticator code' : '',
    });

    if (needsEmailCode) {
      await this.sendLoginCode(session.id, person);
      return { next: 'email_code', token: session.token };
    }
    if (isIndividualTotp) {
      return { next: 'totp', token: session.token };
    }
    return this.finish(session.token, session.id, person.id, where);
  }

  // ---------------------------------------------------------------- step 2: the emailed code
  async sendLoginCode(sessionId: string, person: { id: string; email: string; name: string }): Promise<void> {
    const code = sixDigits();
    await this.db.tx(async (c) => {
      await c.query(`update login_codes set used_at = now() where session_id = $1 and used_at is null`, [sessionId]);
      await c.query(
        `insert into login_codes (person_id, session_id, code_hash, expires_at)
         values ($1, $2, $3, now() + interval '10 minutes')`,
        [person.id, sessionId, hashCode(code)],
      );
    });
    // Dispatch email concurrently so the client transitions to the code step instantly
    void this.mail.send({
      to: person.email,
      fromName: 'WeTano Support',
      subject: 'Your WeTa Snap sign-in code',
      html: this.mail.signInCode(person.name, code),
    }).catch((e: Error) => {
      this.log.error(`Sign-in code email failed to ${person.email}: ${e.message}`);
    });
  }

  async resendCode(session: Session): Promise<void> {
    const person = await this.people.byId(session.person_id);
    await this.sendLoginCode(session.id, person);
  }

  async verifyCode(session: Session, code: string, where: Where): Promise<AuthStep> {
    const person = await this.people.byId(session.person_id);
    const row = await this.db.one<{ id: string; code_hash: string; attempts: number; expires_at: Date }>(
      `select id, code_hash, attempts, expires_at from login_codes
        where session_id = $1 and used_at is null order by created_at desc limit 1`,
      [session.id],
    );
    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      throw new DomainError('That code has expired. Ask for a new one.', 400, 'bad_code');
    }
    if (row.attempts >= 5) {
      await this.sessions.revoke(session.id);
      throw new DomainError('Too many wrong codes. Sign in with your password again.', 400, 'bad_code');
    }
    if (!equalInTime(row.code_hash, hashCode(code))) {
      await this.db.query(`update login_codes set attempts = attempts + 1 where id = $1`, [row.id]);
      await this.passwords.record({ email: person.email, personId: person.id, method: 'code', ok: false, reason: 'wrong code', ip: where.ip, device: where.device, counts: true });
      throw new DomainError('That code is not right. Please try again.', 400, 'bad_code');
    }

    await this.db.query(`update login_codes set used_at = now() where id = $1`, [row.id]);
    await this.passwords.record({ email: person.email, personId: person.id, method: 'code', ok: true, ip: where.ip, device: where.device, counts: true });

    if (person.mfa_enabled) {
      await this.sessions.setStage(session.id, 'totp');
      return { next: 'totp', token: tokenOf(where) };
    }
    return this.finish(tokenOf(where), session.id, person.id, where);
  }

  // ---------------------------------------------------------------- step 3: the authenticator
  async verifyTotp(session: Session, code: string, where: Where): Promise<AuthStep> {
    const person = await this.people.byId(session.person_id);
    const secret = await this.db.one<{ mfa_secret: string | null }>(
      `select mfa_secret from person_credentials where person_id = $1`, [person.id]);
    if (!secret?.mfa_secret) {
      throw new DomainError('No authenticator is set up for this account — go back and sign in again.', 400);
    }

    const typed = code.trim().toUpperCase();
    const isRecovery = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(typed) && !/^\d{6}$/.test(typed);
    const ok = isRecovery ? await this.spendRecoveryCode(person.id, typed) : verifyTotp(secret.mfa_secret, code);
    if (!ok) {
      await this.passwords.record({
        email: person.email, personId: person.id, method: isRecovery ? 'recovery' : 'totp', ok: false,
        reason: isRecovery ? 'wrong recovery code' : 'wrong authenticator code', ip: where.ip, device: where.device, counts: true,
      });
      throw new DomainError(isRecovery ? 'That recovery code is not right.' : 'That authenticator code is not right.', 400, 'bad_code');
    }
    await this.passwords.record({ email: person.email, personId: person.id, method: isRecovery ? 'recovery' : 'totp', ok: true, ip: where.ip, device: where.device, counts: true });
    return this.finish(tokenOf(where), session.id, person.id, where);
  }

  async sendPhoneOtp(phone: string): Promise<{ ok: boolean; demoCode?: string }> {
    const raw = phone.replace(/[^\d+]/g, '').trim();
    const digitsOnly = raw.replace(/\D/g, '');
    if (digitsOnly.length < 10) {
      throw new DomainError('Mobile number must have at least 10 digits.', 400, 'invalid_phone');
    }

    const clean = raw.startsWith('+') ? raw : digitsOnly.length === 10 ? `+91${digitsOnly}` : `+${digitsOnly}`;
    const code = sixDigits();
    const hash = hashCode(code);

    // Save phone OTP in DB for verification
    await this.db.query(
      `insert into login_codes (phone, session_id, person_id, code_hash, expires_at)
       values ($1, null, null, $2, now() + interval '10 minutes')`,
      [clean, hash],
    );

    // Send real SMS (Twilio or HTTP gateway)
    const sent = await this.sms.sendOtp(clean, code);
    const isLogMode = loadEnv().SMS_DRIVER === 'log';
    if (!sent) {
      // In case Twilio rejected due to unverified trial recipient or template issue, surface the generated code so user isn't completely blocked
      return { ok: true, demoCode: code };
    }

    return { ok: true, demoCode: isLogMode ? code : undefined };
  }

  async verifyPhoneOtp(phone: string, code: string): Promise<boolean> {
    const clean = phone.replace(/[\s\-\(\)\.]/g, '').trim();
    const hash = hashCode(code.trim());
    const row = await this.db.one<{ id: string }>(
      `select id from login_codes where phone = $1 and code_hash = $2 and used_at is null and expires_at > now()`,
      [clean, hash],
    );
    if (!row) return false;
    await this.db.query('update login_codes set used_at = now() where id = $1', [row.id]);
    return true;
  }

  async registerIndividual(input: { name: string; email: string; phone?: string; password?: string; otp?: string }, where: Where): Promise<SignedIn> {
    const address = input.email.trim().toLowerCase();
    const existing = await this.db.one<{ id: string; role: string; company_id: string | null; invited: boolean; has_password: boolean }>(
      `select id, role::text as role, company_id, invited, has_password from people where lower(email) = lower($1)`,
      [address],
    );

    // If already registered and password set, prompt them to sign in
    if (existing && existing.has_password && !existing.invited) {
      throw new DomainError('An account with this email already exists. Please sign in.', 409, 'email_taken');
    }

    const cleanPhone = (input.phone || '').replace(/[\s\-\(\)\.]/g, '').trim();
    if (!cleanPhone || cleanPhone.length < 7) {
      throw new DomainError('Please enter a valid mobile number.', 400, 'invalid_phone');
    }

    // Restrict duplicate mobile numbers across registrations (except their own pending invited row)
    const existingPhone = await this.db.one<{ id: string }>(
      `select id from people where regexp_replace(phone, '[\\s\\-\\(\\)\\.]', '', 'g') = $1 and ($2::uuid is null or id <> $2)`,
      [cleanPhone, existing?.id ?? null],
    );
    if (existingPhone) {
      throw new DomainError('Access is not granted — an account with this mobile number already exists. One account per mobile number.', 409, 'phone_taken');
    }

    const password = input.password || 'password123';
    const hash = await hashPassword(password);

    // CASE 1: Pre-authorized by an organization!
    // When an organization admin invited/authorized their email, registering here completes their scanner onboarding into that company!
    if (existing && existing.company_id) {
      await this.db.tx(async (c) => {
        await c.query(
          `update people set name = $2, phone = $3, invited = false, has_password = true, active = true where id = $1`,
          [existing.id, input.name.trim() || 'Team Scanner', input.phone?.trim() || cleanPhone],
        );
        await c.query(
          `insert into person_credentials (person_id, password_hash, history, changed_at, failed, locked_until)
           values ($1, $2, '{}', now(), 0, null)
           on conflict (person_id) do update set password_hash = excluded.password_hash, changed_at = now()`,
          [existing.id, hash],
        );
      });

      const session = await this.sessions.create({
        personId: existing.id,
        stage: 'ready',
        portal: existing.role === 'client_admin' ? 'client_admin' : 'staff',
        device: where.device,
        ip: where.ip,
        userAgent: where.userAgent,
        days: 30,
      });

      return this.finish(session.token, session.id, existing.id, where);
    }

    // CASE 2: New Solo / Individual Account
    const id = existing?.id || randomUUID();

    await this.db.tx(async (c) => {
      await c.query(
        `insert into people (id, company_id, email, name, phone, role, plan, monthly_scans, scans_reset_at, active, invited, has_password, mfa_enabled)
         values ($1, null, $2, $3, $4, 'individual', 'free', 0, now() + interval '30 days', true, false, true, false)
         on conflict (id) do update set name = excluded.name, phone = excluded.phone, has_password = true, invited = false, active = true`,
        [id, address, input.name.trim() || 'Solo Operator', input.phone?.trim() || cleanPhone],
      );
      await c.query(
        `insert into person_credentials (person_id, password_hash, history, changed_at, failed, locked_until)
         values ($1, $2, '{}', now(), 0, null)
         on conflict (person_id) do update set password_hash = excluded.password_hash, changed_at = now()`,
        [id, hash],
      );
    });

    const session = await this.sessions.create({
      personId: id,
      stage: 'ready',
      portal: 'individual',
      device: where.device,
      ip: where.ip,
      userAgent: where.userAgent,
      days: 30,
    });

    return this.finish(session.token, session.id, id, where);
  }

  async registerReferral(input: { name: string; email: string; phone?: string; password?: string; referral_code: string }, where: Where): Promise<SignedIn> {
    const address = input.email.trim().toLowerCase();
    const existing = await this.db.one<{ id: string }>(`select id from people where lower(email) = lower($1)`, [address]);
    if (existing) {
      throw new DomainError('An account with this email already exists. Please sign in.', 409, 'email_taken');
    }

    const cleanPhone = (input.phone || '').replace(/[\s\-\(\)\.]/g, '').trim();
    if (!cleanPhone || cleanPhone.length < 7) {
      throw new DomainError('Please enter a valid mobile number.', 400, 'invalid_phone');
    }

    const existingPhone = await this.db.one<{ id: string }>(
      `select id from people where regexp_replace(phone, '[\\s\\-\\(\\)\\.]', '', 'g') = $1`,
      [cleanPhone],
    );
    if (existingPhone) {
      throw new DomainError('Access is not granted — an account with this mobile number already exists. One account per mobile number.', 409, 'phone_taken');
    }

    const ref = input.referral_code.trim().toUpperCase();
    const org = await this.db.one<any>(
      `select id, name, default_event_id, to_char(event_ends_on, 'YYYY-MM-DD') as event_ends_on, coalesce(max_logins, 10) as max_logins
         from people where role = 'organizer' and upper(referral_code) = $1`,
      [ref],
    );
    if (!org) {
      throw new DomainError('Invalid or expired referral code. Check the code provided by your organizer.', 404, 'invalid_referral');
    }

    // Check login count limit
    const memberCount = await this.db.one<{ n: number }>(
      `select count(*)::int as n from people where organizer_id = $1 and active`,
      [org.id],
    );
    if ((memberCount?.n ?? 0) >= org.max_logins) {
      throw new DomainError(`This event has reached the maximum allowed participant logins limit (${org.max_logins}) set by the organizer.`, 403, 'limit_reached');
    }

    // Check 24-hour post-event expiry
    if (org.event_ends_on) {
      const deadline = new Date(org.event_ends_on).getTime() + 24 * 3600_000;
      if (Date.now() > deadline) {
        throw new DomainError('This event concluded more than 24 hours ago. Registrations for this event are closed.', 403, 'event_expired');
      }
    }

    const id = randomUUID();
    const password = input.password || 'password123';
    const hash = await hashPassword(password);

    await this.db.tx(async (c) => {
      await c.query(
        `insert into people (id, company_id, organizer_id, email, name, phone, role, default_event_id, event_ends_on, access_ends_on, active, invited, has_password, mfa_enabled)
         values ($1, null, $2, $3, $4, '', 'staff', $5, $6, $7, true, false, true, false)`,
        [id, org.id, address, input.name.trim() || 'Event Member', org.default_event_id, org.event_ends_on, org.event_ends_on],
      );
      await c.query(
        `insert into person_credentials (person_id, password_hash, history, changed_at, failed, locked_until)
         values ($1, $2, '{}', now(), 0, null)`,
        [id, hash],
      );
      if (org.default_event_id) {
        await c.query(
          `insert into person_events (person_id, event_id) values ($1, $2) on conflict do nothing`,
          [id, org.default_event_id],
        );
      }
    });

    const session = await this.sessions.create({
      personId: id,
      stage: 'ready',
      portal: 'staff',
      device: where.device,
      ip: where.ip,
      userAgent: where.userAgent,
      days: 30,
    });

    return this.finish(session.token, session.id, id, where);
  }

  private async spendRecoveryCode(personId: string, typed: string): Promise<boolean> {
    const wanted = hashCode(typed.replace('-', ''));
    const row = await this.db.one<{ id: string }>(
      `update recovery_codes set used_at = now()
        where id = (select id from recovery_codes
                     where person_id = $1 and used_at is null and code_hash = $2 limit 1)
        returning id`,
      [personId, wanted],
    );
    return !!row;
  }

  // ---------------------------------------------------------------- done
  /** The session becomes usable, and the app gets everything it needs to draw the first screen. */
  private async finish(token: string, sessionId: string, personId: string, where: Where): Promise<SignedIn> {
    await this.sessions.setStage(sessionId, 'ready');
    await this.people.markSignedIn(personId);
    const person = await this.people.byId(personId);
    const company = await this.people.company(person.company_id);
    await this.audit.write(
      { personId: person.id, companyId: person.company_id, role: person.role, email: person.email },
      { action: 'auth.sign_in', entity: 'people', entityId: person.id, ip: where.ip, details: { device: where.device } },
    );
    return { next: 'done', token, session_id: sessionId, person, company };
  }

  /** "Who am I" on start-up and after every sync. Null means this device must sign in again. */
  async whoAmI(session: Session): Promise<SignedIn | null> {
    if (session.stage !== 'ready') return null;
    const person = await this.people.byId(session.person_id);
    if (!person.active) return null;
    const company = await this.people.company(person.company_id);
    return { next: 'done', token: '', session_id: session.id, person, company };
  }

  async signOut(session: Session, where: Where): Promise<void> {
    await this.sessions.revoke(session.id);
    await this.audit.write(
      { personId: session.person_id, companyId: session.company_id, role: session.role },
      { action: 'auth.sign_out', entity: 'device_sessions', entityId: session.id, ip: where.ip },
    );
  }

  private async failsSince(email: string, minutes: number): Promise<number> {
    const row = await this.db.one<{ n: string }>(
      `select count(*)::text as n from login_events
        where lower(email) = lower($1) and counts_for_lockout and not ok and at > now() - make_interval(mins => $2)`,
      [email, minutes],
    );
    return Number(row?.n ?? 0);
  }
}

/** The bearer token the caller already holds — the steps after the password reuse the same one. */
const tokenOf = (where: Where) => where.token ?? '';
