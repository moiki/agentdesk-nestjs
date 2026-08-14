import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';

/** Precomputed hash so the bcrypt cost stays constant even for unknown emails. */
const DUMMY_HASH =
  '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

export interface LoginResult {
  accessToken: string;
}

/**
 * Email/password authentication. Identity lookups are platform-level (UsersService);
 * the resulting JWT carries `sub`, `tenantId`, `role`, `email`, and every
 * subsequent request derives the tenant from that token.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.users.findByEmail(dto.email);

    const hash = user?.passwordHash ?? DUMMY_HASH;
    const matches = await compare(dto.password, hash);

    if (!user || !matches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
      email: user.email,
    });

    return { accessToken };
  }
}
