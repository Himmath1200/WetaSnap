/** The services every feature uses. Global, so no module has to list them one by one. */
import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { CacheService } from './cache.service';
import { DbService } from './db.service';
import { MailService } from './mail.service';
import { QueueService } from './queue.service';
import { SessionService } from './session.service';
import { SmsService } from './sms.service';
import { StorageService } from './storage.service';

@Global()
@Module({
  providers: [DbService, CacheService, QueueService, StorageService, MailService, SmsService, SessionService, AuditService],
  exports: [DbService, CacheService, QueueService, StorageService, MailService, SmsService, SessionService, AuditService],
})
export class CommonModule {}
