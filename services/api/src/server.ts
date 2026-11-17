import 'reflect-metadata';
import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { CacheService } from './common/cache.service';
import { loadEnv } from './common/env';
import { ApiExceptionFilter } from './common/errors';
import { AuthGuard, RateLimitGuard, RolesGuard } from './common/guards';
import { SessionService } from './common/session.service';

export interface AppInstance {
  app: NestExpressApplication;
  server: express.Express;
}

export async function configureApp(existingExpress?: express.Express): Promise<AppInstance> {
  const env = loadEnv();
  const server = existingExpress ?? express();

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(server),
    {
      logger: env.NODE_ENV === 'production' ? ['error', 'warn', 'log'] : ['error', 'warn', 'log', 'debug'],
      bodyParser: false,
    },
  );

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: env.NODE_ENV === 'production' ? { maxAge: 15_552_000, includeSubDomains: true } : false,
    }),
  );

  app.use('/v1/scan', express.json({ limit: '15mb' }));
  app.use('/v1/leads/import', express.json({ limit: '15mb' }));
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  app.enableCors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Device', 'Accept'],
    exposedHeaders: ['Retry-After'],
    credentials: false,
    maxAge: 86400,
  });

  const reflector = app.get(Reflector);
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalGuards(
    new AuthGuard(reflector, app.get(SessionService)),
    new RolesGuard(reflector),
    new RateLimitGuard(reflector, app.get(CacheService)),
  );
  app.enableShutdownHooks();

  await app.init();

  return { app, server };
}
