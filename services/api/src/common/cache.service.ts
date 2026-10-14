/**
 * Cache, sessions-in-front-of-the-database and rate limiting.
 *
 * With REDIS_URL set this is Redis. Without it the same interface runs on an in-process Map, which
 * is enough for one node and keeps a development machine free of extra services. Nothing else in
 * the code knows which of the two it is talking to.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import { loadEnv } from './env';

interface Entry { value: string; expires: number }

@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly log = new Logger('Cache');
  private readonly memory = new Map<string, Entry>();
  /** Rate-limit windows, when there is no Redis to share them. */
  private readonly counters = new Map<string, number>();
  private redis: Redis | null = null;
  readonly driver: 'redis' | 'memory';

  constructor() {
    const url = loadEnv().REDIS_URL;
    if (url) {
      // Required lazily so a deployment without Redis never loads the client.
      const { Redis: Client } = require('ioredis') as typeof import('ioredis');
      this.redis = new Client(url, { maxRetriesPerRequest: 2, lazyConnect: false });
      this.redis.on('error', (e: Error) => this.log.warn(`Redis: ${e.message}`));
      this.driver = 'redis';
    } else {
      this.driver = 'memory';
    }
    setInterval(() => this.sweep(), 60_000).unref();
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => {});
  }

  private sweep() {
    const now = Date.now();
    for (const [k, e] of this.memory) if (e.expires <= now) this.memory.delete(k);
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = this.redis ? await this.redis.get(key) : this.live(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const raw = JSON.stringify(value);
    if (this.redis) await this.redis.set(key, raw, 'EX', Math.max(1, Math.round(ttlSeconds)));
    else this.memory.set(key, { value: raw, expires: Date.now() + ttlSeconds * 1000 });
  }

  async del(...keys: string[]): Promise<void> {
    if (!keys.length) return;
    if (this.redis) await this.redis.del(...keys);
    else for (const k of keys) this.memory.delete(k);
  }

  /** Everything under a prefix — used when a person's permissions change. */
  async clearPrefix(prefix: string): Promise<void> {
    if (this.redis) {
      const found = await this.redis.keys(`${prefix}*`);
      if (found.length) await this.redis.del(...found);
      return;
    }
    for (const k of this.memory.keys()) if (k.startsWith(prefix)) this.memory.delete(k);
  }

  private live(key: string): string | null {
    const e = this.memory.get(key);
    if (!e) return null;
    if (e.expires <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return e.value;
  }

  /**
   * Fixed-window counter: `allowed` false means the caller should be refused.
   *
   * With Redis the window is shared by every node. Without it, counting happens in this process —
   * which is right for one server and is why a deployment behind more than one should set
   * REDIS_URL. What must survive a restart is not counted here anyway: the sign-in lockout is
   * worked out from `login_events` in the database.
   */
  async take(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
    const window = Math.floor(Date.now() / (windowSeconds * 1000));
    const slot = `rl:${key}:${window}`;
    const resetIn = windowSeconds - Math.floor((Date.now() / 1000) % windowSeconds);

    if (this.redis) {
      const hits = await this.redis.incr(slot);
      if (hits === 1) await this.redis.expire(slot, windowSeconds);
      return { allowed: hits <= limit, remaining: Math.max(0, limit - hits), retryAfter: resetIn };
    }

    const hits = (this.counters.get(slot) ?? 0) + 1;
    this.counters.set(slot, hits);
    if (hits === 1) setTimeout(() => this.counters.delete(slot), windowSeconds * 1000).unref();
    return { allowed: hits <= limit, remaining: Math.max(0, limit - hits), retryAfter: resetIn };
  }
}
