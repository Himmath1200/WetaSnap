import { Module } from '@nestjs/common';
import { DevController } from './dev.controller';

/** Loaded only outside production — see app.module.ts. */
@Module({ controllers: [DevController] })
export class DevModule {}
