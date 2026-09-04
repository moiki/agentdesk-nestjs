import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AgentModule } from './agent/agent.module';
import { AuthModule } from './auth/auth.module';
import { ENV } from './common/constants';
import { HealthController } from './health/health.controller';
import { LlmModule } from './llm/llm.module';
import { PrismaModule } from './prisma/prisma.module';
import { SignupModule } from './signup/signup.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { TenantModule } from './tenant/tenant.module';
import { TicketsModule } from './tickets/tickets.module';
import { TracingModule } from './tracing/tracing.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      { ttl: ENV.THROTTLE_TTL_MS, limit: ENV.THROTTLE_LIMIT },
    ]),
    PrismaModule,
    TenancyModule,
    AuthModule,
    SignupModule,
    TenantModule,
    TicketsModule,
    LlmModule,
    AgentModule,
    TracingModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
