import { Module } from '@nestjs/common';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { ContactsModule } from '../contacts/contacts.module';
import { PipelineService } from './pipeline.service';
import { ScanController } from './scan.controller';

@Module({
  imports: [CatalogueModule, ContactsModule],
  controllers: [ScanController],
  providers: [PipelineService],
  exports: [PipelineService],
})
export class ScanModule {}
