import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentSession, Me, RateLimit, Roles } from '../../common/guards';
import type { Caller } from '../../common/db.service';
import type { Session } from '../../common/session.service';
import { parse, uuid } from '../../common/validation';
import { MeService } from './me.service';

const profileBody = z.object({ name: z.string().trim().max(200).default(''), phone: z.string().trim().max(40).default('') });
const avatarBody = z.object({
  data: z.string().max(6_000_000).nullable(),
  mime: z.string().max(60).default('image/jpeg'),
});
const codeBody = z.object({ code: z.string().trim().min(6).max(10) });
const policyBody = z.object({
  min_length: z.number().int().min(8).max(128),
  require_upper: z.boolean(),
  require_number: z.boolean(),
  require_symbol: z.boolean(),
  expiry_days: z.number().int().min(0).max(3650),
  reuse_block: z.number().int().min(0).max(24),
  lockout_attempts: z.number().int().min(1).max(50),
  lockout_minutes: z.number().int().min(1).max(1440),
  idle_timeout_minutes: z.number().int().min(0).max(1440),
  device_session_days: z.number().int().min(1).max(365),
}).partial();

@Controller('v1/me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Put('profile')
  async updateProfile(@Me() me: Caller, @Body() body: unknown) {
    await this.me.updateProfile(me, parse(profileBody, body));
    return { ok: true };
  }

  @RateLimit(20, 60)
  @Put('avatar')
  async avatar(@Me() me: Caller, @Body() body: unknown) {
    const input = parse(avatarBody, body);
    const url = await this.me.saveAvatar(me, input.data ? { data: input.data, mime: input.mime } : null);
    return { avatar_url: url };
  }

  // ---------------------------------------------------------------- devices & history
  @Get('sessions')
  async sessions(@Me() me: Caller, @CurrentSession() session: Session) {
    return this.me.devices(me, session.id);
  }

  @Delete('sessions/:id')
  async revoke(@Me() me: Caller, @Param('id') id: string) {
    await this.me.revokeDevice(me, parse(uuid, id));
    return { ok: true };
  }

  @Post('sessions/revoke-others')
  async revokeOthers(@Me() me: Caller, @CurrentSession() session: Session) {
    return { revoked: await this.me.revokeOtherDevices(me, session.id) };
  }

  @Get('history')
  async history(@Me() me: Caller, @Query('person_id') personId?: string) {
    return this.me.history(me, personId ? parse(uuid, personId) : undefined);
  }

  // ---------------------------------------------------------------- policy
  @Get('policy')
  async policy() {
    return this.me.policy();
  }

  @Roles('super_admin')
  @Put('policy')
  async savePolicy(@Me() me: Caller, @Body() body: unknown) {
    return this.me.savePolicy(me, parse(policyBody, body));
  }

  // ---------------------------------------------------------------- authenticator
  @Post('mfa/start')
  async startMfa(@Me() me: Caller) {
    return this.me.startMfa(me);
  }

  @RateLimit(10, 60)
  @Post('mfa/confirm')
  async confirmMfa(@Me() me: Caller, @Body() body: unknown) {
    return this.me.confirmMfa(me, parse(codeBody, body).code);
  }

  @RateLimit(10, 60)
  @Post('mfa/disable')
  async disableMfa(@Me() me: Caller, @Body() body: unknown) {
    await this.me.disableMfa(me, parse(codeBody, body).code);
    return { ok: true };
  }

  @Get('mfa/recovery-codes')
  async recoveryCodes(@Me() me: Caller) {
    return this.me.recoveryStatus(me);
  }

  @Post('mfa/recovery-codes')
  async regenerate(@Me() me: Caller) {
    return this.me.regenerateRecoveryCodes(me);
  }
}
