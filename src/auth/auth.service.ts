import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import { ENV } from '../common/constants';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokensService } from './refresh-tokens.service';

/** Precomputed hash so the bcrypt cost stays constant even for unknown emails. */
const DUMMY_HASH =
  '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
}

export interface RefreshResult {
  accessToken: string;
}

/**
 * Email/password authentication. Identity lookups are platform-level (UsersService);
 * the resulting JWT carries `sub`, `tenantId`, `role`, `email`, and every
 * subsequent request derives the tenant from that token.
 *
 * Sessions are persisted with a rotating refresh token (RefreshTokensService)
 * that lives in an HttpOnly cookie, so the login survives tab switches and
 * reloads without exposing the credentials to client-side code.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly refreshTokens: RefreshTokensService,
  ) {}

  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.users.findByEmail(dto.email);

    const hash = user?.passwordHash ?? DUMMY_HASH;
    const matches = await compare(dto.password, hash);

    if (!user || !matches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.issueTokens(user.id);
  }

  /**
   * Rotate the refresh token and mint a fresh access token. The incoming
   * refresh token is consumed (invalidated) by RefreshTokensService.
   */
  async refresh(rawRefreshToken: string): Promise<RefreshResult> {
    const { userId } = await this.refreshTokens.consume(rawRefreshToken);
    return this.issueTokens(userId);
  }

  async logout(rawRefreshToken: string): Promise<void> {
    if (!rawRefreshToken) return;
    try {
      const { userId } = await this.refreshTokens.consume(rawRefreshToken);
      await this.refreshTokens.revokeAllForUser(userId);
    } catch {
      // Best-effort: clearing the cookie already ends the session client-side.
    }
  }

  private async issueTokens(userId: string): Promise<LoginResult> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
      email: user.email,
    });

    const refreshToken = await this.refreshTokens.issue(
      user.id,
      new Date(Date.now() + ENV.COOKIE_REFRESH_TTL_MS),
    );

    return { accessToken, refreshToken };
  }
}
