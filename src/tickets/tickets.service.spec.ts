import { TicketStatus } from '../generated/prisma/client';
import { tenantContextStore } from '../tenancy/tenant-context';
import { TicketsService } from './tickets.service';

function runAsTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantContextStore.run({ tenantId, userId: 'u1' }, () => fn());
}

describe('TicketsService.create idempotency', () => {
  let service: TicketsService;
  const ticketCreate = jest.fn();
  const ticketFindFirst = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    const scopedPrisma = {
      prisma: { ticket: { create: ticketCreate, findFirst: ticketFindFirst } },
    } as any;
    service = new TicketsService(scopedPrisma);
  });

  it('creates directly when no idempotency key is provided', async () => {
    ticketCreate.mockResolvedValue({ id: 't1' });

    const result = await runAsTenant('ten-1', () =>
      service.create({ title: 'Help' }),
    );

    expect(ticketCreate).toHaveBeenCalledWith({
      data: { title: 'Help', tenantId: 'ten-1' },
    });
    expect(ticketFindFirst).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 't1' });
  });

  it('returns the existing row instead of creating a duplicate for a reused key', async () => {
    const existing = {
      id: 't1',
      tenantId: 'ten-1',
      title: 'Help',
      status: TicketStatus.OPEN,
      idempotencyKey: 'call-1',
    };
    ticketFindFirst.mockResolvedValue(existing);

    const result = await runAsTenant('ten-1', () =>
      service.create({ title: 'Help' }, 'call-1'),
    );

    expect(result).toBe(existing);
    expect(ticketCreate).not.toHaveBeenCalled();
  });

  it('creates with the key and tenant when none exists yet', async () => {
    ticketFindFirst.mockResolvedValue(null);
    const created = { id: 't1', idempotencyKey: 'call-1' };
    ticketCreate.mockResolvedValue(created);

    const result = await runAsTenant('ten-1', () =>
      service.create({ title: 'Help' }, 'call-1'),
    );

    expect(ticketFindFirst).toHaveBeenCalledWith({
      where: { tenantId: 'ten-1', idempotencyKey: 'call-1' },
    });
    expect(ticketCreate).toHaveBeenCalledWith({
      data: { title: 'Help', tenantId: 'ten-1', idempotencyKey: 'call-1' },
    });
    expect(result).toBe(created);
  });

  it('recovers the winning row when a concurrent create wins the race (P2002)', async () => {
    ticketFindFirst.mockResolvedValueOnce(null); // pre-check: nothing yet
    ticketCreate.mockRejectedValueOnce({ code: 'P2002', message: 'unique' });
    const winner = { id: 't2', idempotencyKey: 'call-1' };
    ticketFindFirst.mockResolvedValueOnce(winner); // post-race lookup

    const result = await runAsTenant('ten-1', () =>
      service.create({ title: 'Help' }, 'call-1'),
    );

    // First findFirst = pre-check (null); second = the winner after P2002.
    expect(ticketFindFirst).toHaveBeenCalledTimes(2);
    expect(result).toBe(winner);
  });
});
