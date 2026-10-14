/**
 * Object storage for card images, avatars and event attachments.
 *
 * Two drivers behind one interface: `fs` writes under STORAGE_DIR (what a single server or a
 * development machine wants) and `s3` talks to any S3-compatible service (AWS, MinIO, Hetzner…)
 * with signed requests made here, so there is no SDK to keep up to date.
 *
 * Keys are built by the caller and always start with the company: companies/<id>/… . Nothing is
 * ever served straight from storage — reads go through the API, which checks who is asking.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { loadEnv } from './env';
import { DomainError } from './errors';

export interface StoredObject { key: string; size: number; mime: string }

@Injectable()
export class StorageService {
  private readonly log = new Logger('Storage');
  private readonly env = loadEnv();
  readonly driver: 'fs' | 's3' = this.env.STORAGE_DRIVER;
  private readonly root = resolve(this.env.STORAGE_DIR);

  /** Refuses anything that could climb out of the bucket or the folder. */
  private safe(key: string): string {
    const clean = normalize(key).replace(/^(\.\.(\/|\\|$))+/, '').replace(/\\/g, '/');
    if (!clean || clean.startsWith('/') || clean.includes('..')) throw new DomainError('That file name is not allowed.', 400);
    return clean;
  }

  async put(key: string, body: Buffer, mime = 'application/octet-stream'): Promise<StoredObject> {
    const k = this.safe(key);
    if (this.driver === 's3') await this.s3('PUT', k, body, mime);
    else {
      const file = join(this.root, k);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, body);
    }
    return { key: k, size: body.length, mime };
  }

  async get(key: string): Promise<Buffer | null> {
    const k = this.safe(key);
    try {
      if (this.driver === 's3') return await this.s3('GET', k);
      return await readFile(join(this.root, k));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.log.warn(`read ${k}: ${(e as Error).message}`);
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    const k = this.safe(key);
    if (this.driver === 's3') return (await this.get(k)) !== null;
    return stat(join(this.root, k)).then(() => true, () => false);
  }

  async delete(key: string): Promise<void> {
    const k = this.safe(key);
    try {
      if (this.driver === 's3') await this.s3('DELETE', k);
      else await rm(join(this.root, k), { force: true });
    } catch (e) {
      this.log.warn(`delete ${k}: ${(e as Error).message}`);
    }
  }

  /** Everything under a prefix — when a company or a lead is erased for good. */
  async deletePrefix(prefix: string): Promise<void> {
    const p = this.safe(prefix);
    if (this.driver === 'fs') {
      await rm(join(this.root, p), { recursive: true, force: true });
      return;
    }
    this.log.warn(`deletePrefix(${p}) on S3 needs a lifecycle rule or a list call — left to the bucket policy.`);
  }

  // ---------------------------------------------------------------- S3 (signature v4)
  private async s3(method: 'GET' | 'PUT' | 'DELETE', key: string, body?: Buffer, mime?: string): Promise<Buffer> {
    const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = this.env;
    if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
      throw new DomainError('Object storage is not configured (S3_* settings).', 500);
    }
    const region = S3_REGION ?? 'us-east-1';
    const url = new URL(`${S3_ENDPOINT.replace(/\/$/, '')}/${S3_BUCKET}/${key}`);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256').update(body ?? Buffer.alloc(0)).digest('hex');

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(mime ? { 'content-type': mime } : {}),
    };
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonical = [
      method,
      url.pathname,
      '',
      ...Object.keys(headers).sort().map((h) => `${h}:${headers[h]}`),
      '',
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${date}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
    const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
    const signing = hmac(hmac(hmac(hmac(`AWS4${S3_SECRET_ACCESS_KEY}`, date), region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signing).update(toSign).digest('hex');

    const res = await fetch(url, {
      method,
      headers: {
        ...headers,
        Authorization: `AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body: body ?? undefined,
    });
    if (res.status === 404) {
      const e = new Error('not found') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    }
    if (!res.ok) throw new DomainError(`Object storage refused the request (${res.status}).`, 502);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Where a card image lives. One place that decides, so nothing else builds paths by hand. */
  static cardKey(companyId: string, leadId: string, side: 'front' | 'back', ext = 'jpg') {
    return `companies/${companyId}/cards/${leadId}/${side}.${ext}`;
  }

  static avatarKey(personId: string, ext = 'jpg') {
    return `people/${personId}/avatar.${ext}`;
  }

  static attachmentKey(companyId: string, eventId: string, id: string, ext: string) {
    return `companies/${companyId}/events/${eventId}/${id}.${ext}`;
  }
}

/** Keeps `join` honest on Windows, where `sep` is a backslash. */
export const storagePath = (root: string, key: string) => join(root, ...key.split('/')).split(sep).join(sep);
