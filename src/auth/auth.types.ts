import type { Request } from 'express';
import type { UserRole } from '../generated/prisma/client';

/**
 * JWT claims for AgentDesk. `sub` is the user id (JWT standard); the tenant is
 * carried as a custom claim because every downstream operation needs it.
 */
export interface JwtPayload {
  sub: string;
  tenantId: string;
  role: UserRole;
  email: string;
}

/** The authenticated user attached to the request by AuthContextMiddleware. */
export interface AuthUser {
  userId: string;
  tenantId: string;
  role: UserRole;
  email: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}
