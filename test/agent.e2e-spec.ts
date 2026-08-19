import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { FakeLlmProvider } from '../src/llm/fake-llm.provider';
import { LLM_PROVIDER } from '../src/llm/llm.module';
import type { LlmResponse } from '../src/llm/llm.types';
import { PrismaService } from '../src/prisma/prisma.service';
import { asUser, createTestApp, signupAndAuth } from './utils';

let callId = 0;

function toolUse(toolName: string, args: Record<string, unknown>): LlmResponse {
  callId++;
  return {
    content: '',
    toolCalls: [{ id: `call-${callId}`, name: toolName, arguments: args }],
    stopReason: 'tool_use',
    usage: { inputTokens: 10, outputTokens: 5 },
    model: 'fake',
  };
}

function endTurn(text: string): LlmResponse {
  return {
    content: text,
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
    model: 'fake',
  };
}

/**
 * Configure the shared FakeLlmProvider for a test: clear recorded requests,
 * drop all previous cassettes by replacing the internal array, and set strict
 * to false so unmatched requests return a safe default instead of throwing.
 */
function prepareLlm(fakeLlm: FakeLlmProvider): void {
  callId = 0;
  fakeLlm.clear();
}

describe('Agent chat (e2e)', () => {
  let app: INestApplication;
  let httpServer: App;
  let prisma: PrismaService;
  let fakeLlm: FakeLlmProvider;

  beforeAll(async () => {
    app = await createTestApp();
    httpServer = app.getHttpServer();
    prisma = app.get(PrismaService);
    fakeLlm = app.get<FakeLlmProvider>(LLM_PROVIDER);

    await prisma.ticket.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.tenant.deleteMany({});
  });

  afterAll(async () => {
    await prisma.ticket.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.tenant.deleteMany({});
    await app.close();
  });

  beforeEach(() => {
    prepareLlm(fakeLlm);
  });

  it('POST /chat requires auth', async () => {
    await request(httpServer)
      .post('/chat')
      .send({ message: 'hello' })
      .expect(401);
  });

  it('returns LLM response directly when no tools are called', async () => {
    const tenant = await signupAndAuth(httpServer);

    fakeLlm.add({
      match: { includesText: 'hello' },
      response: endTurn('Hello!'),
    });

    const res = await request(httpServer)
      .post('/chat')
      .set(asUser(tenant.accessToken))
      .send({ message: 'hello' })
      .expect(201);

    expect(res.body.message).toBe('Hello!');
    expect(res.body.toolCalls).toEqual([]);
    expect(res.body.iterations).toBe(1);
    expect(res.body.stopReason).toBe('end_turn');
  });

  it('creates a ticket via tool call', async () => {
    const tenant = await signupAndAuth(httpServer);

    fakeLlm.add({
      match: { hasToolCalls: false, includesText: 'create' },
      response: toolUse('create_ticket', { title: 'Agent ticket' }),
    });
    fakeLlm.add({
      match: { hasToolCalls: true },
      response: endTurn('Created ticket "Agent ticket" for you.'),
    });

    const res = await request(httpServer)
      .post('/chat')
      .set(asUser(tenant.accessToken))
      .send({ message: 'create a ticket called Agent ticket' })
      .expect(201);

    expect(res.body.message).toBe('Created ticket "Agent ticket" for you.');
    expect(res.body.toolCalls).toHaveLength(1);
    expect(res.body.toolCalls[0].name).toBe('create_ticket');
    expect(res.body.toolResults).toHaveLength(1);
    expect(res.body.toolResults[0].success).toBe(true);
    expect(res.body.iterations).toBe(2);

    const tickets = await prisma.ticket.findMany({
      where: { tenantId: tenant.tenantId },
    });
    expect(tickets).toHaveLength(1);
    expect(tickets[0].title).toBe('Agent ticket');
  });

  it('lists tickets via tool call', async () => {
    const tenant = await signupAndAuth(httpServer);

    await request(httpServer)
      .post('/tickets')
      .set(asUser(tenant.accessToken))
      .send({ title: 'Existing ticket' })
      .expect(201);

    fakeLlm.add({
      match: { hasToolCalls: false, includesText: 'list' },
      response: toolUse('list_tickets', {}),
    });
    fakeLlm.add({
      match: { hasToolCalls: true },
      response: endTurn('You have 1 ticket: Existing ticket.'),
    });

    const res = await request(httpServer)
      .post('/chat')
      .set(asUser(tenant.accessToken))
      .send({ message: 'list my tickets' })
      .expect(201);

    expect(res.body.message).toBe('You have 1 ticket: Existing ticket.');
    expect(res.body.toolCalls[0].name).toBe('list_tickets');

    const toolResult = res.body.toolResults[0].result;
    expect(Array.isArray(toolResult)).toBe(true);
    expect(toolResult).toHaveLength(1);
    expect(toolResult[0].title).toBe('Existing ticket');
  });

  describe('cross-tenant isolation via agent', () => {
    let tenantA: { tenantId: string; accessToken: string };
    let tenantB: { tenantId: string; accessToken: string };

    beforeAll(async () => {
      tenantA = await signupAndAuth(httpServer, {
        companyName: 'Agent Tenant A',
        workspaceName: 'agent-tenant-a',
        email: 'agent-a@isolation.test',
      });
      tenantB = await signupAndAuth(httpServer, {
        companyName: 'Agent Tenant B',
        workspaceName: 'agent-tenant-b',
        email: 'agent-b@isolation.test',
      });

      await request(httpServer)
        .post('/tickets')
        .set(asUser(tenantB.accessToken))
        .send({ title: 'B private ticket' })
        .expect(201);
    });

    it('tenant A agent cannot see tenant B tickets', async () => {
      fakeLlm.add({
        match: { hasToolCalls: false, includesText: 'show' },
        response: toolUse('list_tickets', {}),
      });
      fakeLlm.add({
        match: { hasToolCalls: true },
        response: endTurn('No tickets found.'),
      });

      const res = await request(httpServer)
        .post('/chat')
        .set(asUser(tenantA.accessToken))
        .send({ message: 'show me all tickets' })
        .expect(201);

      const toolResult = res.body.toolResults[0].result;
      expect(Array.isArray(toolResult)).toBe(true);
      expect(toolResult).toHaveLength(0);
    });

    it('tenant A agent cannot access tenant B ticket by id', async () => {
      const bTickets = await prisma.ticket.findMany({
        where: { tenantId: tenantB.tenantId },
      });
      const bTicketId = bTickets[0].id;

      fakeLlm.add({
        match: { hasToolCalls: false, includesText: 'get' },
        response: toolUse('get_ticket', { ticketId: bTicketId }),
      });
      fakeLlm.add({
        match: { hasToolCalls: true },
        response: endTurn('Ticket not found.'),
      });

      const res = await request(httpServer)
        .post('/chat')
        .set(asUser(tenantA.accessToken))
        .send({ message: `get ticket ${bTicketId}` })
        .expect(201);

      expect(res.body.toolResults[0].success).toBe(false);
      expect(res.body.toolResults[0].result).toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });
});

describe('Agent max iterations (e2e)', () => {
  let app: INestApplication;
  let httpServer: App;
  let fakeLlm: FakeLlmProvider;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    httpServer = app.getHttpServer();
    prisma = app.get(PrismaService);
    fakeLlm = app.get<FakeLlmProvider>(LLM_PROVIDER);

    await prisma.ticket.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.tenant.deleteMany({});
  });

  afterAll(async () => {
    await prisma.ticket.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.tenant.deleteMany({});
    await app.close();
  });

  it('stops after max iterations with max_iterations stopReason', async () => {
    const tenant = await signupAndAuth(httpServer);

    fakeLlm.add({
      match: {},
      response: toolUse('create_ticket', { title: 'loop' }),
    });

    const res = await request(httpServer)
      .post('/chat')
      .set(asUser(tenant.accessToken))
      .send({ message: 'create a ticket' })
      .expect(201);

    expect(res.body.iterations).toBe(10);
    expect(res.body.stopReason).toBe('max_iterations');
    expect(res.body.message).toContain('maximum number of actions');
  });
});
