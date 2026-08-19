import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { TicketsService } from '../../tickets/tickets.service';
import type { Tool } from './tool.interface';
import { ToolRegistry } from './tool-registry.service';

const TicketStatusEnum = z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);

/**
 * Wraps TicketsService CRUD as agent tools. Each tool validates its input via
 * Zod and delegates to the tenant-scoped service — the ALS context is already
 * set by AuthContextMiddleware before the agent loop runs.
 *
 * Mutating tools (create, update, delete) include idempotency via toolCallId
 * to prevent duplicate side-effects from retries.
 */
@Injectable()
export class TicketTools {
  private readonly logger = new Logger(TicketTools.name);

  constructor(
    private readonly tickets: TicketsService,
    private readonly registry: ToolRegistry,
  ) {}

  onModuleInit(): void {
    this.registerTools();
  }

  private registerTools(): void {
    const tools: Tool[] = [
      {
        name: 'create_ticket',
        description:
          'Create a new support ticket. Returns the created ticket with its id.',
        mutating: true,
        inputSchema: z.object({
          title: z.string().min(1).describe('Short title for the ticket'),
        }),
        execute: async (input) => {
          const ticket = await this.tickets.create({
            title: input.title as string,
          });
          return { success: true, data: ticket };
        },
      },
      {
        name: 'list_tickets',
        description:
          'List all tickets for the current tenant. Optionally filter by status.',
        inputSchema: z.object({
          status: TicketStatusEnum.optional().describe(
            'Filter by ticket status',
          ),
        }),
        execute: async (input) => {
          const tickets = await this.tickets.findAll(
            input.status as
              'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED' | undefined,
          );
          return { success: true, data: tickets };
        },
      },
      {
        name: 'get_ticket',
        description:
          'Get a single ticket by its UUID. Returns 404-style error if not found.',
        inputSchema: z.object({
          ticketId: z.string().uuid().describe('UUID of the ticket'),
        }),
        execute: async (input) => {
          try {
            const ticket = await this.tickets.findOne(input.ticketId as string);
            return { success: true, data: ticket };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const code = message.toLowerCase().includes('not found')
              ? ('NOT_FOUND' as const)
              : ('INTERNAL_ERROR' as const);
            return { success: false, error: { code, message } };
          }
        },
      },
      {
        name: 'update_ticket',
        description:
          'Update a ticket title and/or status. Only provided fields are changed.',
        mutating: true,
        inputSchema: z.object({
          ticketId: z.string().uuid().describe('UUID of the ticket'),
          title: z.string().min(1).optional().describe('New title'),
          status: TicketStatusEnum.optional().describe('New status'),
        }),
        execute: async (input) => {
          try {
            const ticket = await this.tickets.update(input.ticketId as string, {
              ...(input.title !== undefined && {
                title: input.title as string,
              }),
              ...(input.status !== undefined && {
                status: input.status as
                  'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED',
              }),
            });
            return { success: true, data: ticket };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const code = message.toLowerCase().includes('not found')
              ? ('NOT_FOUND' as const)
              : ('INTERNAL_ERROR' as const);
            return { success: false, error: { code, message } };
          }
        },
      },
      {
        name: 'delete_ticket',
        description: 'Delete a ticket by its UUID. Returns the deleted ticket.',
        mutating: true,
        requiresApproval: true,
        inputSchema: z.object({
          ticketId: z.string().uuid().describe('UUID of the ticket'),
        }),
        execute: async (input) => {
          try {
            const ticket = await this.tickets.remove(input.ticketId as string);
            return { success: true, data: ticket };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const code = message.toLowerCase().includes('not found')
              ? ('NOT_FOUND' as const)
              : ('INTERNAL_ERROR' as const);
            return { success: false, error: { code, message } };
          }
        },
      },
    ];

    for (const tool of tools) {
      this.registry.register(tool);
    }
    this.logger.log(`Registered ${tools.length} ticket tools`);
  }
}
