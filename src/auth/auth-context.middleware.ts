import {
  BadRequestException,
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { NextFunction, Request, Response } from 'express';
import { ENV } from '../common/constants';
import { tenantContextStore } from '../tenancy/tenant-context';
import type { AuthUser, AuthenticatedRequest, JwtPayload } from './auth.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Routes that never require an authenticated tenant: platform health, the
 * self-service onboarding flow itself, and cookie-based session endpoints
 * (refresh/logout authenticate via the refresh cookie, not the bearer token).
 * Must stay in sync with the public controllers (health, signup, auth/login).
 */
export const PUBLIC_PATHS = [
  '/health',
  '/signup',
  '/auth/login',
  '/auth/refresh',
  '/auth/logout',
];

/**
 * Authentication + tenant context middleware (single enforcement point).
 *
 *  - Public paths: pass through untouched (no context).
 *  - Protected paths: verify `Authorization: Bearer <jwt>`, attach the user to
 *    the request, and bind the tenant to AsyncLocalStorage so every downstream
 *    operation (services, Prisma scoping, future agent/LLM code) inherits it.
 *
 * The tenant identity comes from the TOKEN, never from the client header. The
 * `x-tenant-id` header is only honored when ALLOW_TENANT_HEADER=true (dev only).
 */
@Injectable()
export class AuthContextMiddleware implements NestMiddleware {
  constructor(private readonly jwt: JwtService) {}

  async use(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
    const urlPath = req.originalUrl.split('?')[0];
    if (PUBLIC_PATHS.some((path) => urlPath.startsWith(path))) {
      return next();
    }

    const devTenantId = this.devHeaderTenantId(req);
    if (devTenantId) {
      return tenantContextStore.run({ tenantId: devTenantId }, () => next());
    }

    const token = this.extractBearer(req) ?? this.extractCookie(req);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const user: AuthUser = {
      userId: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
      email: payload.email,
    };
    req.user = user;

    tenantContextStore.run(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      () => next(),
    );
  }

  /** Dev-only fallback: trust x-tenant-id when ALLOW_TENANT_HEADER=true. */
  private devHeaderTenantId(req: Request): string | undefined {
    if (!ENV.ALLOW_TENANT_HEADER) {
      return undefined;
    }
    const rawTenantId = req.header('x-tenant-id');
    if (!rawTenantId) {
      return undefined;
    }
    if (!UUID_PATTERN.test(rawTenantId)) {
      throw new BadRequestException('x-tenant-id must be a valid UUID');
    }
    return rawTenantId;
  }

  private extractBearer(req: Request): string | undefined {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      return undefined;
    }
    return header.slice('Bearer '.length).trim();
  }

  /**
   * Session fallback: read the short-lived access token from an HttpOnly
   * cookie when no Authorization header is sent. This is what keeps a session
   * working across tabs and after a page reload.
   */
  private extractCookie(req: Request): string | undefined {
    const cookies = req.cookies as Record<string, string> | undefined;
    const token = cookies?.['access_token'];
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  }
}
