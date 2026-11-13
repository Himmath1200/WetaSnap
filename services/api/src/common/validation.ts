/**
 * Input checking. Every request body, query and parameter goes through a zod schema, so a
 * controller only ever sees data of the shape it declared — and the person gets one plain sentence
 * about what was wrong rather than a stack trace.
 */
import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { z, type ZodType } from 'zod';
import { DomainError } from './errors';

@Injectable()
export class ZodPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    return parse(this.schema, value);
  }
}

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.filter((p) => typeof p === 'string').join('.');
  const what = issue?.message ?? 'is not valid';
  throw new DomainError(where ? `${label(where)}: ${lower(what)}` : what, 400, 'invalid_input');
}

const label = (path: string) => {
  const last = path.split('.').pop() ?? path;
  return last.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
};
const lower = (s: string) => s.replace(/^./, (c) => c.toLowerCase());

// ---------------------------------------------------------------- shared shapes
const baseId = z.string().trim().refine(
  (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) || (v.length > 0 && v.length <= 64),
  'must be an id',
);

export const uuid = z.preprocess((v) => (v === '' ? null : v), baseId.nullish()) as unknown as z.ZodType<string>;
export const flexibleId = z.preprocess((v) => (v === '' ? null : v), baseId.nullish()) as unknown as z.ZodType<string>;
export const email = z.string().trim().toLowerCase().email('must be a valid email address').max(200);
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)');
export const shortText = (max = 200) => z.string().trim().max(max);
export const code6 = z.string().trim().regex(/^\d{6}$/, 'must be the 6 digits from the email');
/** Never trust a client-sent list to be short. */
export const idList = (max = 500) => z.array(z.string().trim().min(1).max(64)).max(max).default([]);
