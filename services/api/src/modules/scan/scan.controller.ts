import { Body, Controller, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Caller } from '../../common/db.service';
import { Me, RateLimit } from '../../common/guards';
import { parse, uuid } from '../../common/validation';
import { PipelineService } from './pipeline.service';

/** A 12-megapixel phone photo is about 8 MB; as base64 that is a third more again. */
const imageBase64 = z.string().min(32).max(14_000_000);
const cropRect = z.object({
  x: z.number().min(0).max(20_000),
  y: z.number().min(0).max(20_000),
  w: z.number().min(16).max(20_000),
  h: z.number().min(16).max(20_000),
  rotate: z.number().int().min(-360).max(360).optional(),
}).nullable().optional();

const readBody = z.object({
  image: imageBase64,
  mime: z.string().max(60).default('image/jpeg'),
  event_id: uuid.nullable().default(null),
  crop: cropRect,
  language: z.enum(['en', 'de', 'fr', 'es', 'it', 'nl', 'pt']).optional(),
  on_device: z.record(z.string().max(40), z.object({
    value: z.string().max(500),
    confidence: z.number().min(0).max(1).default(0.5),
    reason: z.string().max(200).optional(),
  })).optional(),
});

const photoBody = z.object({
  lead_id: uuid,
  side: z.enum(['front', 'back']).default('front'),
  image: imageBase64,
  mime: z.string().max(60).default('image/jpeg'),
  crop: cropRect,
});

@Controller('v1/scan')
export class ScanController {
  constructor(private readonly pipeline: PipelineService) {}

  /** Steps 2–7: quality, crop, OCR, AI, validation, normalisation. */
  @RateLimit(60, 60)
  @Post('read')
  read(@Me() me: Caller, @Body() body: unknown) {
    const input = parse(readBody, body);
    return this.pipeline.read(me, {
      image: Buffer.from(input.image, 'base64'),
      mime: input.mime,
      eventId: input.event_id,
      crop: input.crop ?? null,
      onDevice: input.on_device,
      language: input.language,
    });
  }

  /** The quality check on its own, for a file picked from the gallery. */
  @RateLimit(60, 60)
  @Post('quality')
  quality(@Body() body: unknown) {
    const input = parse(z.object({ image: imageBase64 }), body);
    return this.pipeline.checkQuality(Buffer.from(input.image, 'base64'));
  }

  /** Stores the card image against a lead and starts the rest of the pipeline. */
  @RateLimit(120, 60)
  @Post('photo')
  photo(@Me() me: Caller, @Body() body: unknown) {
    const input = parse(photoBody, body);
    return this.pipeline.storeCard(me, {
      leadId: input.lead_id,
      side: input.side,
      image: Buffer.from(input.image, 'base64'),
      mime: input.mime,
      crop: input.crop ?? null,
    });
  }
}
