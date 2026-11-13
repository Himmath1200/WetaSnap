import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingController } from './billing.controller';
import { FilesController } from './files.controller';
import { MeController } from './me.controller';
import { MeService } from './me.service';

@Module({
  imports: [AuthModule],
  controllers: [MeController, FilesController, BillingController],
  providers: [MeService],
  exports: [MeService],
})
export class MeModule {}
