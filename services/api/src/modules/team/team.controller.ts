import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import type { Caller } from '../../common/db.service';
import { Me, RateLimit, Roles } from '../../common/guards';
import { email, idList, isoDate, parse, uuid } from '../../common/validation';
import { TeamService } from './team.service';

const inviteBody = z.object({
  email,
  name: z.string().trim().max(200).default(''),
  phone: z.string().trim().max(40).default(''),
  role: z.enum(['staff', 'client_admin']).default('staff'),
  event_ids: idList(50),
  default_event_id: uuid.nullable().default(null),
  access_ends_on: z.union([isoDate, z.null()]).default(null),
  company_id: uuid.optional(),          // WeTano inviting the first admin of a new company
});

const updateBody = z.object({
  name: z.string().trim().max(200).default(''),
  phone: z.string().trim().max(40).default(''),
  role: z.enum(['staff', 'client_admin']),
  event_ids: idList(50),
  default_event_id: uuid.nullable().default(null),
  access_ends_on: z.union([isoDate, z.null()]).default(null),
  active: z.boolean().default(true),
});

@Roles('client_admin', 'organizer')
@Controller('v1/team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  list(@Me() me: Caller) {
    return this.team.list(me);
  }

  @Get('seats')
  seats(@Me() me: Caller) {
    return this.team.seats(me);
  }

  @RateLimit(30, 60)
  @Post('invite')
  invite(@Me() me: Caller, @Body() body: unknown) {
    return this.team.invite(me, parse(inviteBody, body));
  }

  @Put(':id')
  async update(@Me() me: Caller, @Param('id') id: string, @Body() body: unknown) {
    await this.team.update(me, { id: parse(uuid, id), ...parse(updateBody, body) });
    return { ok: true };
  }
}
