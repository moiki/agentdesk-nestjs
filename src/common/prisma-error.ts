/**
 * True for Prisma's unique-constraint violation (code P2002). Used to implement
 * DB-level idempotency: a retried insert that collides with an existing
 * (tenantId, idempotencyKey) row is recognized here so the caller can recover
 * the pre-existing winning row instead of failing.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  );
}
