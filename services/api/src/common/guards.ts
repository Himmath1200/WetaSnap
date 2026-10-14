/**
 * Who may call what. Three small guards, applied globally, so a new endpoint is protected unless
 * it says otherwise rather than the other way round:
 *
 *   AuthGuard       every route needs a valid session, except those marked @Public()
 *   RolesGuard      @Roles('client_admin') and friends; WeTano accounts pass admin checks
 *   RateLimitGuard  @RateLimit({ limit, windowSeconds }) per IP, and per account where it helps
 */
import {
  CanActivate, ExecutionContext, Injectable, SetMetadata, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { CacheService } from './cache.service';
import { keyFor } from './crypto';
import type { Caller } from './db.service';
import { DomainError, forbidden } from './errors';
import { SessionService, type AuthStage, type Session } from './session.service';

export const PUBLIC = 'wetasnap:public';
export const ROLES = 'wetasnap:roles';
export const STAGE = 'wetasnap:stage';
export const RATE = 'wetasnap:rate';

/** No session needed: sign-in, password reset, health. */
export const Public = () => SetMetadata(PUBLIC, true);
export const Roles = (...roles: Caller['role'][]) => SetMetadata(ROLES, roles);
/** For the sign-in steps, which run on a session that is not 'ready' yet. */
export const Stage = (stage: AuthStage | 'any') => SetMetadata(STAGE, stage);
export const RateLimit = (limit: number, windowSeconds: number) => SetMetadata(RATE, { limit, windowSeconds });

export interface RequestWithCaller extends Request {
  caller?: Caller;
  session?: Session;
}

/** The signed-in person, for controllers: `@Me() me: Caller`. */
export const Me = createParamDecorator((_data: unknown, ctx: ExecutionContext): Caller => {
  const req = ctx.switchToHttp().getRequest<RequestWithCaller>();
  if (!req.caller) throw forbidden('Please sign in.');
  return req.caller;
});

/** The session row itself, where a route needs the device (sign-in steps, "this device"). */
export const CurrentSession = createParamDecorator((_data: unknown, ctx: ExecutionContext): Session => {
  const req = ctx.switchToHttp().getRequest<RequestWithCaller>();
  if (!req.session) throw forbidden('Please sign in.');
  return req.session;
});

/** The caller's address, as far as any proxy in front of us is honest about it. */
export const clientIp = (req: Request): string | null => {
  const header = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  const ip = header || req.ip || req.socket.remoteAddress || '';
  return ip ? ip.replace(/^::ffff:/, '') : null;
};

export const bearer = (req: Request): string | undefined => {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() || undefined : undefined;
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly sessions: SessionService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithCaller>();
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const stage = this.reflector.getAllAndOverride<AuthStage | 'any'>(STAGE, targets) ?? 'ready';
    const session = await this.sessions.require(bearer(req), stage);
    req.session = session;
    req.caller = { personId: session.person_id, companyId: session.company_id, role: session.role };
    // Keeps the idle timeout honest and the device list fresh, without a write per request.
    void this.sessions.touch(session, { ip: clientIp(req) });
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<Caller['role'][]>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (!allowed?.length) return true;
    const req = ctx.switchToHttp().getRequest<RequestWithCaller>();
    const role = req.caller?.role;
    if (!role) throw forbidden('Please sign in.');
    // WeTano runs the service: anything a client admin may do, they may do too.
    if (role === 'super_admin') return true;
    if (!allowed.includes(role)) {
      throw forbidden(allowed.includes('super_admin') && allowed.length === 1
        ? 'That is a WeTano screen.'
        : 'You do not have permission to do this.');
    }
    return true;
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  /** Anything not marked gets a generous ceiling, so one client cannot flood the service. */
  private static readonly DEFAULT = { limit: 600, windowSeconds: 60 };

  constructor(private readonly reflector: Reflector, private readonly cache: CacheService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithCaller>();
    const rule = this.reflector.getAllAndOverride<{ limit: number; windowSeconds: number }>(RATE, [ctx.getHandler(), ctx.getClass()])
      ?? RateLimitGuard.DEFAULT;
    const who = req.caller?.personId ?? keyFor(clientIp(req) ?? 'unknown');
    const route = `${ctx.getClass().name}.${ctx.getHandler().name}`;
    const { allowed, retryAfter } = await this.cache.take(`${route}:${who}`, rule.limit, rule.windowSeconds);
    if (!allowed) {
      ctx.switchToHttp().getResponse().setHeader('Retry-After', String(retryAfter));
      throw new DomainError('Too many requests just now. Please wait a moment and try again.', 429, 'rate_limited');
    }
    return true;
  }
}
