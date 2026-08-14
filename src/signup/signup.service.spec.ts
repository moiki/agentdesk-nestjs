import { ConflictException } from '@nestjs/common';
import { TenantScopedPrismaService } from '../tenancy/tenant-scoped-prisma.service';
import { SignupService } from './signup.service';

describe('SignupService', () => {
  const tenantCreate = jest.fn();
  const userCreate = jest.fn();
  const tx = {
    tenant: { create: tenantCreate },
    user: { create: userCreate },
  };
  const scopedPrisma = {
    prisma: {
      $transaction: jest.fn((cb: (t: unknown) => unknown) =>
        Promise.resolve(cb(tx)),
      ),
    },
  };

  let service: SignupService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SignupService(
      scopedPrisma as unknown as TenantScopedPrismaService,
    );
  });

  const dto = {
    companyName: 'Acme Inc',
    workspaceName: 'acme',
    adminEmail: 'ops@acme.com',
    adminPassword: 'password123',
  };

  it('creates tenant and admin user in one transaction with the generated tenantId', async () => {
    tenantCreate.mockResolvedValue({});
    userCreate.mockResolvedValue({ id: 'user-1' });

    const out = await service.signup(dto);

    expect(out.tenantId).toBeDefined();
    expect(out.adminUserId).toBe('user-1');
    expect(out.plan).toBe('FREE');

    expect(tenantCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: out.tenantId,
        name: 'Acme Inc',
        slug: 'acme',
        plan: 'FREE',
      }),
    });
    expect(userCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'ops@acme.com',
        role: 'ADMIN',
        tenantId: out.tenantId,
      }),
    });
  });

  it('maps a unique constraint violation to ConflictException (no partial state)', async () => {
    tenantCreate.mockRejectedValue({ code: 'P2002' });

    await expect(service.signup(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(userCreate).not.toHaveBeenCalled();
  });

  it('rejects plans other than FREE in the MVP', async () => {
    await expect(service.signup({ ...dto, plan: 'PRO' })).rejects.toThrow(
      /FREE plan/,
    );
    expect(tenantCreate).not.toHaveBeenCalled();
  });
});
