import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { hash } from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { RefreshTokensService } from './refresh-tokens.service';

describe('AuthService', () => {
  let service: AuthService;
  const users = { findByEmail: jest.fn(), findById: jest.fn() };
  const jwt = { signAsync: jest.fn() };
  const refreshTokens = {
    issue: jest.fn(),
    consume: jest.fn(),
    revokeAllForUser: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AuthService(
      users as unknown as UsersService,
      jwt as unknown as JwtService,
      refreshTokens as unknown as RefreshTokensService,
    );
    users.findById.mockResolvedValue({
      id: 'u1',
      tenantId: 't1',
      role: 'ADMIN',
      email: 'a@test.local',
    });
    refreshTokens.issue.mockResolvedValue('raw-refresh-token');
  });

  it('issues a JWT with tenant claims for valid credentials', async () => {
    users.findByEmail.mockResolvedValue({
      id: 'u1',
      tenantId: 't1',
      role: 'ADMIN',
      email: 'a@test.local',
      passwordHash: await hash('password123', 4),
    });
    jwt.signAsync.mockResolvedValue('signed-token');

    const out = await service.login({
      email: 'a@test.local',
      password: 'password123',
    });

    expect(out.accessToken).toBe('signed-token');
    expect(out.refreshToken).toBe('raw-refresh-token');
    expect(jwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'u1',
        tenantId: 't1',
        role: 'ADMIN',
        email: 'a@test.local',
      }),
    );
    expect(refreshTokens.issue).toHaveBeenCalledWith('u1', expect.any(Date));
  });

  it('throws 401 on wrong password', async () => {
    users.findByEmail.mockResolvedValue({
      id: 'u1',
      tenantId: 't1',
      role: 'ADMIN',
      email: 'a@test.local',
      passwordHash: await hash('password123', 4),
    });

    await expect(
      service.login({ email: 'a@test.local', password: 'wrong-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('throws 401 on unknown user (same error shape)', async () => {
    users.findByEmail.mockResolvedValue(null);

    await expect(
      service.login({ email: 'nobody@test.local', password: 'password123' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not leak the password hash', async () => {
    users.findByEmail.mockResolvedValue({
      id: 'u1',
      tenantId: 't1',
      role: 'ADMIN',
      email: 'a@test.local',
      passwordHash: await hash('password123', 4),
    });

    const result = await service.login({
      email: 'a@test.local',
      password: 'password123',
    });
    expect(JSON.stringify(result)).not.toContain('passwordHash');
    expect(JSON.stringify(result)).not.toContain('$2a$');
  });
});
