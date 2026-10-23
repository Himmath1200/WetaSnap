/**
 * The scanning pipeline, end to end.
 *
 *            Capture ──▶ Quality check ──┬── poor ──▶ ask for a retake
 *                                        └── good ──▶ Crop ──▶ OCR ──▶ AI extraction
 *                                                               │
 *   Follow-up ◀── Lead score ◀── Enrichment ◀── Contact ◀── Duplicate check
 *                                                 ▲              │
 *                                                 └── merge ◀────┘
 *                                       (Validation and normalisation sit between
 *                                        extraction and the duplicate check.)
 *
 * The first half (through extraction) answers the request, because the person at the stand is
 * standing there waiting for the fields to appear. The second half (contact, score, follow-up)
 * runs as a job, because nobody is waiting for it and it must survive a dropped connection.
 */
import { Injectable, Logger } from '@nestjs/common';
import { DbService, type Caller } from '../../common/db.service';
import { DomainError } from '../../common/errors';
import { QueueService } from '../../common/queue.service';
import { StorageService } from '../../common/storage.service';
import { CatalogueService } from '../catalogue/catalogue.service';
import { cropCard, normaliseImage, type CropRect } from './pipeline/crop';
import { normaliseFields } from './pipeline/normalise';
import { measure, type Quality } from './pipeline/quality';
import { mergeReads, readWithClaude, readWithOcr, type FieldSpec, type ReadFields } from './pipeline/readers';

export interface ReadRequest {
  image: Buffer;
  mime: string;
  eventId: string | null;
  crop?: CropRect | null;
  /** What the device already read on its own, so the server only adds to it. */
  onDevice?: ReadFields;
  language?: string;
}

export interface ReadOutcome {
  fields: ReadFields;
  quality: Quality;
  engines: string[];
  cropped: boolean;
  ms: number;
  /** Raw OCR lines for the live popup in the app (empty when only AI answered). */
  raw_text: string;
}

@Injectable()
export class PipelineService {
  private readonly log = new Logger('Pipeline');

  constructor(
    private readonly db: DbService,
    private readonly catalogue: CatalogueService,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
  ) {}

  /** Steps 2 to 7: everything the person at the stand waits for. */
  async read(me: Caller, request: ReadRequest): Promise<ReadOutcome> {
    const started = Date.now();

    // 2 · quality. A poor image is refused here rather than read badly.
    const quality = await measure(request.image);
    if (quality.verdict === 'poor' && !request.crop) {
      throw new DomainError(quality.reasons[0] ?? 'That photo is too unclear to read.', 422, 'poor_quality');
    }

    // 3 · crop — the rectangle the app took. Without one the image is kept whole: the app has
    // already cut the card out, and guessing again would shave printed lines off it.
    const cropped = await cropCard(request.image, request.crop ?? null);

    // 4+5 · OCR and AI, in parallel: whichever is configured answers.
    const fields = await this.catalogue.fieldsForEvent(me, request.eventId);
    const specs: FieldSpec[] = fields.map((f) => ({
      key: f.key, label: f.label, type: f.type, options: f.options, ai_hint: f.ai_hint, required: f.required,
    }));
    const aiAllowed = await this.aiAllowed(me);
    const [ocr, ai] = await Promise.all([
      readWithOcr(cropped.image, 'image/jpeg', specs, request.language),
      aiAllowed ? readWithClaude(cropped.image, 'image/jpeg', specs) : Promise.resolve(null),
    ]);

    // 6+7 · validate and normalise, then put the device's own reading underneath.
    const merged = mergeReads(ocr, ai);
    const normalised = normaliseFields(merged, fields);
    const result: ReadFields = { ...(request.onDevice ?? {}) };
    for (const [key, value] of Object.entries(normalised)) {
      const existing = result[key];
      const confidence = value.confidence ?? 0.6;
      if (!existing || confidence > (existing.confidence ?? 0) + 0.05) {
        result[key] = { value: value.value, confidence, ...(value.reason ? { reason: value.reason } : {}) };
      }
    }

    if (ocr || ai) {
      await this.db.query(
        `insert into usage_events (company_id, person_id, kind, meta) values ($1, $2, 'ai_read', $3)`,
        [me.companyId, me.personId, { engines: [ocr?.engine, ai?.engine].filter(Boolean) }]);
    }

    return {
      fields: result,
      quality,
      engines: [ocr?.engine, ai?.engine].filter(Boolean) as string[],
      cropped: cropped.by !== 'none',
      ms: Date.now() - started,
      raw_text: ocr?.text ?? '',
    };
  }

  /** Just the quality check, for an uploaded file the camera never saw. */
  async checkQuality(image: Buffer): Promise<Quality> {
    return measure(image);
  }

  /**
   * Stores one side of a card: the image goes to object storage, the row to business_cards, and
   * the rest of the pipeline to the queue. The lead already exists — the device created it.
   */
  async storeCard(me: Caller, input: {
    leadId: string; side: 'front' | 'back'; image: Buffer; mime: string; crop?: CropRect | null;
  }): Promise<{ stored: boolean; quality: Quality }> {
    if (!me.companyId) throw new DomainError('WeTano accounts do not capture cards.', 400);

    const lead = await this.db.asOne<{ id: string }>(me,
      'select id from leads where id = $1 and deleted_at is null', [input.leadId]);
    if (!lead) throw new DomainError('That lead no longer exists on the server.', 404);

    const quality = await measure(input.image);
    const prepared = input.side === 'front'
      ? await cropCard(input.image, input.crop ?? null)
      : { ...(await normaliseImage(input.image)), applied: null, by: 'none' as const };

    const key = StorageService.cardKey(me.companyId, input.leadId, input.side);
    await this.storage.put(key, prepared.image, 'image/jpeg');

    await this.db.as(me, async (c) => {
      await c.query(
        `insert into business_cards (company_id, lead_id, side, storage_key, mime, size_bytes, width, height,
                                     stage, quality, crop)
         values ($1, $2, $3::photo_side, $4, 'image/jpeg', $5, $6, $7, 'cropped', $8, $9)
         on conflict (lead_id, side) where lead_id is not null do update
            set storage_key = excluded.storage_key, size_bytes = excluded.size_bytes,
                width = excluded.width, height = excluded.height, quality = excluded.quality,
                crop = excluded.crop, stage = 'cropped', created_at = now()`,
        [me.companyId, input.leadId, input.side, key, prepared.image.length, prepared.width, prepared.height,
          JSON.stringify(quality), JSON.stringify(prepared.applied ?? {})]);
      await c.query(
        `update leads set has_photo = (has_photo or $2 = 'front'), has_back_photo = (has_back_photo or $2 = 'back')
          where id = $1`, [input.leadId, input.side]);
    });

    // The background re-read only pays off for the front, and only when a reader is configured.
    if (input.side === 'front') {
      await this.queue.add('card.read', { lead_id: input.leadId, key }, {
        companyId: me.companyId, dedupeKey: `card.read:${input.leadId}`,
      });
    }
    return { stored: true, quality };
  }

  /** AI-01: a company can turn cloud reading off, and then only the local reader is used. */
  private async aiAllowed(me: Caller): Promise<boolean> {
    if (!me.companyId) return false;
    const row = await this.db.one<{ cloud_ai_enabled: boolean }>(
      'select cloud_ai_enabled from companies where id = $1', [me.companyId]);
    return !!row?.cloud_ai_enabled;
  }
}
