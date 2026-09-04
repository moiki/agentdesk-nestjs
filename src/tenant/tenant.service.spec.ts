import { TenantService } from './tenant.service';
import { tenantContextStore } from '../tenancy/tenant-context';

function runAsTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantContextStore.run({ tenantId, userId: 'u1' }, () => fn());
}

describe('TenantService.profile', () => {
  let service: TenantService;
  const tenantFindUnique = jest.fn();
  const ticketCount = jest.fn();
  const conversationCount = jest.fn();
  const userCount = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    const scopedPrisma = {
      prisma: {
        tenant: { findUnique: tenantFindUnique },
        ticket: { count: ticketCount },
        conversation: { count: conversationCount },
        user: { count: userCount },
      },
    } as any;
    service = new TenantService(scopedPrisma);
  });

  it('returns the tenant registry data with live metrics for the active tenant', async () => {
    tenantFindUnique.mockResolvedValue({
      id: 'ten-1',
      name: 'Acme',
      slug: 'acme',
      plan: 'FREE',
    });
    ticketCount.mockResolvedValueOnce(10).mockResolvedValueOnce(3);
    conversationCount.mockResolvedValue(5);
    userCount.mockResolvedValue(2);

    const result = await runAsTenant('ten-1', () => service.profile());

    expect(tenantFindUnique).toHaveBeenCalledWith({ where: { id: 'ten-1' } });
    expect(result).toEqual({
      id: 'ten-1',
      name: 'Acme',
      slug: 'acme',
      plan: 'FREE',
      metrics: {
        ticketCount: 10,
        openTicketCount: 3,
        conversationCount: 5,
        memberCount: 2,
      },
    });
  });

  it('scopes the metric counts to the active tenant context', async () => {
    tenantFindUnique.mockResolvedValue({ id: 'ten-2' });
    ticketCount.mockResolvedValue(0);
    conversationCount.mockResolvedValue(0);
    userCount.mockResolvedValue(0);

    await runAsTenant('ten-2', () => service.profile());

    // The second ticket.count call is the "open" count scoped to OPEN/IN_PROGRESS.
    expect(ticketCount).toHaveBeenNthCalledWith(1);
    expect(ticketCount).toHaveBeenNthCalledWith(2, {
      where: { status: { in: ['OPEN', 'IN_PROGRESS'] } },
    });
  });
});
