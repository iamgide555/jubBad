import { Module } from '@nestjs/common';
import { LineClient } from './line-client.js';

@Module({
  providers: [LineClient],
  exports: [LineClient],
})
export class LineModule {}
