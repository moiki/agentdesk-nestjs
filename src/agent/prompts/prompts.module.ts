import { Module } from '@nestjs/common';
import { TenantPromptService } from './tenant-prompt.service';

@Module({
  providers: [TenantPromptService],
  exports: [TenantPromptService],
})
export class PromptsModule {}
