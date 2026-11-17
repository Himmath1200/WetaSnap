import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { configureApp } from './server';
import { CacheService } from './common/cache.service';
import { DbService } from './common/db.service';
import { loadEnv } from './common/env';

async function bootstrap() {
  const env = loadEnv();
  const log = new Logger('Bootstrap');

  const { app } = await configureApp();

  // Fail loudly at start-up rather than on the first request.
  await app.get(DbService).ping();

  await app.listen(env.PORT, '0.0.0.0');
  log.log(`WeTa Snap API on http://localhost:${env.PORT}  ·  db ok  ·  cache ${app.get(CacheService).driver}  ·  storage ${env.STORAGE_DRIVER}`);
}

bootstrap().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
