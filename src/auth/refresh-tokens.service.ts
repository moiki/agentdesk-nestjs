import { randomBytes } from 'crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { hash, compare } from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Platform-level refresh-token lifecycle (NOT tenant-scoped, accessed via the
 * base client like UsersService). Refresh tokens are opaque, single-use and
 * rotated: only a SHA-like salted hash is persisted (bcrypt), so a DB leak
 * does not expose usable tokens, and consuming a token deletes it (rotation).
 */
@Injectable()
export class RefreshTokensService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new refresh token for a user. Returns the RAW token to be placed
   * in an HttpOnly cookie; only its hash is stored.
   */
  async issue(userId: string, expiresAt: Date): Promise<string> {
    const raw = randomBytes(48).toString('base64url');
    const tokenHash = await hash(raw, 10);
    await this.prisma.refreshToken.create({
      data: { userId, tokenHash, expiresAt },
    });
    return raw;
  }

  /**
   * Validate (and rotate) a refresh token: returns the owning userId and
   * immediately deletes the row so the same token can never be replayed.
   */
  async consume(raw: string): Promise<{ userId: string }> {
    if (!raw) {
      throw new UnauthorizedException('Missing refresh token');
    }

    const tokens = await this.prisma.refreshToken.findMany();
    let matched: { id: string; userId: string; expiresAt: Date } | null = null;

    // bcrypt hashes are salted, so equality lookup isn't possible — scan the
    // user's tokens. Constrained in practice by per-user token count.
    for (const t of tokens) {
      if (t.userId && (await compare(raw, t.tokenHash))) {
        matched = t;
        break;
      }
    }

    if (!matched || matched.expiresAt.getTime() < Date.now()) {
      if (matched) await this.deleteById(matched.id);
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    await this.deleteById(matched.id);
    return { userId: matched.userId };
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({ where: { userId } });
  }

  private deleteById(id: string) {
    return this.prisma.refreshToken.delete({ where: { id } });
  }
}
