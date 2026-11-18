import { cpSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const src = resolve('services/api/dist');
const dest = resolve('api/dist');

if (existsSync(src)) {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  console.log('[sync-api] Synced services/api/dist to api/dist');
} else {
  console.error('[sync-api] Error: services/api/dist does not exist');
  process.exit(1);
}
