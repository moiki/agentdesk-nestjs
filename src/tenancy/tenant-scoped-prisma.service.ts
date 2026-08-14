import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createScopedPrisma, ScopedPrismaClient } from './tenant-scoped.prisma';

/**
 * The ONLY tenant-scoped Prisma client exposed to tenant domain code.
 *
 * Wraps the base client with the scoping extension: every operation on a
 * tenant-owned model is forced into the tenant of the active request context
 * (AsyncLocalStorage), making cross-tenant access structurally impossible.
 */
@Injectable()
export class TenantScopedPrismaService {
  readonly prisma: ScopedPrismaClient;

  constructor(prismaService: PrismaService) {
    this.prisma = createScopedPrisma(prismaService);
  }
}
