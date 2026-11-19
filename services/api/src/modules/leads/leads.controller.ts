import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { Caller } from '../../common/db.service';
import { Me, RateLimit, Roles } from '../../common/guards';
import { idList, isoDate, parse, uuid } from '../../common/validation';
import { LeadsIoService } from './leads-io.service';
import { LeadsService } from './leads.service';

const filtersSchema = z.object({
  q: z.string().max(200).default(''),
  event_ids: idList(50),
  captured_by: idList(100),
  tag_ids: idList(50),
  status: z.enum(['waiting', 'synced', 'in_crm', 'check', '']).default(''),
  interest: z.enum(['wetaloop', 'wetanalytics', 'other', 'hot', 'warm', 'cold', '']).default(''),
  from: z.union([isoDate, z.literal('')]).default(''),
  to: z.union([isoDate, z.literal('')]).default(''),
  import_batch_id: uuid.optional(),
});

const fieldValue = z.object({
  value: z.string().max(2000).default(''),
  by: z.enum(['ai', 'offline', 'person', 'qr']).default('person'),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().max(300).optional(),
});

const leadBody = z.object({
  id: uuid,
  event_id: uuid,
  captured_by: uuid.optional(),
  captured_by_name: z.string().max(200).default(''),
  device: z.string().max(200).default(''),
  source: z.enum(['camera', 'upload', 'manual']).default('manual'),
  fields: z.record(z.string().max(40), fieldValue).default({}),
  interest: z.enum(['wetaloop', 'wetanalytics', 'other', 'hot', 'warm', 'cold']).nullable().default(null),
  notes: z.string().max(5000).default(''),
  consent: z.boolean().default(false),
  consent_version: z.number().int().min(1).max(10_000).default(1),
  consent_at: z.string().datetime().nullable().default(null),
  status: z.enum(['waiting', 'synced', 'in_crm', 'check']).default('synced'),
  has_photo: z.boolean().default(false),
  has_back_photo: z.boolean().default(false),
  tag_ids: idList(50),
  import_batch_id: uuid.nullable().optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

@Controller('v1/leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService, private readonly io: LeadsIoService) {}

  @Post('search')
  list(@Me() me: Caller, @Body() body: unknown) {
    return this.leads.list(me, parse(filtersSchema, body));
  }

  @Post('by-ids')
  byIds(@Me() me: Caller, @Body() body: unknown) {
    const { ids } = parse(z.object({ ids: idList(500) }), body);
    return this.leads.byIds(me, ids);
  }

  @Get('counters')
  counters(@Me() me: Caller, @Query('event_id') eventId?: string) {
    return this.leads.counters(me, eventId ? parse(uuid, eventId) : null);
  }

  @Get('exists')
  async exists(@Me() me: Caller, @Query('event_id') eventId: string, @Query('email') email = '', @Query('phone') phone = '') {
    const at = await this.leads.exists(me, parse(uuid, eventId), String(email).slice(0, 200), String(phone).slice(0, 40));
    return { at };
  }

  /** The sync endpoint devices call, possibly many times for the same lead. */
  @RateLimit(300, 60)
  @Post('sync')
  sync(@Me() me: Caller, @Body() body: unknown) {
    return this.leads.sync(me, parse(leadBody, body));
  }

  @Put(':id')
  save(@Me() me: Caller, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(leadBody.extend({ resend: z.boolean().default(false) }), body);
    if (input.id !== parse(uuid, id)) {
      return this.leads.save(me, { ...input, id: parse(uuid, id) }, input.resend);
    }
    return this.leads.save(me, input, input.resend);
  }

  @Delete(':id')
  async remove(@Me() me: Caller, @Param('id') id: string) {
    await this.leads.remove(me, parse(uuid, id));
    return { ok: true };
  }

  @Post(':id/restore')
  async restore(@Me() me: Caller, @Param('id') id: string) {
    await this.leads.restore(me, parse(uuid, id));
    return { ok: true };
  }

  @Get('recycle-bin')
  recycleBin(@Me() me: Caller) {
    return this.leads.recycleBin(me);
  }

  // ---------------------------------------------------------------- bulk
  @Post('bulk/tag')
  async bulkTag(@Me() me: Caller, @Body() body: unknown) {
    const input = parse(z.object({ ids: idList(1000), add: idList(50), remove: idList(50) }), body);
    await this.leads.bulkTag(me, input.ids, input.add, input.remove);
    return { ok: true };
  }

  @Post('bulk/delete')
  async bulkDelete(@Me() me: Caller, @Body() body: unknown) {
    const { ids } = parse(z.object({ ids: idList(1000) }), body);
    await this.leads.bulkDelete(me, ids);
    return { ok: true };
  }

  @Roles('client_admin')
  @Post('bulk/resend')
  async bulkResend(@Me() me: Caller, @Body() body: unknown) {
    const { ids } = parse(z.object({ ids: idList(1000) }), body);
    await this.leads.bulkResend(me, ids);
    return { ok: true };
  }

  // ---------------------------------------------------------------- in and out
  @Roles('client_admin')
  @RateLimit(10, 60)
  @Post('import')
  importLeads(@Me() me: Caller, @Body() body: unknown) {
    const input = parse(z.object({
      rows: z.array(z.object({
        fields: z.record(z.string().max(40), z.string().max(500)),
        duplicate: z.boolean().default(false),
      })).max(5000),
      event_id: uuid,
      tag_ids: idList(50),
      file_name: z.string().max(300).default('import.xlsx'),
    }), body);
    return this.io.import(me, input.rows, input.event_id, input.tag_ids, input.file_name);
  }

  @Roles('client_admin')
  @Get('imports')
  imports(@Me() me: Caller) {
    return this.io.history(me);
  }

  @RateLimit(20, 60)
  @Post('export')
  async exportCsv(@Me() me: Caller, @Body() body: unknown, @Res() res: Response) {
    const csv = await this.io.exportCsv(me, parse(filtersSchema, body));
    res.setHeader('Content-Type', 'text/csv;charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }

  // ---------------------------------------------------------------- devices
  @Post('outbox')
  async outbox(@Me() me: Caller, @Body() body: unknown) {
    const input = parse(z.object({
      device: z.string().max(200).default(''),
      waiting: z.number().int().min(0).max(100_000).default(0),
      oldest: z.string().datetime().nullable().default(null),
    }), body);
    await this.leads.reportOutbox(me, input.device, input.waiting, input.oldest);
    return { ok: true };
  }
}
