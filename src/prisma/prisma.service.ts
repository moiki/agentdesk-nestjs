import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { ENV } from '../common/constants';

/**
 * Base Prisma client. This is the LOW-LEVEL, unscoped client — it should only
 * be injected into platform/admin code (e.g. the Tenant registry). Tenant
 * domain code must use TenantScopedPrismaService instead.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    if (!ENV.DATABASE_URL) {
      throw new Error('DATABASE_URL is required');
    }
    super({
      adapter: new PrismaPg({ connectionString: ENV.DATABASE_URL }),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
