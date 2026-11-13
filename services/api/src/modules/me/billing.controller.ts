import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { Me, Public } from '../../common/guards';
import type { Caller } from '../../common/db.service';
import { parse } from '../../common/validation';
import { MeService } from './me.service';

const upgradeBody = z.object({
  plan: z.enum(['pro']),
  cycle: z.enum(['monthly', 'annual']).default('monthly'),
  paymentMethod: z.string().optional(),
});

@Controller('v1/billing')
export class BillingController {
  constructor(private readonly me: MeService) {}

  @Public()
  @Get('individual-pricing')
  getIndividualPricing() {
    return this.me.getIndividualPricing();
  }

  @Post('upgrade')
  upgrade(@Me() me: Caller, @Body() body: unknown) {
    const input = parse(upgradeBody, body);
    return this.me.upgradePlan(me, input.plan, input.cycle);
  }

  @Post('scan-usage')
  scanUsage(@Me() me: Caller) {
    return this.me.recordScanUsage(me);
  }
}
