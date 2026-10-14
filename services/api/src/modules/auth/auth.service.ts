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
import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { equalInTime, hashCode, sixDigits } from '../../common/crypto';
import { DbService } from '../../common/db.service';
import { DomainError, unauthorized } from '../../common/errors';
import { MailService } from '../../common/mail.service';
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
  constructor(
    private readonly db: DbService,
    private readonly people: PeopleService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly mail: MailService,
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
    if (person.suspended) {
      throw unauthorized(`This account is suspended. ${person.suspended_reason || 'Please contact WeTano.'}`);
    }

    // The role decides the door, not the page someone happened to open.
    const belongs: Door = person.role === 'super_admin' ? 'console' : 'app';
    if (belongs !== door) {
      await this.passwords.record({ email: address, personId: person.id, ok: false, reason: 'wrong door', ip: where.ip, device: where.device, counts: false });
      throw new DomainError(
        person.role === 'super_admin'
          ? 'WeTano accounts sign in at /super-admin.'
          : 'This is the WeTano Console. Your account signs in at the main address.',
        403, 'wrong_portal',
      );
    }

    const policy = await this.passwords.policy();
    const needsCode = person.role !== 'staff';
    const session = await this.sessions.create({
      personId: person.id,
      stage: needsCode ? 'email_code' : person.mfa_enabled ? 'totp' : 'ready',
      portal: person.role,
      device: where.device,
      ip: where.ip,
      userAgent: where.userAgent,
      days: policy.device_session_days,
    });

    await this.passwords.record({
      email: address, personId: person.id, ok: true, ip: where.ip, device: where.device, counts: !needsCode,
      reason: needsCode ? 'password ok — waiting for the emailed code' : '',
    });

    if (needsCode) {
      await this.sendLoginCode(session.id, person);
      return { next: 'email_code', token: session.token };
    }
    if (person.mfa_enabled) return { next: 'totp', token: session.token };
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
    await this.mail.send({
      to: person.email,
      subject: 'Your WeTa Snap sign-in code',
      html: this.mail.signInCode(person.name, code),
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
