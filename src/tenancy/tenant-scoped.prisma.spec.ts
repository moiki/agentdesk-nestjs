import { applyTenantScope } from './tenant-scoped.prisma';

describe('applyTenantScope', () => {
  const tenantId = 'tenant-a';

  it('stamps tenantId on create and overrides any spoofed value', () => {
    const args: any = { data: { title: 't', tenantId: 'tenant-b' } };
    applyTenantScope('Ticket', 'create', args, tenantId);
    expect(args.data).toEqual({ title: 't', tenantId: 'tenant-a' });
  });

  it('stamps tenantId on createMany for every row', () => {
    const args: any = {
      data: [{ title: 't1' }, { title: 't2', tenantId: 'tenant-b' }],
    };
    applyTenantScope('Ticket', 'createMany', args, tenantId);
    expect(args.data).toEqual([
      { title: 't1', tenantId: 'tenant-a' },
      { title: 't2', tenantId: 'tenant-a' },
    ]);
  });

  it('stamps where + create on upsert but never touches update', () => {
    const args: any = {
      where: { id: 'x' },
      create: { title: 't', tenantId: 'tenant-b' },
      update: { title: 't2' },
    };
    applyTenantScope('Ticket', 'upsert', args, tenantId);
    expect(args.where).toEqual({ id: 'x', tenantId: 'tenant-a' });
    expect(args.create).toEqual({ title: 't', tenantId: 'tenant-a' });
    expect(args.update).toEqual({ title: 't2' });
  });

  it('merges tenantId LAST on reads so context always wins', () => {
    const args: any = { where: { id: 'x', tenantId: 'tenant-b' } };
    applyTenantScope('Ticket', 'findMany', args, tenantId);
    expect(args.where).toEqual({ id: 'x', tenantId: 'tenant-a' });
  });

  it('adds tenantId to unique-based read/write operations', () => {
    for (const operation of [
      'findUnique',
      'findUniqueOrThrow',
      'findFirst',
      'findFirstOrThrow',
      'update',
      'delete',
      'count',
      'aggregate',
      'groupBy',
      'updateMany',
      'deleteMany',
    ]) {
      const args: any = { where: { id: 'x' } };
      applyTenantScope('Ticket', operation, args, tenantId);
      expect(args.where).toEqual({ id: 'x', tenantId: 'tenant-a' });
    }
  });

  it('handles a missing where clause', () => {
    const args: any = {};
    applyTenantScope('Ticket', 'findMany', args, tenantId);
    expect(args.where).toEqual({ tenantId: 'tenant-a' });
  });

  it('does NOT scope the Tenant registry (admin model)', () => {
    const args: any = { where: { id: 'x' } };
    applyTenantScope('Tenant', 'findMany', args, tenantId);
    expect(args).toEqual({ where: { id: 'x' } });
  });
});
