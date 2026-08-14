import { Injectable, NotFoundException } from '@nestjs/common';
import { getTenantId } from '../tenancy/tenant-context';
import { TenantScopedPrismaService } from '../tenancy/tenant-scoped-prisma.service';
import { TicketStatus } from '../generated/prisma/client';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';

/**
 * Tenant-domain service. Every operation goes through the tenant-scoped
 * Prisma client, so rows are always filtered/stamped with the active tenant.
 * The explicit `tenantId` in create data is what keeps the call type-checked;
 * the scoping extension force-overrides it regardless (defense in depth).
 */
@Injectable()
export class TicketsService {
  constructor(private readonly scopedPrisma: TenantScopedPrismaService) {}

  create(dto: CreateTicketDto) {
    return this.scopedPrisma.prisma.ticket.create({
      data: { ...dto, tenantId: getTenantId()! },
    });
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

  async update(id: string, dto: UpdateTicketDto) {
    await this.findOne(id);
    return this.scopedPrisma.prisma.ticket.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.scopedPrisma.prisma.ticket.delete({ where: { id } });
  }
}
