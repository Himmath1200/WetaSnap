/**
 * Settings come from the environment and are checked once, at start-up: a missing or malformed
 * value stops the process with a clear message rather than failing on the first request that
 * needs it. Nothing else in the code reads process.env.
 */
import { config as loadDotenv } from 'dotenv';
import { join } from 'node:path';
import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : /^(1|true|yes|on)$/i.test(v)));

const list = z
  .string()
  .default('')
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (the wetasnap_app role).'),
  SERVICE_DATABASE_URL: z.string().min(1, 'SERVICE_DATABASE_URL is required (the wetasnap_service role).'),
  DATABASE_SSL: bool.default(false),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  REDIS_URL: z.string().optional(),

  STORAGE_DRIVER: z.enum(['fs', 's3']).default('fs'),
  STORAGE_DIR: z.string().default('./storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  APP_URL: z.string().default('http://localhost:5173'),
  CORS_ORIGINS: list,

  SECRET_KEY: z.string().min(16, 'SECRET_KEY must be at least 16 characters — generate one with crypto.randomBytes(32).'),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),

  MAIL_DRIVER: z.enum(['log', 'smtp']).default('log'),
  MAIL_FROM: z.string().default('WeTa Snap <no-reply@wetano.com>'),
  SMTP_URL: z.string().optional(),

  // Development only: the password every seeded account uses, so the sign-in page can offer them.
  // Empty in any real deployment, and the dev endpoints are not even loaded there.
  DEV_DEMO_PASSWORD: z.string().default(''),

  OCR_URL: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  EMBEDDINGS_DRIVER: z.enum(['local', 'voyage']).default('local'),
  VOYAGE_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Reads .env once and validates it. Throws with every problem listed, not just the first. */
export function loadEnv(): Env {
  if (cached) return cached;
  loadDotenv({ path: join(__dirname, '..', '..', '.env'), quiet: true });
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`The API cannot start — check services/api/.env\n${problems}\n`);
  }
  cached = parsed.data;
  return cached;
}

export const isProd = () => loadEnv().NODE_ENV === 'production';
