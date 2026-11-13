/**
 * POST /v1/auth/… — the only routes a browser may call before it is signed in, and the only ones
 * that are rate-limited per address rather than per account.
 *
 * Steps after the password run on the session the password opened: the browser keeps the token and
 * sends it as `Authorization: Bearer`, and the route says which stage that session must be in.
 */
import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { DomainError } from '../../common/errors';
import { CurrentSession, Public, RateLimit, Stage, bearer, clientIp } from '../../common/guards';
import type { Session } from '../../common/session.service';
import { code6, email as emailSchema, parse } from '../../common/validation';
import { AuthService, type Where } from './auth.service';
import { PasswordService, SETUP_MINUTES } from './password.service';
import { PeopleService } from './people.service';

const signInBody = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Please enter your password.').max(200),
  door: z.enum(['console', 'app']).default('app'),
  device: z.string().max(200).default(''),
});

const codeBody = z.object({ code: code6 });
const registerBody = z.object({
  name: z.string().min(1, 'Please enter your name.').max(100),
  email: emailSchema,
  phone: z.string().min(6, 'Please enter a valid mobile number.').max(30),
  password: z.string().min(6, 'Password must be at least 6 characters.').max(200),
});
const referralBody = z.object({
  name: z.string().min(1, 'Please enter your name.').max(100),
  email: emailSchema,
  phone: z.string().min(6, 'Please enter a valid mobile number.').max(30),
  password: z.string().min(6, 'Password must be at least 6 characters.').max(200),
  referral_code: z.string().min(3).max(30),
});
const forgotBody = z.object({ email: emailSchema });
const resetBody = z.object({ email: emailSchema, code: code6, password: z.string().min(1).max(200) });
const changeRequestBody = z.object({ current_password: z.string().min(1).max(200) });
const changeConfirmBody = z.object({ code: code6, password: z.string().min(1).max(200) });

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly passwords: PasswordService,
    private readonly people: PeopleService,
  ) {}

  private where(req: Request): Where {
    return {
      ip: clientIp(req),
      device: String(req.body?.device ?? '').slice(0, 200) || deviceFrom(req),
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 400),
      token: bearer(req),
    };
  }

  /** Step 1. Ten tries a minute from one address: enough for a typo, useless for guessing. */
  @Public()
  @RateLimit(10, 60)
  @Post('password')
  async signIn(@Req() req: Request, @Body() body: unknown) {
    const input = parse(signInBody, body);
    return this.auth.signIn(input.email, input.password, input.door, this.where(req));
  }

  /** Send real SMS verification OTP to mobile number during registration */
  @Public()
  @RateLimit(10, 60)
  @Post('phone-otp/send')
  async sendPhoneOtp(@Body() body: unknown) {
    const input = parse(z.object({ phone: z.string().min(7).max(30) }), body);
    return this.auth.sendPhoneOtp(input.phone);
  }

  /** Direct registration for solo individual users */
  @Public()
  @RateLimit(10, 60)
  @Post('register-individual')
  async registerIndividual(@Req() req: Request, @Body() body: unknown) {
    const input = parse(registerBody, body);
    return this.auth.registerIndividual(input, this.where(req));
  }

  /** Referral registration for event organizer members */
  @Public()
  @RateLimit(10, 60)
  @Post('register-referral')
  async registerReferral(@Req() req: Request, @Body() body: unknown) {
    const input = parse(referralBody, body);
    return this.auth.registerReferral(input, this.where(req));
  }

  /** Step 2 for admins. */
  @Stage('email_code')
  @RateLimit(20, 60)
  @Post('code/verify')
  async verifyCode(@Req() req: Request, @CurrentSession() session: Session, @Body() body: unknown) {
    const { code } = parse(codeBody, body);
    return this.auth.verifyCode(session, code, this.where(req));
  }

  @Stage('email_code')
  @RateLimit(5, 60)
  @Post('code/resend')
  async resend(@CurrentSession() session: Session) {
    await this.auth.resendCode(session);
    return { ok: true };
  }

  /** Step 3, only for accounts that set up an authenticator themselves. */
  @Stage('totp')
  @RateLimit(20, 60)
  @Post('totp/verify')
  async verifyTotp(@Req() req: Request, @CurrentSession() session: Session, @Body() body: unknown) {
    const { code } = parse(z.object({ code: z.string().trim().min(6).max(20) }), body);
    return this.auth.verifyTotp(session, code, this.where(req));
  }

  @Stage('any')
  @Post('signout')
  async signOut(@Req() req: Request, @CurrentSession() session: Session) {
    await this.auth.signOut(session, this.where(req));
    return { ok: true };
  }

  /** Start-up and every sync: is this device still allowed in? */
  @Get('me')
  async me(@CurrentSession() session: Session) {
    return this.auth.whoAmI(session);
  }

  // ---------------------------------------------------------------- passwords
  /**
   * "Set or reset password" and the first-time setup both start here. The answer is always the
   * same, whether or not the address exists.
   */
  @Public()
  @RateLimit(5, 60)
  @Post('password/forgot')
  async forgot(@Body() body: unknown) {
    const { email } = parse(forgotBody, body);
    await this.passwords.sendCode(email, 'reset');
    return { ok: true };
  }

  @Public()
  @RateLimit(10, 60)
  @Post('password/reset')
  async reset(@Req() req: Request, @Body() body: unknown) {
    const { email, code, password } = parse(resetBody, body);
    const lock = await this.passwords.lockout(email);
    if (lock.locked) {
      return { ok: false, error: `Too many tries. Please wait ${lock.minutesLeft} minutes and try again.` };
    }
    // The rules are checked before the code is spent, so a password that is too short does not
    // cost someone their one-time code.
    const problems = await this.passwords.problems(password);
    if (problems.length) throw new DomainError(problems[0]!, 400, 'policy');

    let personId: string;
    try {
      personId = await this.passwords.useCode(email, code, 'reset');
    } catch (e) {
      await this.passwords.record({ email, ok: false, reason: 'wrong reset code', ip: clientIp(req), counts: true });
      throw e;
    }
    await this.passwords.set(personId, password);
    await this.passwords.afterReset(personId, clientIp(req), email);
    return { ok: true };
  }

  /** Signed in: prove the current password, then confirm by email (AUTH-07). */
  @RateLimit(10, 60)
  @Post('password/change/request')
  async changeRequest(@CurrentSession() session: Session, @Body() body: unknown) {
    const { current_password } = parse(changeRequestBody, body);
    const person = await this.people.byId(session.person_id);
    if (!(await this.passwords.check(person.id, current_password))) {
      await this.passwords.record({ email: person.email, personId: person.id, ok: false, reason: 'wrong current password', counts: true });
      throw new DomainError('That is not your current password.', 400, 'bad_password');
    }
    await this.passwords.sendCode(person.email, 'change', { personId: person.id });
    return { ok: true };
  }

  @RateLimit(10, 60)
  @Post('password/change/confirm')
  async changeConfirm(@Req() req: Request, @CurrentSession() session: Session, @Body() body: unknown) {
    const { code, password } = parse(changeConfirmBody, body);
    const problems = await this.passwords.problems(password);
    if (problems.length) throw new DomainError(problems[0]!, 400, 'policy');
    const person = await this.people.byId(session.person_id);
    const personId = await this.passwords.useCode(person.email, code, 'change');
    if (personId !== person.id) throw new DomainError('That code is not right.', 400, 'bad_code');
    await this.passwords.set(person.id, password);
    await this.passwords.record({ email: person.email, personId: person.id, ok: true, reason: 'password changed', ip: clientIp(req), counts: false });
    return { ok: true };
  }

  /** The rules the app shows while someone types a new password. */
  @Public()
  @Get('policy')
  async policy() {
    return this.passwords.policy();
  }
}

/** Android · Chrome, from the user agent, when the app did not send its own label. */
function deviceFrom(req: Request): string {
  const ua = String(req.headers['user-agent'] ?? '');
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Mac/i.test(ua) ? 'macOS'
    : /Windows/i.test(ua) ? 'Windows' : /Linux/i.test(ua) ? 'Linux' : 'Other';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox/.test(ua) ? 'Firefox' : /Chrome/.test(ua) ? 'Chrome'
    : /Safari/.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${browser}`;
}

export { SETUP_MINUTES };
