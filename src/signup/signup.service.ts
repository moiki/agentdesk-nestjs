import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { tenantContextStore } from '../tenancy/tenant-context';
import { TenantScopedPrismaService } from '../tenancy/tenant-scoped-prisma.service';
import { SignupDto } from './dto/signup.dto';

export interface SignupResult {
  tenantId: string;
  adminUserId: string;
  plan: string;
}

/**
 * Self-service tenant onboarding. There is NO active tenant context yet, so:
 *  1. A tenantId is generated up front and the Tenant is created through the
 *     scoped client (Tenant is an admin/registry model — never scoped).
 *  2. The admin User is created inside `tenantContextStore.run(...)` so the
 *     scoping extension stamps the correct tenantId — no unscoped bypass.
 * Both writes share one transaction: signup is all-or-nothing.
 */
@Injectable()
export class SignupService {
  constructor(private readonly scopedPrisma: TenantScopedPrismaService) {}

  async signup(dto: SignupDto): Promise<SignupResult> {
    if (dto.plan && dto.plan !== 'FREE') {
      throw new BadRequestException(
        'Only the FREE plan is available in the MVP',
      );
    }

    const tenantId = randomUUID();
    const passwordHash = await hash(dto.adminPassword, 10);

    try {
      const adminUserId = await tenantContextStore.run({ tenantId }, () =>
        this.scopedPrisma.prisma.$transaction(async (tx) => {
          await tx.tenant.create({
            data: {
              id: tenantId,
              name: dto.companyName,
              slug: dto.workspaceName,
              plan: dto.plan ?? 'FREE',
            },
          });

          const admin = await tx.user.create({
            data: {
              email: dto.adminEmail,
              passwordHash,
              role: 'ADMIN',
              tenantId,
            },
          });

          return admin.id;
        }),
      );

      return { tenantId, adminUserId, plan: dto.plan ?? 'FREE' };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          'Email or workspace slug already registered',
        );
      }
      throw error;
    }
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}
