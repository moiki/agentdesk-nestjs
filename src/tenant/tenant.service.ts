import { Injectable } from '@nestjs/common';
import { TicketStatus } from '../generated/prisma/client';
import { getTenantId } from '../tenancy/tenant-context';
import { TenantScopedPrismaService } from '../tenancy/tenant-scoped-prisma.service';

/**
 * Tenant-facing profile API. Resolves the tenant from the authenticated
 * context (AuthContextMiddleware → AsyncLocalStorage) and returns the registry
 * data plus a few live metrics so the frontend can build an interactive
 * workspace view. The `Tenant` model is platform-owned (never scoped), while
 * the metric counts go through the scoped client, which forces the active
 * tenant on every query.
 */
@Injectable()
export class TenantService {
  constructor(private readonly scopedPrisma: TenantScopedPrismaService) {}

  async profile() {
    const tenantId = getTenantId()!;

    const tenant = await this.scopedPrisma.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    const [ticketCount, openTicketCount, conversationCount, memberCount] =
      await Promise.all([
        this.scopedPrisma.prisma.ticket.count(),
        this.scopedPrisma.prisma.ticket.count({
          where: {
            status: { in: [TicketStatus.OPEN, TicketStatus.IN_PROGRESS] },
          },
        }),
        this.scopedPrisma.prisma.conversation.count(),
        this.scopedPrisma.prisma.user.count(),
      ]);

    return {
      ...tenant,
      metrics: {
        ticketCount,
        openTicketCount,
        conversationCount,
        memberCount,
      },
    };
  }
}
