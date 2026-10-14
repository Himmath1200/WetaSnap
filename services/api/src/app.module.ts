import { Controller, Get, Module } from '@nestjs/common';
import { CacheService } from './common/cache.service';
import { CommonModule } from './common/common.module';
import { DbService } from './common/db.service';
import { Public } from './common/guards';
import { QueueService } from './common/queue.service';
import { loadEnv } from './common/env';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogueModule } from './modules/catalogue/catalogue.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { DevModule } from './modules/dev/dev.module';
import { LeadsModule } from './modules/leads/leads.module';
import { MeModule } from './modules/me/me.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ScanModule } from './modules/scan/scan.module';
import { SettingsModule } from './modules/settings/settings.module';
import { SupportModule } from './modules/support/support.module';
import { TeamModule } from './modules/team/team.module';

/** `GET /health` — is the database reachable, and what is waiting in the queue. No secrets. */
@Controller()
class HealthController {
  constructor(private readonly db: DbService, private readonly cache: CacheService, private readonly queue: QueueService) {}

  @Public()
  @Get('health')
  async health() {
    const started = Date.now();
    await this.db.ping();
    return {
      ok: true,
      db_ms: Date.now() - started,
      cache: this.cache.driver,
      jobs: await this.queue.counts(),
      version: '1.0.0',
    };
  }
}

@Module({
  imports: [
    CommonModule,
    AuthModule,
    MeModule,
    CatalogueModule,
    LeadsModule,
    ScanModule,
    ContactsModule,
    TeamModule,
    SettingsModule,
    NotificationsModule,
    SupportModule,
    AdminModule,
    // The development inbox (/dev/mail) is never built into a production deployment.
    ...(loadEnv().NODE_ENV === 'production' ? [] : [DevModule]),
  ],
  controllers: [HealthController],
})
export class AppModule {}
