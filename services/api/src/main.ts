/**
 * The API process. Everything that protects the service is set up here, once, so no route can
 * forget it:
 *
 *   helmet            conservative security headers; this serves JSON, not pages
 *   CORS              only the origins named in CORS_ORIGINS, with credentials off (bearer tokens)
 *   body limits       15 MB, because a card photo arrives as base64, and 100 KB for anything else
 *   AuthGuard         every route needs a session unless it says @Public()
 *   RolesGuard        @Roles(...) on top of that
 *   RateLimitGuard    per route and per caller, in Redis when there is one
 *   ApiExceptionFilter  one shape for every error, and never a stack trace to a browser
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { CacheService } from './common/cache.service';
import { DbService } from './common/db.service';
import { loadEnv } from './common/env';
import { ApiExceptionFilter } from './common/errors';
import { AuthGuard, RateLimitGuard, RolesGuard } from './common/guards';
import { SessionService } from './common/session.service';

async function bootstrap() {
  const env = loadEnv();
  const log = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: env.NODE_ENV === 'production' ? ['error', 'warn', 'log'] : ['error', 'warn', 'log', 'debug'],
    bodyParser: false,
  });

  app.disable('x-powered-by');
  app.set('trust proxy', 1);                       // one reverse proxy in front of us
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: env.NODE_ENV === 'production' ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  }));
  // A card photo is sent as base64; everything else is small, and says so.
  app.use('/v1/scan', express.json({ limit: '15mb' }));
  app.use('/v1/leads/import', express.json({ limit: '15mb' }));
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  app.enableCors({
    origin: env.NODE_ENV !== 'production' ? true : (env.CORS_ORIGINS.length ? env.CORS_ORIGINS : [env.APP_URL]),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Device'],
    exposedHeaders: ['Retry-After'],
    credentials: false,
    maxAge: 600,
  });

  const reflector = app.get(Reflector);
  app.useGlobalFilters(new ApiExceptionFilter());
  // Input is checked by zod, per route, in the controller — see common/validation.ts.
  app.useGlobalGuards(
    new AuthGuard(reflector, app.get(SessionService)),
    new RolesGuard(reflector),
    new RateLimitGuard(reflector, app.get(CacheService)),
  );
  app.enableShutdownHooks();

  // Fail loudly at start-up rather than on the first request.
  await app.get(DbService).ping();

  await app.listen(env.PORT, '0.0.0.0');
  log.log(`WeTa Snap API on http://localhost:${env.PORT}  ·  db ok  ·  cache ${app.get(CacheService).driver}  ·  storage ${env.STORAGE_DRIVER}`);
}

bootstrap().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
