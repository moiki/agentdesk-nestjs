import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Identity-layer user lookups.
 *
 * `findByEmail` is a PLATFORM operation (used at login, before any tenant
 * context exists): it intentionally queries the unscoped base client, since
 * the email is globally unique and the tenant is not yet known. Everything
 * else in the system stays tenant-scoped via TenantScopedPrismaService.
 */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }
}
