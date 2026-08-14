import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TenantScopedPrismaService } from './tenant-scoped-prisma.service';

@Module({
  imports: [PrismaModule],
  providers: [TenantScopedPrismaService],
  exports: [TenantScopedPrismaService],
})
export class TenancyModule {}
