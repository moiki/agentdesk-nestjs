import { UnauthorizedException } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client';
import { getTenantId } from './tenant-context';

/**
 * Models owned by the platform itself and never scoped by tenant.
 * The Tenant registry is the only one for now.
 */
const ADMIN_MODELS = new Set(['Tenant']);

export interface OperationArgs {
  model: string;
  operation: string;
  args: Record<string, any>;
}

/**
 * Pure, side-effect free transformation of a Prisma operation's args so that
 * every tenant-owned model operation is forced into the active tenant.
 *
 * - Writes (create/createMany/upsert): tenantId is stamped onto the payload.
 * - Every other operation: `tenantId` is merged LAST into `where`, so the
 *   contextual tenant always wins over anything a caller might have passed.
 * - Unique-based operations stay valid because scoped models declare
 *   `@@unique([tenantId, id])`.
 *
 * Extracted as a pure function so the scoping rules can be unit-tested without
 * a database.
 */
export function applyTenantScope(
  model: string,
  operation: string,
  args: Record<string, any>,
  tenantId: string,
): void {
  if (ADMIN_MODELS.has(model)) {
    return;
  }

  switch (operation) {
    case 'create':
      args.data = { ...args.data, tenantId };
      break;

    case 'createMany': {
      const rows = Array.isArray(args.data) ? args.data : [args.data];
      args.data = rows.map((row) => ({ ...row, tenantId }));
      break;
    }

    case 'upsert':
      args.where = { ...args.where, tenantId };
      args.create = { ...args.create, tenantId };
      // `update` must NOT touch tenantId: it is part of @@unique([tenantId, id]).
      break;

    default:
      // Always scope, even when the caller passed no `where` (a bare findMany
      // must never return rows from other tenants).
      args.where = { ...args.where, tenantId };
  }
}

/**
 * Builds a tenant-scoped Prisma client on top of the shared base client.
 *
 * The returned client reads the tenant from AsyncLocalStorage at query time
 * (or from an explicit override, used in tests). There is no unscoped access
 * path exposed for tenant-owned models: any operation without an active
 * tenant context fails fast.
 */
export function createScopedPrisma(
  prisma: PrismaClient,
  options: { tenantId?: string } = {},
) {
  return prisma.$extends({
    query: {
      $allModels: {
        // Params are annotated loosely on purpose: the generated client types
        // the hook as a correlated union that loses `query` callability once
        // destructured. The runtime contract is stable across Prisma 7.
        async $allOperations({
          model,
          operation,
          args,
          query,
        }: {
          model: string;
          operation: string;
          args: any;
          query: (args: any) => Promise<unknown>;
        }) {
          if (ADMIN_MODELS.has(model)) {
            return query(args);
          }

          const tenantId = options.tenantId ?? getTenantId();
          if (!tenantId) {
            throw new UnauthorizedException(
              'Missing tenant context. Tenant-scoped operations require an active tenant.',
            );
          }

          applyTenantScope(model, operation, args, tenantId);
          return query(args);
        },
      },
    },
  });
}

export type ScopedPrismaClient = ReturnType<typeof createScopedPrisma>;
