import { Module } from '@nestjs/common';
import { LeadsIoService } from './leads-io.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  controllers: [LeadsController],
  providers: [LeadsService, LeadsIoService],
  exports: [LeadsService, LeadsIoService],
})
export class LeadsModule {}
