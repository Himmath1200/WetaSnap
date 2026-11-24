import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Caller } from '../../common/db.service';
import { Me, Roles } from '../../common/guards';
import { email, isoDate, parse, uuid } from '../../common/validation';
import { AdminService } from './admin.service';

const connectors = z.array(z.enum(['zoho_crm', 'zoho_bigin', 'hubspot', 'salesforce', 'webhook', 'csv'])).max(6);

const licenceBody = z.object({
  type: z.enum(['trial', 'monthly', 'annual']),
  starts_on: isoDate,
  ends_on: isoDate,
  seats: z.number().int().min(1).max(10_000),
  scans_per_month: z.number().int().min(0).max(1_000_000),
  connectors_allowed: connectors.default(['webhook', 'csv']),
});

const planBody = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1, 'is required').max(80),
  description: z.string().max(500).default(''),
  price_month: z.number().int().min(0).max(100_000_000),
  price_year: z.number().int().min(0).max(100_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/).default('EUR'),
  seats: z.number().int().min(1).max(10_000),
  scans_per_month: z.number().int().min(0).max(1_000_000),
  connectors_allowed: connectors.default(['webhook', 'csv']),
  features: z.array(z.string().max(120)).max(30).default([]),
  active: z.boolean().default(true),
});

const invoiceBody = z.object({
  company_id: uuid,
  plan_id: uuid.nullable().default(null),
  period_start: isoDate,
  period_end: isoDate,
  amount: z.number().int().min(0).max(1_000_000_000),
  tax: z.number().int().min(0).max(1_000_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/).default('EUR'),
  status: z.enum(['draft', 'sent', 'paid', 'overdue', 'cancelled']).default('draft'),
  issued_on: isoDate,
  due_on: isoDate,
  notes: z.string().max(2000).default(''),
});

@Roles('super_admin')
@Controller('v1/admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // ---------------------------------------------------------------- companies
  @Get('companies')
  companies(@Me() me: Caller) {
    return this.admin.companies(me);
  }

  @Get('companies/:id')
  companyDetail(@Me() me: Caller, @Param('id') id: string) {
    return this.admin.companyDetail(me, parse(uuid, id));
  }

  @Post('companies')
  createCompany(@Me() me: Caller, @Body() body: unknown) {
    const input = parse(z.object({
      name: z.string().trim().min(1, 'is required').max(200),
      country: z.string().trim().min(1, 'is required').max(100),
      admin_name: z.string().trim().max(200).default(''),
      admin_email: email,
      licence: licenceBody,
    }), body);
    return this.admin.createCompany(me, input);
  }

  @Post('companies/:id/suspend')
  async suspend(@Me() me: Caller, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ suspended: z.boolean(), reason: z.string().max(500).default('') }), body);
    await this.admin.setSuspended(me, parse(uuid, id), input.suspended, input.reason);
    return { ok: true };
  }

  @Post('companies/:id/scan-limit')
  async scanLimit(@Me() me: Caller, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ action: z.enum(['block', 'overage', 'notify']) }), body);
    await this.admin.setScanLimitAction(me, parse(uuid, id), input.action);
    return { ok: true };
  }

  @Put('companies/:id/licence')
  async licence(@Me() me: Caller, @Param('id') id: string, @Body() body: unknown) {
    await this.admin.updateLicence(me, parse(uuid, id), parse(licenceBody, body));
    return { ok: true };
  }

  @Get('companies/:id/licence-history')
  licenceHistory(@Me() me: Caller, @Param('id') id: string) {
    return this.admin.licenceHistory(me, parse(uuid, id));
  }

  @Put('people/:id/email')
  async updatePersonEmail(@Me() me: Caller, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ email: email, reinvite: z.boolean().default(true) }), body);
    return this.admin.updatePersonEmail(me, parse(uuid, id), input.email, input.reinvite);
  }

  // ---------------------------------------------------------------- usage
  @Get('usage')
  usage(@Me() me: Caller, @Query('month') month?: string) {
    const wanted = /^\d{4}-\d{2}$/.test(String(month)) ? String(month) : new Date().toISOString().slice(0, 7);
    return this.admin.usage(me, wanted);
  }

  @Get('usage/alerts')
  alerts(@Me() me: Caller) {
    return this.admin.usageAlerts(me);
  }

  @Post('usage/alerts')
  saveAlert(@Me() me: Caller, @Body() body: unknown) {
    const input = parse(z.object({
      id: uuid.optional(),
      company_id: uuid.nullable().default(null),
      metric: z.enum(['scans', 'seats', 'storage']).default('scans'),
      threshold_pct: z.number().int().min(1).max(200).default(80),
      active: z.boolean().default(true),
    }), body);
    return this.admin.saveUsageAlert(me, input);
  }

  @Delete('usage/alerts/:id')
  async deleteAlert(@Me() me: Caller, @Param('id') id: string) {
    await this.admin.deleteUsageAlert(me, parse(uuid, id));
    return { ok: true };
  }

  // ---------------------------------------------------------------- plans & billing
  @Get('plans')
  plans(@Me() me: Caller) {
    return this.admin.plans(me);
  }

  @Post('plans')
  savePlan(@Me() me: Caller, @Body() body: unknown) {
    return this.admin.savePlan(me, parse(planBody, body));
  }

  @Delete('plans/:id')
  async deletePlan(@Me() me: Caller, @Param('id') id: string) {
    await this.admin.deletePlan(me, parse(uuid, id));
    return { ok: true };
  }

  @Get('subscriptions')
  subscriptions(@Me() me: Caller) {
    return this.admin.subscriptions(me);
  }

  @Put('subscriptions/:companyId')
  async setSubscription(@Me() me: Caller, @Param('companyId') companyId: string, @Body() body: unknown) {
    const input = parse(z.object({
      plan_id: uuid.nullable().default(null),
      billing_cycle: z.enum(['monthly', 'annual']).default('monthly'),
      renews_on: isoDate,
      auto_renew: z.boolean().default(true),
    }), body);
    await this.admin.setSubscription(me, parse(uuid, companyId), input);
    return { ok: true };
  }

  @Get('invoices')
  invoices(@Me() me: Caller, @Query('company_id') companyId = '', @Query('status') status = '') {
    return this.admin.invoices(me, {
      company_id: companyId ? parse(uuid, companyId) : undefined,
      status: ['draft', 'sent', 'paid', 'overdue', 'cancelled'].includes(String(status)) ? String(status) : '',
    });
  }

  @Post('invoices')
  createInvoice(@Me() me: Caller, @Body() body: unknown) {
    return this.admin.createInvoice(me, parse(invoiceBody, body));
  }

  @Put('invoices/:id/status')
  setInvoiceStatus(@Me() me: Caller, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({
      status: z.enum(['draft', 'sent', 'paid', 'overdue', 'cancelled']),
      paid: z.object({ paid_on: isoDate, paid_by: z.string().max(200).default('') }).nullable().default(null),
    }), body);
    return this.admin.setInvoiceStatus(me, parse(uuid, id), input.status, input.paid);
  }

  // ---------------------------------------------------------------- audit log
  @Get('audit')
  audit(
    @Me() me: Caller,
    @Query('q') q = '',
    @Query('company_id') companyId = '',
    @Query('action') action = '',
    @Query('from') from = '',
    @Query('to') to = '',
  ) {
    return this.admin.auditLog(me, {
      q: String(q).slice(0, 100),
      company_id: companyId ? parse(uuid, companyId) : '',
      action: String(action).slice(0, 60),
      from: /^\d{4}-\d{2}-\d{2}$/.test(String(from)) ? String(from) : '',
      to: /^\d{4}-\d{2}-\d{2}$/.test(String(to)) ? String(to) : '',
    });
  }

  // ---------------------------------------------------------------- individuals
  @Get('individuals')
  listIndividuals(@Me() me: Caller) {
    return this.admin.listIndividuals(me);
  }

  @Put('individuals/:id/plan')
  updateIndividualPlan(@Me() me: Caller, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ plan: z.enum(['free', 'pro']) }), body);
    return this.admin.updateIndividualPlan(me, parse(uuid, id), input.plan);
  }

  @Post('individuals/:id/reset-scans')
  resetIndividualScans(@Me() me: Caller, @Param('id') id: string) {
    return this.admin.resetIndividualScans(me, parse(uuid, id));
  }

  @Put('individuals/:id/status')
  toggleIndividualStatus(@Me() me: Caller, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ active: z.boolean() }), body);
    return this.admin.toggleIndividualStatus(me, parse(uuid, id), input.active);
  }

  @Delete('individuals/:id')
  deleteIndividual(@Me() me: Caller, @Param('id') id: string) {
    return this.admin.deleteIndividual(me, parse(uuid, id));
  }

  @Put('individual-pricing')
  updateIndividualPricing(@Me() me: Caller, @Body() body: unknown) {
    const input = parse(z.object({
      free_scans_limit: z.number().int().min(1).max(1000).optional(),
      pro_price_month: z.number().int().min(1).max(100000).optional(),
      pro_price_year: z.number().int().min(1).max(1000000).optional(),
      currency: z.string().max(3).optional(),
      free_features: z.array(z.string()).optional(),
      pro_features: z.array(z.string()).optional(),
    }), body);
    return this.admin.updateIndividualPricing(me, input);
  }

  // ---------------------------------------------------------------- organizers
  @Get('organizers')
  listOrganizers(@Me() me: Caller) {
    return this.admin.listOrganizers(me);
  }

  @Post('organizers')
  createOrganizer(@Me() me: Caller, @Body() body: unknown) {
    const input = parse(z.object({
      event_id: uuid.optional(),
      event_name: z.string().trim().min(1).max(200),
      starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      venue: z.string().trim().max(200).optional(),
      organizer_name: z.string().trim().min(1).max(100),
      organizer_email: email,
      password: z.string().min(6).max(200).optional(),
      max_logins: z.number().int().min(1).max(10000).default(10),
    }), body);
    return this.admin.createOrganizer(me, input);
  }

  @Put('organizers/:id/logins')
  updateOrganizerLogins(@Me() me: Caller, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ max_logins: z.number().int().min(1).max(10000) }), body);
    return this.admin.updateOrganizerLogins(me, parse(uuid, id), input.max_logins);
  }

  @Get('organizers/:id')
  getOrganizerDetails(@Me() me: Caller, @Param('id') id: string) {
    return this.admin.getOrganizerDetails(me, parse(uuid, id));
  }

  @Post('organizers/:id/events')
  assignOrganizerEvent(
    @Me() me: Caller,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(z.object({
      event_id: uuid.optional(),
      event_name: z.string().trim().min(1).max(200).optional(),
      starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      venue: z.string().trim().max(200).optional(),
      max_logins: z.number().int().min(1).max(10000).optional(),
    }), body);
    return this.admin.assignOrganizerEvent(me, parse(uuid, id), input);
  }

  @Delete('organizers/:id/events/:eventId')
  unassignOrganizerEvent(
    @Me() me: Caller,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
  ) {
    return this.admin.unassignOrganizerEvent(me, parse(uuid, id), parse(uuid, eventId));
  }

  @Put('organizers/:id/event')
  updateOrganizerEvent(@Me() me: Caller, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({
      event_name: z.string().trim().min(1).max(200),
      starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      venue: z.string().trim().max(200).optional(),
      max_logins: z.number().int().min(1).max(10000).optional(),
    }), body);
    return this.admin.updateOrganizerEvent(me, parse(uuid, id), input);
  }

  @Put('organizers/:id/members/:memberId')
  updateOrganizerMember(
    @Me() me: Caller,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Body() body: unknown,
  ) {
    const input = parse(z.object({
      active: z.boolean().optional(),
      name: z.string().trim().max(100).optional(),
      phone: z.string().trim().max(40).optional(),
    }), body);
    return this.admin.updateOrganizerMember(me, parse(uuid, id), parse(uuid, memberId), input);
  }

  @Delete('organizers/:id/members/:memberId')
  deleteOrganizerMember(@Me() me: Caller, @Param('id') id: string, @Param('memberId') memberId: string) {
    return this.admin.deleteOrganizerMember(me, parse(uuid, id), parse(uuid, memberId));
  }
}
