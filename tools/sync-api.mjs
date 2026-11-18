import { cpSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const apiSrc = resolve('services/api/dist');
const apiDest = resolve('api/_dist');

if (existsSync(apiSrc)) {
  if (existsSync(apiDest)) rmSync(apiDest, { recursive: true, force: true });
  cpSync(apiSrc, apiDest, { recursive: true });
  console.log('[sync-api] Synced services/api/dist to api/_dist');
}

const webSrc = resolve('apps/web/dist');
const webDest = resolve('dist');

if (existsSync(webSrc)) {
  if (existsSync(webDest)) rmSync(webDest, { recursive: true, force: true });
  cpSync(webSrc, webDest, { recursive: true });
  console.log('[sync-api] Synced apps/web/dist to dist');
}
