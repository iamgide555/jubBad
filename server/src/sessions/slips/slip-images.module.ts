import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { SlipImagesService } from './slip-images.service.js';

@Module({
  imports: [PrismaModule],
  providers: [SlipImagesService],
  exports: [SlipImagesService],
})
export class SlipImagesModule {}
