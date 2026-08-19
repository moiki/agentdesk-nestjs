import { Test, TestingModule } from '@nestjs/testing';
import { TicketTools } from './ticket-tools';
import { ToolRegistry } from './tool-registry.service';
import { TicketsService } from '../../tickets/tickets.service';

const mockTicketsService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};

describe('TicketTools', () => {
  let module: TestingModule;
  let ticketTools: TicketTools;
  let registry: ToolRegistry;

  beforeEach(async () => {
    jest.clearAllMocks();

    module = await Test.createTestingModule({
      providers: [
        TicketTools,
        ToolRegistry,
        { provide: TicketsService, useValue: mockTicketsService },
      ],
    }).compile();

    ticketTools = module.get(TicketTools);
    registry = module.get(ToolRegistry);
  });

  it('registers 5 ticket tools on module init', () => {
    ticketTools.onModuleInit();

    const defs = registry.getDefinitions();
    expect(defs).toHaveLength(5);
    expect(defs.map((d) => d.name)).toEqual([
      'create_ticket',
      'list_tickets',
      'get_ticket',
      'update_ticket',
      'delete_ticket',
    ]);
  });

  describe('create_ticket', () => {
    it('creates a ticket and returns it', async () => {
      ticketTools.onModuleInit();
      const fakeTicket = { id: 't1', title: 'Help', status: 'OPEN' };
      mockTicketsService.create.mockResolvedValue(fakeTicket);

      const result = await registry.execute('create_ticket', { title: 'Help' });
      expect(result).toEqual({ success: true, data: fakeTicket });
      expect(mockTicketsService.create).toHaveBeenCalledWith({ title: 'Help' });
    });

    it('is marked as mutating', () => {
      ticketTools.onModuleInit();
      const tool = registry.getTool('create_ticket');
      expect(tool?.mutating).toBe(true);
    });
  });

  describe('list_tickets', () => {
    it('lists all tickets', async () => {
      ticketTools.onModuleInit();
      const tickets = [{ id: 't1' }, { id: 't2' }];
      mockTicketsService.findAll.mockResolvedValue(tickets);

      const result = await registry.execute('list_tickets', {});
      expect(result).toEqual({ success: true, data: tickets });
    });

    it('passes status filter', async () => {
      ticketTools.onModuleInit();
      mockTicketsService.findAll.mockResolvedValue([]);

      await registry.execute('list_tickets', { status: 'RESOLVED' });
      expect(mockTicketsService.findAll).toHaveBeenCalledWith('RESOLVED');
    });

    it('is NOT marked as mutating (read-only)', () => {
      ticketTools.onModuleInit();
      const tool = registry.getTool('list_tickets');
      expect(tool?.mutating).toBeFalsy();
    });
  });

  describe('get_ticket', () => {
    it('returns a ticket by id', async () => {
      ticketTools.onModuleInit();
      const ticket = { id: 't1', title: 'Help' };
      mockTicketsService.findOne.mockResolvedValue(ticket);

      const result = await registry.execute('get_ticket', {
        ticketId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result).toEqual({ success: true, data: ticket });
    });

    it('returns NOT_FOUND error when ticket does not exist', async () => {
      ticketTools.onModuleInit();
      mockTicketsService.findOne.mockRejectedValue(
        new Error('Ticket not found'),
      );

      const result = await registry.execute('get_ticket', {
        ticketId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result).toEqual({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Ticket not found' },
      });
    });

    it('returns INTERNAL_ERROR on unexpected failure', async () => {
      ticketTools.onModuleInit();
      mockTicketsService.findOne.mockRejectedValue(
        new Error('Database connection lost'),
      );

      const result = await registry.execute('get_ticket', {
        ticketId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result).toEqual({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Database connection lost' },
      });
    });
  });

  describe('update_ticket', () => {
    it('updates title and status', async () => {
      ticketTools.onModuleInit();
      const updated = { id: 't1', title: 'New', status: 'CLOSED' };
      mockTicketsService.update.mockResolvedValue(updated);

      const result = await registry.execute('update_ticket', {
        ticketId: '550e8400-e29b-41d4-a716-446655440000',
        title: 'New',
        status: 'CLOSED',
      });
      expect(result).toEqual({ success: true, data: updated });
    });

    it('returns NOT_FOUND on missing ticket', async () => {
      ticketTools.onModuleInit();
      mockTicketsService.update.mockRejectedValue(
        new Error('Ticket not found'),
      );

      const result = await registry.execute('update_ticket', {
        ticketId: '550e8400-e29b-41d4-a716-446655440000',
        status: 'CLOSED',
      });
      expect(result).toEqual({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Ticket not found' },
      });
    });

    it('is marked as mutating', () => {
      ticketTools.onModuleInit();
      const tool = registry.getTool('update_ticket');
      expect(tool?.mutating).toBe(true);
    });
  });

  describe('delete_ticket', () => {
    it('deletes and returns the ticket', async () => {
      ticketTools.onModuleInit();
      const deleted = { id: 't1', title: 'Bye' };
      mockTicketsService.remove.mockResolvedValue(deleted);

      const result = await registry.execute('delete_ticket', {
        ticketId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result).toEqual({ success: true, data: deleted });
    });

    it('returns NOT_FOUND on missing ticket', async () => {
      ticketTools.onModuleInit();
      mockTicketsService.remove.mockRejectedValue(
        new Error('Ticket not found'),
      );

      const result = await registry.execute('delete_ticket', {
        ticketId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result).toEqual({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Ticket not found' },
      });
    });

    it('is marked as mutating and requiresApproval', () => {
      ticketTools.onModuleInit();
      const tool = registry.getTool('delete_ticket');
      expect(tool?.mutating).toBe(true);
      expect(tool?.requiresApproval).toBe(true);
    });
  });
});
