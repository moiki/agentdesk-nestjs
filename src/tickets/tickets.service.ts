import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { getTenantId } from '../tenancy/tenant-context';
import { TenantScopedPrismaService } from '../tenancy/tenant-scoped-prisma.service';
import { TicketStatus } from '../generated/prisma/client';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { isUniqueViolation } from '../common/prisma-error';

/**
 * Tenant-domain service. Every operation goes through the tenant-scoped
 * Prisma client, so rows are always filtered/stamped with the active tenant.
 * The explicit `tenantId` in create data is what keeps the call type-checked;
 * the scoping extension force-overrides it regardless (defense in depth).
 */
@Injectable()
export class TicketsService {
  constructor(private readonly scopedPrisma: TenantScopedPrismaService) {}

  /**
   * Creates a ticket. When `idempotencyKey` is supplied it is stamped onto the
   * row and guarded by the `@@unique([tenantId, idempotencyKey])` constraint:
   * a retried create with the same key returns the pre-existing winning row
   * instead of creating a duplicate. The find-then-create has a tiny race window
   * but the unique constraint is the atomic guard — a P2002 in the create is
   * caught and resolved back to the winner, so the outcome is always exactly one
   * ticket per key. Used by the agent's `create_ticket` (key = toolCallId); the
   * REST path calls without a key and keeps plain-create behavior.
   */
  async create(dto: CreateTicketDto, idempotencyKey?: string) {
    const tenantId = getTenantId()!;

    if (!idempotencyKey) {
      return this.scopedPrisma.prisma.ticket.create({
        data: { ...dto, tenantId },
      });
    }

    const existing = await this.scopedPrisma.prisma.ticket.findFirst({
      where: { tenantId, idempotencyKey },
    });
    if (existing) return existing;

    try {
      return await this.scopedPrisma.prisma.ticket.create({
        data: { ...dto, tenantId, idempotencyKey },
      });
    } catch (err) {
      // A concurrent process won the insert for this key — return its row.
      if (isUniqueViolation(err)) {
        const winner = await this.scopedPrisma.prisma.ticket.findFirst({
          where: { tenantId, idempotencyKey },
        });
        if (winner) return winner;
      }
      throw err;
    }
  }

  findAll(status?: TicketStatus) {
    return this.scopedPrisma.prisma.ticket.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const ticket = await this.scopedPrisma.prisma.ticket.findUnique({
      where: { id },
    });
    if (!ticket) {
      throw new NotFoundException('Ticket not found');
    }
    return ticket;
  }

  /**
   * Updates a ticket. When an expected version is supplied (from `dto.version`
   * or the `expectedVersion` override), the update is a compare-and-swap: it
   * only applies if the row's current `version` still matches, then increments
   * it. A mismatch throws 409 so the caller can surface a lost-update conflict.
   * Without a version the update is last-writer-wins (backwards compatible).
   */
  async update(id: string, dto: UpdateTicketDto, expectedVersion?: number) {
    await this.findOne(id);

    const { version, ...fields } = dto;
    const expected = expectedVersion ?? version;

    if (expected !== undefined) {
      const result = await this.scopedPrisma.prisma.ticket.updateMany({
        where: { id, version: expected },
        data: { ...fields, version: { increment: 1 } },
      });
      if (result.count === 0) {
        throw new ConflictException(
          'Ticket was modified by another request. Please retry.',
        );
      }
      return this.findOne(id);
    }

    return this.scopedPrisma.prisma.ticket.update({
      where: { id },
      data: fields,
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.scopedPrisma.prisma.ticket.delete({ where: { id } });
  }
}
