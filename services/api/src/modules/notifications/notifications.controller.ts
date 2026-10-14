import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Caller } from '../../common/db.service';
import { Me } from '../../common/guards';
import { idList, parse } from '../../common/validation';
import { NotificationsService } from './notifications.service';

@Controller('v1/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  feed(@Me() me: Caller) {
    return this.notifications.feed(me);
  }

  @Post('read')
  async read(@Me() me: Caller, @Body() body: unknown) {
    const { ids } = parse(z.object({ ids: idList(200) }), body);
    await this.notifications.markRead(me, ids);
    return { ok: true };
  }

  /** The browser's push subscription; null removes it. */
  @Post('push')
  async push(@Me() me: Caller, @Body() body: unknown) {
    const input = parse(z.object({
      subscription: z.object({
        endpoint: z.string().url().max(500),
        keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(200) }),
      }).nullable(),
      device: z.string().max(120).default(''),
    }), body);
    await this.notifications.savePushSubscription(me, input.subscription, input.device);
    return { ok: true };
  }
}
