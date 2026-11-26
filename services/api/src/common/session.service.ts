/**
 * Device sessions — one row per signed-in browser, which is what "Active sessions" lists and what
 * "Sign out everywhere" revokes.
 *
 * The browser holds a random 256-bit token; only its SHA-256 reaches the database, so the rows are
 * useless to anyone who gets a copy of them. Every request checks the session against the security
 * policy: revoked, expired, idle too long, or stuck half-way through sign-in all end the same way —
 * 401 and sign in again.
 *
 * The lookup is one indexed read and is deliberately not cached: "sign out everywhere" has to mean
 * the next request, not the one after the cache expires. The security policy is cached instead —
 * it changes once in a while, and saving it clears the entry.
 */
import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from './cache.service';
import { newToken, sha256 } from './crypto';
import { DbService } from './db.service';
import { unauthorized } from './errors';

export type AuthStage = 'password' | 'email_code' | 'totp' | 'ready';

export interface Session {
  id: string;
  person_id: string;
  company_id: string | null;
  role: 'super_admin' | 'client_admin' | 'staff' | 'individual' | 'organizer';
  stage: AuthStage;
  portal: 'super_admin' | 'client_admin' | 'staff' | 'individual' | 'organizer' | null;
  device: string;
  expires_at: string;
  last_seen_at: string;
  suspended: boolean;
  suspended_reason: string;
  active: boolean;
  access_ends_on: string | null;
  event_ends_on: string | null;
}

@Injectable()
export class SessionService {
  private readonly log = new Logger('Session');
  constructor(private readonly db: DbService, private readonly cache: CacheService) {}

  /** Opens a session and returns the token — the only time it exists outside the browser. */
  async create(input: {
    personId: string;
    stage: AuthStage;
    portal: string | null;
    device: string;
    ip: string | null;
    userAgent: string;
    days: number;
  }): Promise<{ token: string; id: string }> {
    // If super admin, restrict active sessions to at most 2.
    // When the 3rd session logs in, revoke the first (oldest) logged in device.
    const person = await this.db.one<{ role: string }>(`select role::text as role from people where id = $1`, [input.personId]);
    if (person?.role === 'super_admin') {
      const oldest = await this.db.query<{ id: string }>(
        `select id from device_sessions
          where person_id = $1 and revoked_at is null
          order by created_at desc offset 1`,
        [input.personId],
      );
      for (const row of oldest) {
        await this.db.query(`update device_sessions set revoked_at = now() where id = $1`, [row.id]);
      }
    }

    const token = newToken();
    const row = await this.db.one<{ id: string }>(
      `insert into device_sessions (person_id, token_hash, stage, portal, device, ip, user_agent, expires_at)
       values ($1, $2, $3::auth_stage, $4::app_role, $5, $6, $7, now() + make_interval(days => $8))
       returning id`,
      [input.personId, sha256(token), input.stage, input.portal, input.device.slice(0, 200), input.ip,
        input.userAgent.slice(0, 400), Math.max(1, input.days)],
    );
    return { token, id: row!.id };
  }

  /** The session behind a bearer token, or null. Does not enforce anything — `require` does. */
  async find(token: string): Promise<Session | null> {
    return this.db.one<Session>(
      `select s.id, s.person_id, s.stage::text as stage, s.portal::text as portal, s.device,
              s.expires_at, s.last_seen_at, p.company_id, p.role::text as role, p.active,
              coalesce(to_char(p.access_ends_on, 'YYYY-MM-DD'),
                       to_char(p.event_ends_on, 'YYYY-MM-DD'),
                       to_char(e.ends_on, 'YYYY-MM-DD')) as access_ends_on,
              coalesce(to_char(p.event_ends_on, 'YYYY-MM-DD'),
                       to_char(e.ends_on, 'YYYY-MM-DD')) as event_ends_on,
              coalesce(c.suspended, false) as suspended, coalesce(c.suspended_reason, '') as suspended_reason
         from device_sessions s
         join people p on p.id = s.person_id
    left join events e on e.id = p.default_event_id or e.organizer_id = p.id
    left join companies c on c.id = p.company_id
        where s.token_hash = $1 and s.revoked_at is null
        order by e.ends_on desc limit 1`,
      [sha256(token)],
    );
  }

  /**
   * The session this request may act on, or an error saying why not. `stage` says how far
   * sign-in must have got: 'ready' for everything except the sign-in steps themselves.
   */
  async require(token: string | undefined, stage: AuthStage | 'any' = 'ready'): Promise<Session> {
    if (!token) throw unauthorized('Please sign in.');
    const session = await this.find(token);
    if (!session) throw unauthorized('This device was signed out. Please sign in again.');

    const policy = await this.policy();
    const now = Date.now();
    if (new Date(session.expires_at).getTime() <= now) {
      await this.revoke(session.id);
      throw unauthorized('This sign-in has expired. Please sign in again.');
    }
    // Super Admin security constraints: max 2 active sessions & strict 5-minute inactivity auto-logout
    if (session.role === 'super_admin') {
      const idleFor = (now - new Date(session.last_seen_at).getTime()) / 60_000;
      if (idleFor > 5) {
        await this.revoke(session.id);
        throw unauthorized('You were signed out after 5 minutes of inactivity for security. Sign in again to continue.');
      }
    } else if (policy.idle_timeout_minutes > 0 && session.role !== 'staff' && session.role !== 'individual') {
      const idleFor = (now - new Date(session.last_seen_at).getTime()) / 60_000;
      if (idleFor > policy.idle_timeout_minutes) {
        await this.revoke(session.id);
        throw unauthorized('You were signed out after a quiet spell. Sign in again to continue.');
      }
    }
    if (!session.active) throw unauthorized('This account can no longer sign in.');

    // 24-hour grace period check: supports both attendees (access_ends_on) and organizers (event_ends_on)
    const cutoff = session.access_ends_on || session.event_ends_on;
    if (cutoff) {
      const today = new Date().toISOString().slice(0, 10);
      const cleanCutoff = String(cutoff).slice(0, 10);
      const d = new Date(cleanCutoff + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      const graceDate = d.toISOString().slice(0, 10);
      if (today > graceDate) {
        throw unauthorized(`This account's access and 24-hour export grace period ended on ${graceDate}.`);
      }
    }
    if (session.suspended) {
      throw unauthorized(`This account is suspended. ${session.suspended_reason || 'Please contact WeTano.'}`);
    }
    if (stage !== 'any' && session.stage !== stage) {
      throw unauthorized(session.stage === 'ready' ? 'Please sign in again.' : 'Please finish signing in.');
    }
    return session;
  }

  /** Moves a session on a step: password → emailed code → authenticator → ready. */
  async setStage(id: string, stage: AuthStage): Promise<void> {
    await this.db.query(`update device_sessions set stage = $2::auth_stage, last_seen_at = now() where id = $1`, [id, stage]);
  }

  /** "Last seen" for the idle timeout and the device list; written at most once a minute. */
  async touch(session: Session, where: { ip: string | null; device?: string; location?: string }): Promise<void> {
    if (Date.now() - new Date(session.last_seen_at).getTime() < 60_000) return;
    try {
      await this.db.query(
        `update device_sessions
            set last_seen_at = now(),
                ip = coalesce($2, ip),
                device = case when $3 <> '' then $3 else device end,
                location = case when $4 <> '' then $4 else location end
          where id = $1`,
        [session.id, where.ip, (where.device ?? '').slice(0, 200), (where.location ?? '').slice(0, 120)],
      );
    } catch (err: any) {
      this.log.warn(`Session touch failed: ${err.message}`);
    }
  }

  async revoke(id: string): Promise<void> {
    await this.db.query(`update device_sessions set revoked_at = now() where id = $1 and revoked_at is null`, [id]);
  }

  async revokeOthers(personId: string, keepId: string | null): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `update device_sessions set revoked_at = now()
        where person_id = $1 and revoked_at is null and id is distinct from $2
        returning id`,
      [personId, keepId],
    );
    return rows.length;
  }

  async revokeAllFor(personId: string): Promise<void> {
    await this.db.query(`update device_sessions set revoked_at = now() where person_id = $1 and revoked_at is null`, [personId]);
  }

  /** The policy is read on every request, so it is cached for a minute. */
  async policy(): Promise<{ idle_timeout_minutes: number; device_session_days: number; lockout_attempts: number; lockout_minutes: number }> {
    const cached = await this.cache.get<Awaited<ReturnType<SessionService['policy']>>>('security:policy');
    if (cached) return cached;
    const row = await this.db.one<{ idle_timeout_minutes: number; device_session_days: number; lockout_attempts: number; lockout_minutes: number }>(
      `select idle_timeout_minutes, device_session_days, lockout_attempts, lockout_minutes from security_policy where id = 'current'`,
    );
    const policy = row ?? { idle_timeout_minutes: 30, device_session_days: 30, lockout_attempts: 5, lockout_minutes: 15 };
    await this.cache.set('security:policy', policy, 60);
    return policy;
  }
}
