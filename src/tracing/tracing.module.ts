import { Global, Module } from '@nestjs/common';
import { TracingService } from './tracing.service';

/**
 * Provides the TracingService facade app-wide. A no-op when Langfuse tracing is
 * disabled, so importing this module is always safe.
 */
@Global()
@Module({
  providers: [TracingService],
  exports: [TracingService],
})
export class TracingModule {}
