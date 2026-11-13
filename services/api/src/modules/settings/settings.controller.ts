import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import type { Caller } from '../../common/db.service';
import { Me, Public, RateLimit, Roles, clientIp } from '../../common/guards';
import type { RequestWithCaller } from '../../common/guards';
import { parse, uuid } from '../../common/validation';
import { SettingsService } from './settings.service';

const companyPatch = z.object({
  name: z.string().trim().min(1).max(200),
  logo_url: z.string().max(500).nullable(),
  country: z.string().max(100),
  headquarters: z.string().max(500),
  default_language: z.string().regex(/^[a-z]{2}(-[A-Za-z]{2,8})?$/),
  time_zone: z.string().max(60),
  consent_text: z.string().max(2000),
  retention_leads_months: z.number().int().min(1).max(120),
  retention_photos_months: z.number().int().min(1).max(120),
  cloud_ai_enabled: z.boolean(),
  offline_pack_enabled: z.boolean(),
  follow_up_message: z.string().max(4000).nullable(),
  follow_up_auto: z.boolean(),
}).partial();

const errorReport = z.object({
  action: z.string().max(120).default(''),
  name: z.string().max(60).default('Error'),
  message: z.string().max(500).default(''),
  cause: z.string().max(500).default(''),
  where: z.string().max(200).default(''),
  route: z.string().max(200).default(''),
  stack: z.string().max(2000).default(''),
  at: z.string().max(40).default(''),
  device: z.string().max(200).default(''),
  online: z.boolean().default(true),
});

@Controller('v1')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('company')
  company(@Me() me: Caller) {
    return this.settings.company(me);
  }

  @Roles('client_admin', 'super_admin')
  @Patch('company')
  saveCompany(@Me() me: Caller, @Body() body: unknown) {
    return this.settings.saveCompany(me, parse(companyPatch, body));
  }

  // ---------------------------------------------------------------- CRM
  @Get('connections')
  connections(@Me() me: Caller) {
    return this.settings.connections(me);
  }

  @Get('connectors')
  async connectors(@Me() me: Caller) {
    return { allowed: await this.settings.allowedConnectors(me) };
  }

  @Roles('client_admin', 'super_admin')
  @Post('connections')
  connect(@Me() me: Caller, @Body() body: unknown) {
    const input = parse(z.object({
      kind: z.enum(['zoho_crm', 'zoho_bigin', 'hubspot', 'salesforce', 'webhook']),
      webhook_url: z.string().max(500).optional(),
    }), body);
    return this.settings.connect(me, input.kind, { webhook_url: input.webhook_url });
  }

  @Roles('client_admin', 'super_admin')
  @Put('connections/:id')
  async saveConnection(@Me() me: Caller, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({
      record_type: z.string().max(100).default('Lead'),
      mode: z.enum(['auto', 'manual']).default('auto'),
      mapping: z.record(z.string().max(40), z.string().max(80)).default({}),
    }), body);
    await this.settings.saveConnection(me, { id: parse(uuid, id), ...input });
    return { ok: true };
  }

  @Roles('client_admin', 'super_admin')
  @Delete('connections/:id')
  async disconnect(@Me() me: Caller, @Param('id') id: string) {
    await this.settings.disconnect(me, parse(uuid, id));
    return { ok: true };
  }

  @Roles('client_admin', 'super_admin')
  @RateLimit(10, 60)
  @Post('connections/test')
  test(@Me() me: Caller) {
    return this.settings.sendTest(me);
  }

  // ---------------------------------------------------------------- billing
  @Roles('client_admin')
  @Get('subscription')
  subscription(@Me() me: Caller) {
    return this.settings.mySubscription(me);
  }

  @Roles('client_admin')
  @Get('invoices')
  invoices(@Me() me: Caller, @Query('company_id') companyId = '', @Query('status') status = '') {
    return this.settings.invoices(me, {
      company_id: companyId ? parse(uuid, companyId) : undefined,
      status: ['draft', 'sent', 'paid', 'overdue', 'cancelled'].includes(String(status)) ? String(status) : '',
    });
  }

  // ---------------------------------------------------------------- error reports
  /** Public: an error worth reporting is often one that stopped the person signing in. */
  @Public()
  @RateLimit(30, 60)
  @Post('client-errors')
  async clientError(@Req() req: Request, @Body() body: unknown) {
    const report = parse(errorReport, body);
    await this.settings.recordClientError((req as RequestWithCaller).caller ?? null, report, clientIp(req));
    return { ok: true };
  }
}
