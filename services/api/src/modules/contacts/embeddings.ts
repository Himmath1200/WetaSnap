/**
 * Vectors for semantic contact search (pgvector).
 *
 * The default needs no network and no model file: a contact is turned into character n-grams,
 * hashed into 256 buckets and normalised. It is not a language model — it will not know that
 * "tractors" and "agricultural machinery" are related — but it is excellent at what this search is
 * actually asked for: the half-remembered name, the misspelled company, "that Dutch seed person".
 * It is deterministic, instant, and never sends a contact's details anywhere.
 *
 * EMBEDDINGS_DRIVER=voyage swaps in a hosted model for real semantic matching; the column, the
 * index and the query stay the same, so only the vectors have to be rebuilt.
 */
import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { loadEnv } from '../../common/env';

export const DIMENSIONS = 256;
export const LOCAL_MODEL = 'ngram-hash-256-v1';

const log = new Logger('Embeddings');

export interface ContactText {
  full_name?: string; org_name?: string; job_title?: string;
  email?: string; country?: string; website?: string;
}

/** One line per contact, in a fixed order, so the same person always hashes the same way. */
export const contactToText = (c: ContactText) =>
  [c.full_name, c.job_title, c.org_name, (c.email ?? '').split('@')[1], c.country]
    .map((p) => (p ?? '').trim().toLowerCase())
    .filter(Boolean)
    .join(' · ');

export async function embed(text: string): Promise<{ vector: number[]; model: string }> {
  const env = loadEnv();
  if (env.EMBEDDINGS_DRIVER === 'voyage' && env.VOYAGE_API_KEY) {
    const hosted = await voyage(text, env.VOYAGE_API_KEY);
    if (hosted) return hosted;
  }
  return { vector: localVector(text), model: LOCAL_MODEL };
}

/** Character 3-grams and whole words, hashed into buckets, then L2-normalised. */
export function localVector(text: string): number[] {
  const clean = ` ${text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}@. ]/gu, ' ').replace(/\s+/g, ' ').trim()} `;
  const vector = new Array<number>(DIMENSIONS).fill(0);
  const put = (token: string, weight: number) => {
    const digest = createHash('sha1').update(token).digest();
    const bucket = ((digest[0]! << 8) | digest[1]!) % DIMENSIONS;
    const sign = digest[2]! % 2 === 0 ? 1 : -1;
    vector[bucket] = (vector[bucket] ?? 0) + sign * weight;
  };
  for (let i = 0; i + 3 <= clean.length; i += 1) put(clean.slice(i, i + 3), 1);
  for (const word of clean.split(' ')) if (word.length > 2) put(`w:${word}`, 2);

  const length = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / length);
}

async function voyage(text: string, key: string): Promise<{ vector: number[]; model: string } | null> {
  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'voyage-3-lite', input: [text], output_dimension: DIMENSIONS }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    const body = await res.json() as { data?: { embedding?: number[] }[] };
    const vector = body.data?.[0]?.embedding;
    if (!vector || vector.length !== DIMENSIONS) throw new Error('unexpected shape');
    return { vector, model: 'voyage-3-lite' };
  } catch (e) {
    log.warn(`hosted embeddings failed, using the local ones: ${(e as Error).message}`);
    return null;
  }
}

/** pgvector's literal form: '[0.1,0.2,…]'. */
export const toVectorLiteral = (vector: number[]) => `[${vector.map((v) => v.toFixed(6)).join(',')}]`;

export const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;      // both sides are normalised, so the dot product is the cosine
};
