import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Caller } from '../../common/db.service';
import { Me, RateLimit, Roles } from '../../common/guards';
import { parse, uuid } from '../../common/validation';
import { ContactsService } from './contacts.service';

/**
 * Contacts are the de-duplicated people behind the leads. Staff see the ones they met (the
 * row-level policy takes care of that); admins see the company's.
 */
@Controller('v1/contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @RateLimit(120, 60)
  @Get()
  search(@Me() me: Caller, @Query('q') q = '', @Query('limit') limit = '50') {
    return this.contacts.search(me, String(q).slice(0, 200), Math.min(100, Math.max(1, Number(limit) || 50)));
  }

  @Get(':id')
  detail(@Me() me: Caller, @Param('id') id: string) {
    return this.contacts.detail(me, parse(uuid, id));
  }

  @Post('notes')
  addNote(@Me() me: Caller, @Body() body: unknown) {
    const input = parse(z.object({
      contact_id: uuid.optional(),
      lead_id: uuid.optional(),
      body: z.string().trim().min(1, 'is required').max(5000),
    }).refine((v) => v.contact_id || v.lead_id, 'needs a contact or a lead'), body);
    return this.contacts.addNote(me, input);
  }

  @Roles('client_admin')
  @Post('merge')
  async merge(@Me() me: Caller, @Body() body: unknown) {
    const input = parse(z.object({ keep: uuid, merge: uuid }), body);
    await this.contacts.merge(me, input.keep, input.merge);
    return { ok: true };
  }
}
