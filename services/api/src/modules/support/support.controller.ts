import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Caller } from '../../common/db.service';
import { Me, RateLimit, Roles } from '../../common/guards';
import { parse, uuid } from '../../common/validation';
import { SupportService } from './support.service';

@Controller('v1/support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Roles('client_admin')
  @Get()
  list(@Me() me: Caller, @Query('status') status = '', @Query('company_id') companyId = '') {
    return this.support.list(me, {
      status: ['open', 'waiting', 'resolved', 'closed'].includes(String(status)) ? String(status) : '',
      company_id: companyId ? parse(uuid, companyId) : undefined,
    });
  }

  @Roles('client_admin')
  @RateLimit(10, 60)
  @Post()
  open(@Me() me: Caller, @Body() body: unknown) {
    const input = parse(z.object({
      subject: z.string().trim().min(1, 'is required').max(200),
      body: z.string().trim().min(1, 'is required').max(5000),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    }), body);
    return this.support.open(me, input);
  }

  @Roles('client_admin')
  @RateLimit(30, 60)
  @Post(':id/reply')
  reply(@Me() me: Caller, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ body: z.string().trim().min(1, 'is required').max(5000) }), body);
    return this.support.reply(me, parse(uuid, id), input.body);
  }

  @Roles('client_admin')
  @Put(':id/status')
  setStatus(@Me() me: Caller, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({
      status: z.enum(['open', 'waiting', 'resolved', 'closed']),
      assigned_to: z.string().max(200).nullable().default(null),
    }), body);
    return this.support.setStatus(me, parse(uuid, id), input.status, input.assigned_to);
  }
}
