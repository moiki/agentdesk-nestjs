import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AgentService } from './agent.service';
import { ToolRegistry } from './tools/tool-registry.service';
import { FakeLlmProvider } from '../llm/fake-llm.provider';
import { LLM_PROVIDER } from '../llm/llm.module';
import type { LlmResponse } from '../llm/llm.types';
import type { ChatMessage } from '../llm/llm.types';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConversationService } from './conversation.service';
import { ConversationStatus } from '../generated/prisma/client';
import { TenantPromptService } from './prompts/tenant-prompt.service';
import { TenantScopedPrismaService } from '../tenancy/tenant-scoped-prisma.service';
import { DEFAULT_IDENTITY_PROMPT } from './prompts/identity.prompt';

/**
 * In-memory stand-in for the real ConversationService so unit tests never touch
 * a database. Mirrors the persistence semantics (create/find/updateMessages).
 */
class FakeConversationService {
  private store = new Map<
    string,
    { messages: ChatMessage[]; status: ConversationStatus }
  >();
  private seq = 0;

  async create(messages: ChatMessage[], _opts?: { userId?: string }) {
    const id = `conv-${++this.seq}`;
    this.store.set(id, { messages, status: ConversationStatus.ACTIVE });
    return { id, messages };
  }

  async find(id: string) {
    const row = this.store.get(id);
    if (!row) {
      const err: any = new Error('Conversation not found');
      err.status = 404;
      throw err;
    }
    return { id, messages: row.messages, status: row.status };
  }

  async updateMessages(
    id: string,
    messages: ChatMessage[],
    status?: ConversationStatus,
  ) {
    const row = this.store.get(id);
    if (!row) throw new Error('Conversation not found');
    row.messages = messages;
    if (status) row.status = status;
    return messages;
  }

  toMessages(value: unknown): ChatMessage[] {
    return Array.isArray(value) ? (value as ChatMessage[]) : [];
  }

  /* Test helpers */
  seed(messages: ChatMessage[]): string {
    const id = `conv-${++this.seq}`;
    this.store.set(id, { messages, status: ConversationStatus.PAUSED });
    return id;
  }
}

let callCounter = 0;

function toolUseResponse(
  toolName: string,
  args: Record<string, unknown>,
): LlmResponse {
  callCounter++;
  return {
    content: '',
    toolCalls: [{ id: `call-${callCounter}`, name: toolName, arguments: args }],
    stopReason: 'tool_use',
    usage: { inputTokens: 10, outputTokens: 5 },
    model: 'fake',
  };
}

function endTurnResponse(text: string): LlmResponse {
  return {
    content: text,
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
    model: 'fake',
  };
}

describe('AgentService', () => {
  let module: TestingModule;
  let agent: AgentService;
  let fakeLlm: FakeLlmProvider;
  let registry: ToolRegistry;
  let eventEmitter: EventEmitter2;
  let conversations: FakeConversationService;

  beforeEach(async () => {
    callCounter = 0;
    fakeLlm = new FakeLlmProvider({ strict: false });
    registry = new ToolRegistry();
    eventEmitter = new EventEmitter2();
    conversations = new FakeConversationService();

    // No tenant context is set in these unit tests, so the tenant prompt
    // resolver takes the no-DB path. These fakes let Nest resolve DI.
    const fakeScopedPrisma = {} as unknown as TenantScopedPrismaService;

    module = await Test.createTestingModule({
      providers: [
        AgentService,
        { provide: LLM_PROVIDER, useValue: fakeLlm },
        { provide: ToolRegistry, useValue: registry },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: ConversationService, useValue: conversations },
        TenantPromptService,
        { provide: TenantScopedPrismaService, useValue: fakeScopedPrisma },
      ],
    }).compile();

    agent = module.get(AgentService);
  });

  it('returns LLM response directly when no tools are called', async () => {
    fakeLlm.add({ match: {}, response: endTurnResponse('Hello!') });

    const result = await agent.chat('hi');
    expect(result.message).toBe('Hello!');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.iterations).toBe(1);
    expect(result.stopReason).toBe('end_turn');
    expect(result.awaitingApproval).toBeUndefined();
  });

  it('executes a tool call and loops until end_turn', async () => {
    registry.register({
      name: 'create_ticket',
      description: 'create',
      inputSchema: {
        safeParse: () => ({ success: true, data: { title: 'x' } }),
      } as any,
      execute: () => Promise.resolve({ success: true, data: { id: 't1' } }),
    });

    fakeLlm.addCassettes([
      {
        match: { hasToolCalls: false },
        response: toolUseResponse('create_ticket', { title: 'x' }),
      },
      {
        match: { hasToolCalls: true },
        response: endTurnResponse('Done! Created ticket t1.'),
      },
    ]);

    const result = await agent.chat('create a ticket');
    expect(result.message).toBe('Done! Created ticket t1.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('create_ticket');
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].success).toBe(true);
    expect(result.iterations).toBe(2);
  });

  it('chains multiple tool calls across iterations', async () => {
    let createCalled = false;
    registry.register({
      name: 'create_ticket',
      description: 'create',
      inputSchema: {
        safeParse: () => ({ success: true, data: { title: 'x' } }),
      } as any,
      execute: () => {
        createCalled = true;
        return Promise.resolve({ success: true, data: { id: 't1' } });
      },
    });
    registry.register({
      name: 'list_tickets',
      description: 'list',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
      execute: () => Promise.resolve({ success: true, data: [{ id: 't1' }] }),
    });

    fakeLlm.addCassettes([
      {
        match: { hasToolCalls: false },
        response: toolUseResponse('create_ticket', { title: 'x' }),
      },
      {
        match: { hasToolCalls: true, toolName: 'create_ticket' },
        response: toolUseResponse('list_tickets', {}),
      },
      {
        match: { hasToolCalls: true, toolName: 'list_tickets' },
        response: endTurnResponse('Created and listed.'),
      },
    ]);

    const result = await agent.chat('create and list');
    expect(result.iterations).toBe(3);
    expect(result.toolCalls).toHaveLength(2);
    expect(createCalled).toBe(true);
  });

  it('reports structured tool errors in toolResults', async () => {
    registry.register({
      name: 'get_ticket',
      description: 'get',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
      execute: () =>
        Promise.resolve({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Ticket not found' },
        }),
    });

    fakeLlm.addCassettes([
      {
        match: { hasToolCalls: false },
        response: toolUseResponse('get_ticket', { ticketId: 'x' }),
      },
      {
        match: { hasToolCalls: true },
        response: endTurnResponse('Not found.'),
      },
    ]);

    const result = await agent.chat('get ticket x');
    expect(result.toolResults[0].success).toBe(false);
    expect(result.toolResults[0].result).toEqual({
      code: 'NOT_FOUND',
      message: 'Ticket not found',
    });
  });

  it('stops at max iterations and returns max_iterations stopReason', async () => {
    registry.register({
      name: 'create_ticket',
      description: 'create',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
      execute: () => Promise.resolve({ success: true, data: {} }),
    });

    // Always return tool_use — never end_turn
    fakeLlm.add({
      match: {},
      response: toolUseResponse('create_ticket', { title: 'x' }),
    });

    const result = await agent.chat('create many tickets');
    expect(result.iterations).toBe(10);
    expect(result.stopReason).toBe('max_iterations');
    expect(result.message).toContain('maximum number of actions');
  });

  it('retries LLM calls on failure before giving up', async () => {
    let callCount = 0;
    const originalComplete = fakeLlm.complete.bind(fakeLlm);
    fakeLlm.complete = (request) => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('Rate limit exceeded'));
      }
      return originalComplete(request);
    };

    fakeLlm.add({ match: {}, response: endTurnResponse('OK after retry') });

    const result = await agent.chat('hello');
    expect(result.message).toBe('OK after retry');
    expect(callCount).toBe(2);
  });

  it('throws after exhausting all retries', async () => {
    fakeLlm.complete = () => Promise.reject(new Error('Persistent failure'));

    fakeLlm.add({ match: {}, response: endTurnResponse('never') });

    await expect(agent.chat('fail')).rejects.toThrow('Persistent failure');
  });

  it('pauses for approval when tool has requiresApproval', async () => {
    registry.register({
      name: 'delete_ticket',
      description: 'delete',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
      requiresApproval: true,
      execute: () => Promise.resolve({ success: true, data: { id: 't1' } }),
    });

    fakeLlm.addCassettes([
      {
        match: { hasToolCalls: false },
        response: toolUseResponse('delete_ticket', { ticketId: 'x' }),
      },
    ]);

    const result = await agent.chat('delete ticket x');
    expect(result.stopReason).toBe('tool_use');
    expect(result.message).toContain('approval');
    expect(result.toolCalls[0].name).toBe('delete_ticket');
  });

  it('exposes awaitingApproval with full arguments and no side effects on pause', async () => {
    let executed = false;
    registry.register({
      name: 'delete_ticket',
      description: 'delete',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
      requiresApproval: true,
      execute: () => {
        executed = true;
        return Promise.resolve({ success: true, data: { id: 't1' } });
      },
    });

    fakeLlm.addCassettes([
      {
        match: { hasToolCalls: false },
        response: toolUseResponse('delete_ticket', { ticketId: 't-123' }),
      },
    ]);

    const result = await agent.chat('delete ticket t-123');
    expect(result.awaitingApproval?.toolCalls).toHaveLength(1);
    expect(result.awaitingApproval?.toolCalls[0]).toEqual({
      id: 'call-1',
      name: 'delete_ticket',
      arguments: { ticketId: 't-123' },
    });
    expect(executed).toBe(false);
  });

  it('executes safe tools and pauses only approval-needing ones in a mixed batch', async () => {
    let deleted = false;
    registry.register({
      name: 'list_tickets',
      description: 'list',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
      execute: () => Promise.resolve({ success: true, data: [{ id: 't1' }] }),
    });
    registry.register({
      name: 'delete_ticket',
      description: 'delete',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
      requiresApproval: true,
      execute: () => {
        deleted = true;
        return Promise.resolve({ success: true, data: { id: 't9' } });
      },
    });

    fakeLlm.addCassettes([
      {
        match: { hasToolCalls: false },
        response: {
          content: '',
          toolCalls: [
            { id: 'c1', name: 'list_tickets', arguments: {} },
            { id: 'c2', name: 'delete_ticket', arguments: { ticketId: 't9' } },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 5 },
          model: 'fake',
        },
      },
    ]);

    const result = await agent.chat('list then delete');
    expect(deleted).toBe(false);
    expect(result.toolResults.map((r) => r.name)).toEqual(['list_tickets']);
    expect(result.toolResults[0].success).toBe(true);
    expect(result.awaitingApproval?.toolCalls.map((tc) => tc.id)).toEqual([
      'c2',
    ]);
    expect(result.stopReason).toBe('tool_use');
    expect(result.message).toContain('approval');
  });

  it('appends client extra instructions to the identity prompt (not a full override)', async () => {
    fakeLlm.add({ match: {}, response: endTurnResponse('ok') });

    await agent.chat('hi', undefined, 'Speak briefly.');
    const system = fakeLlm.requests[0].system;
    expect(system).toContain('You are AgentDesk');
    expect(system).toContain('## Additional instructions');
    expect(system).toContain('Speak briefly.');
    // The client prompt must NOT replace the identity base.
    expect(system).not.toBe('Speak briefly.');
  });

  it('uses the default AgentDesk identity prompt when no extra instructions are given', async () => {
    fakeLlm.add({ match: {}, response: endTurnResponse('ok') });

    await agent.chat('hi');
    expect(fakeLlm.requests[0].system).toContain(DEFAULT_IDENTITY_PROMPT);
  });

  it('includes conversation history in the request', async () => {
    fakeLlm.add({ match: {}, response: endTurnResponse('ok') });

    await agent.chat('follow up', [
      { role: 'user', content: 'previous question' },
      { role: 'assistant', content: 'previous answer' },
    ]);

    expect(fakeLlm.requests[0].messages).toHaveLength(3);
    expect(fakeLlm.requests[0].messages[0].content).toBe('previous question');
  });

  it('accumulates usage across iterations', async () => {
    registry.register({
      name: 'echo',
      description: 'echo',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
      execute: (input) => Promise.resolve({ success: true, data: input }),
    });

    fakeLlm.addCassettes([
      {
        match: { hasToolCalls: false },
        response: {
          content: '',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: { x: 1 } }],
          stopReason: 'tool_use',
          usage: { inputTokens: 100, outputTokens: 20 },
          model: 'fake',
        },
      },
      {
        match: { hasToolCalls: true },
        response: {
          content: 'done',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 50, outputTokens: 10 },
          model: 'fake',
        },
      },
    ]);

    const result = await agent.chat('echo');
    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 30 });
  });

  it('emits agent.iteration events', async () => {
    const events: unknown[] = [];
    eventEmitter.on('agent.iteration', (e) => events.push(e));

    fakeLlm.add({ match: {}, response: endTurnResponse('done') });

    await agent.chat('hi');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ iteration: 1, stopReason: 'end_turn' });
  });

  it('parallelizes read-only tools in the same turn', async () => {
    const executionOrder: string[] = [];

    registry.register({
      name: 'list_a',
      description: 'list a',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 50));
        executionOrder.push('list_a');
        return { success: true, data: [] };
      },
    });
    registry.register({
      name: 'list_b',
      description: 'list b',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
      execute: () => {
        executionOrder.push('list_b');
        return Promise.resolve({ success: true, data: [] });
      },
    });

    // Return both tools in one turn
    fakeLlm.addCassettes([
      {
        match: { hasToolCalls: false },
        response: {
          content: '',
          toolCalls: [
            { id: 'c1', name: 'list_a', arguments: {} },
            { id: 'c2', name: 'list_b', arguments: {} },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 5 },
          model: 'fake',
        },
      },
      {
        match: { hasToolCalls: true },
        response: endTurnResponse('Done'),
      },
    ]);

    const result = await agent.chat('list all');
    expect(result.toolCalls).toHaveLength(2);

    // list_b should have run before list_a (list_a had 50ms delay)
    // They ran in parallel, so list_b finished first
    expect(executionOrder).toEqual(['list_b', 'list_a']);
  });

  it('runs mutating tools sequentially after parallel read-only tools', async () => {
    const executionOrder: string[] = [];

    registry.register({
      name: 'list_tickets',
      description: 'list',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
      execute: () => {
        executionOrder.push('list');
        return Promise.resolve({ success: true, data: [] });
      },
    });
    registry.register({
      name: 'create_ticket',
      description: 'create',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
      mutating: true,
      execute: () => {
        executionOrder.push('create');
        return Promise.resolve({ success: true, data: { id: 't1' } });
      },
    });

    fakeLlm.addCassettes([
      {
        match: { hasToolCalls: false },
        response: {
          content: '',
          toolCalls: [
            { id: 'c1', name: 'list_tickets', arguments: {} },
            { id: 'c2', name: 'create_ticket', arguments: { title: 'x' } },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 5 },
          model: 'fake',
        },
      },
      {
        match: { hasToolCalls: true },
        response: endTurnResponse('Done'),
      },
    ]);

    await agent.chat('list and create');
    // Read-only runs first (parallel), then mutating
    expect(executionOrder).toEqual(['list', 'create']);
  });

  describe('approve (resume after approval pause)', () => {
    let executed: boolean;

    function pausedHistory(): string {
      return conversations.seed([
        { role: 'user', content: 'delete ticket t9' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'c2', name: 'delete_ticket', arguments: { ticketId: 't9' } },
          ],
        },
      ]);
    }

    function registerDeleteTool(): void {
      executed = false;
      registry.register({
        name: 'delete_ticket',
        description: 'delete',
        inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
        requiresApproval: true,
        mutating: true,
        execute: () => {
          executed = true;
          return Promise.resolve({ success: true, data: { id: 't9' } });
        },
      });
    }

    beforeEach(() => {
      callCounter = 0;
      executed = false;
    });

    it('400 when history has no unanswered assistant toolCalls', async () => {
      registerDeleteTool();
      const id = conversations.seed([{ role: 'user', content: 'hi' }]);
      await expect(agent.approve(id, [])).rejects.toThrow(BadRequestException);
      expect(executed).toBe(false);
    });

    it('400 when a decision references an unknown toolCallId', async () => {
      registerDeleteTool();
      await expect(
        agent.approve(pausedHistory(), [
          { toolCallId: 'other-id', approved: true },
        ]),
      ).rejects.toThrow(BadRequestException);
      expect(executed).toBe(false);
    });

    it('discards pending calls not covered by decisions as REJECTED_BY_USER', async () => {
      registerDeleteTool();
      const id = conversations.seed([
        { role: 'user' as const, content: 'clean up' },
        {
          role: 'assistant' as const,
          content: '',
          toolCalls: [
            { id: 'a1', name: 'delete_ticket', arguments: { ticketId: 't1' } },
            { id: 'a2', name: 'delete_ticket', arguments: { ticketId: 't2' } },
          ],
        },
      ]);
      fakeLlm.addCassettes([
        {
          match: { hasToolCalls: true },
          response: endTurnResponse('Done'),
        },
      ]);

      // Only a1 is decided (approved); a2 is orphaned → treated as rejected.
      const result = await agent.approve(id, [
        { toolCallId: 'a1', approved: true },
      ]);

      expect(result.toolResults).toHaveLength(2);
      const byId = Object.fromEntries(result.toolResults.map((r) => [r.id, r]));
      expect(byId['a1'].success).toBe(true);
      expect(byId['a2']).toMatchObject({
        success: false,
        result: { code: 'REJECTED_BY_USER' },
      });
    });

    it('400 when the referenced tool is not registered or lacks requiresApproval', async () => {
      // Not registered at all
      await expect(
        agent.approve(pausedHistory(), [{ toolCallId: 'c2', approved: true }]),
      ).rejects.toThrow(BadRequestException);

      // Registered but without requiresApproval
      registry.register({
        name: 'create_ticket',
        description: 'create',
        inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
        execute: () => Promise.resolve({ success: true, data: {} }),
      });
      const createId = conversations.seed([
        { role: 'user', content: 'make one' },
        {
          role: 'assistant' as const,
          content: '',
          toolCalls: [
            { id: 'k1', name: 'create_ticket', arguments: { title: 'x' } },
          ],
        },
      ]);
      await expect(
        agent.approve(createId, [{ toolCallId: 'k1', approved: true }]),
      ).rejects.toThrow(BadRequestException);
    });

    it('approve executes the tool exactly once and continues until end_turn', async () => {
      let executeCount = 0;
      registry.register({
        name: 'delete_ticket',
        description: 'delete',
        inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
        requiresApproval: true,
        mutating: true,
        execute: () => {
          executeCount++;
          return Promise.resolve({ success: true, data: { id: 't9' } });
        },
      });
      fakeLlm.addCassettes([
        {
          match: { hasToolCalls: true },
          response: endTurnResponse('Deleted the ticket.'),
        },
      ]);

      const result = await agent.approve(pausedHistory(), [
        { toolCallId: 'c2', approved: true },
      ]);

      expect(executeCount).toBe(1);
      expect(result.stopReason).toBe('end_turn');
      expect(result.message).toBe('Deleted the ticket.');
      expect(result.iterations).toBe(2);
      expect(result.toolResults[0]).toMatchObject({
        id: 'c2',
        name: 'delete_ticket',
        success: true,
        result: { id: 't9' },
      });

      // The real result reached the model as a paired tool message
      const toolMsgs = fakeLlm.requests[0].messages.filter(
        (m) => m.role === 'tool',
      );
      expect(toolMsgs).toHaveLength(1);
      expect(toolMsgs[0].toolCallId).toBe('c2');
      expect(toolMsgs[0].content).toContain('"id":"t9"');
    });

    it('reject appends a synthetic REJECTED_BY_USER result and never executes', async () => {
      registerDeleteTool();
      fakeLlm.addCassettes([
        {
          match: { hasToolCalls: true },
          response: endTurnResponse('Understood, I will not delete it.'),
        },
      ]);

      const result = await agent.approve(pausedHistory(), [
        { toolCallId: 'c2', approved: false },
      ]);

      expect(executed).toBe(false);
      expect(result.stopReason).toBe('end_turn');
      expect(result.toolResults[0]).toMatchObject({
        id: 'c2',
        success: false,
        result: { code: 'REJECTED_BY_USER' },
      });

      const toolMsgs = fakeLlm.requests[0].messages.filter(
        (m) => m.role === 'tool',
      );
      expect(toolMsgs[0].content).toContain('REJECTED_BY_USER');
    });

    it('emits approval_granted / approval_denied per decision', async () => {
      const events: { type: string; payload: unknown }[] = [];
      eventEmitter.on('agent.approval_granted', (e) =>
        events.push({ type: 'granted', payload: e }),
      );
      eventEmitter.on('agent.approval_denied', (e) =>
        events.push({ type: 'denied', payload: e }),
      );
      registerDeleteTool();
      fakeLlm.addCassettes([
        {
          match: { hasToolCalls: true },
          response: endTurnResponse('ok'),
        },
      ]);

      await agent.approve(pausedHistory(), [
        { toolCallId: 'c2', approved: false },
      ]);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('denied');
      expect(events[0].payload).toMatchObject({
        toolCallId: 'c2',
        name: 'delete_ticket',
      });
    });

    it('re-pauses when the continuation requests another approval-needing tool', async () => {
      registerDeleteTool();
      fakeLlm.addCassettes([
        {
          match: { hasToolCalls: true },
          response: toolUseResponse('delete_ticket', { ticketId: 't8' }),
        },
      ]);

      const result = await agent.approve(pausedHistory(), [
        { toolCallId: 'c2', approved: true },
      ]);

      expect(result.stopReason).toBe('tool_use');
      expect(result.awaitingApproval?.toolCalls).toHaveLength(1);
      expect(result.awaitingApproval?.toolCalls[0]).toMatchObject({
        name: 'delete_ticket',
        arguments: { ticketId: 't8' },
      });
      // First decision was materialized before the new pause
      expect(executed).toBe(true);
      expect(result.toolResults.map((r) => r.id)).toEqual(['c2']);
    });
  });
});
