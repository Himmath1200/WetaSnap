import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Caller } from '../../common/db.service';
import { Me, Roles } from '../../common/guards';
import { idList, isoDate, parse, uuid } from '../../common/validation';
import { CatalogueService } from './catalogue.service';

const eventBody = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1, 'is required').max(200),
  starts_on: isoDate,
  ends_on: isoDate,
  venue: z.string().trim().max(200).default(''),
  booth: z.string().trim().max(100).default(''),
  status: z.enum(['open', 'closed']).default('open'),
  description: z.string().max(2000).default(''),
  time_zone: z.string().max(60).default('UTC'),
  template_id: uuid.nullable().default(null),
});

const fieldBody = z.object({
  id: uuid.optional(),
  template_id: uuid,
  key: z.string().max(40).default(''),
  label: z.string().trim().min(1, 'is required').max(100),
  type: z.enum(['text', 'email', 'phone', 'link', 'choice', 'longtext']).default('text'),
  options: z.array(z.string().max(100)).max(50).default([]),
  required: z.boolean().default(false),
  ai_hint: z.string().max(500).default(''),
  filled_by: z.enum(['ai', 'staff']).default('ai'),
  sort_order: z.number().int().min(0).max(999).optional(),
});

const templateBody = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1, 'is required').max(100),
  description: z.string().max(500).default(''),
  is_default: z.boolean().default(false),
  copy_from: uuid.optional(),
});

const tagBody = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1, 'is required').max(40),
  colour: z.enum(['green', 'blue', 'amber', 'red', 'purple', 'slate']).default('green'),
});

const attachmentBody = z.object({
  name: z.string().trim().min(1).max(200),
  mime: z.string().max(100).default('application/octet-stream'),
  data: z.string().max(14_000_000),
});

@Controller('v1')
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  // ---------------------------------------------------------------- events
  @Get('events')
  events(@Me() me: Caller) {
    return this.catalogue.events(me);
  }

  @Roles('client_admin')
  @Post('events')
  saveEvent(@Me() me: Caller, @Body() body: unknown) {
    return this.catalogue.saveEvent(me, parse(eventBody, body));
  }

  @Roles('client_admin')
  @Post('events/:id/attachments')
  addAttachment(@Me() me: Caller, @Param('id') id: string, @Body() body: unknown) {
    return this.catalogue.addAttachment(me, parse(uuid, id), parse(attachmentBody, body));
  }

  @Roles('client_admin')
  @Delete('events/:id/attachments/:attachmentId')
  removeAttachment(@Me() me: Caller, @Param('id') id: string, @Param('attachmentId') attachmentId: string) {
    return this.catalogue.removeAttachment(me, parse(uuid, id), parse(uuid, attachmentId));
  }

  // ---------------------------------------------------------------- fields & templates
  /** `?event_id=` for scanning, `?template_id=` for the editor. */
  @Get('fields')
  fields(@Me() me: Caller, @Query('event_id') eventId?: string, @Query('template_id') templateId?: string) {
    if (templateId) return this.catalogue.fieldsOfTemplate(me, parse(uuid, templateId));
    return this.catalogue.fieldsForEvent(me, eventId ? parse(uuid, eventId) : null);
  }

  @Roles('client_admin')
  @Post('fields')
  saveField(@Me() me: Caller, @Body() body: unknown) {
    return this.catalogue.saveField(me, parse(fieldBody, body));
  }

  @Roles('client_admin')
  @Delete('fields/:id')
  async deleteField(@Me() me: Caller, @Param('id') id: string) {
    await this.catalogue.deleteField(me, parse(uuid, id));
    return { ok: true };
  }

  @Roles('client_admin')
  @Post('fields/reorder')
  async reorder(@Me() me: Caller, @Body() body: unknown) {
    const { ids } = parse(z.object({ ids: idList(200) }), body);
    await this.catalogue.reorderFields(me, ids);
    return { ok: true };
  }

  @Get('templates')
  templates(@Me() me: Caller) {
    return this.catalogue.templates(me);
  }

  @Roles('client_admin')
  @Post('templates')
  saveTemplate(@Me() me: Caller, @Body() body: unknown) {
    return this.catalogue.saveTemplate(me, parse(templateBody, body));
  }

  @Roles('client_admin')
  @Delete('templates/:id')
  async deleteTemplate(@Me() me: Caller, @Param('id') id: string) {
    await this.catalogue.deleteTemplate(me, parse(uuid, id));
    return { ok: true };
  }

  // ---------------------------------------------------------------- tags
  @Get('tags')
  tags(@Me() me: Caller) {
    return this.catalogue.tags(me);
  }

  @Roles('client_admin')
  @Post('tags')
  saveTag(@Me() me: Caller, @Body() body: unknown) {
    return this.catalogue.saveTag(me, parse(tagBody, body));
  }

  @Roles('client_admin')
  @Delete('tags/:id')
  async deleteTag(@Me() me: Caller, @Param('id') id: string) {
    await this.catalogue.deleteTag(me, parse(uuid, id));
    return { ok: true };
  }
}
