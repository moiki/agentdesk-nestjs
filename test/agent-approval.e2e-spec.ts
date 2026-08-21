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

describe('Agent approval flow (e2e)', () => {
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
    callId = 0;
    fakeLlm.clear();
  });

  /** Runs /chat until it pauses on a delete_ticket approval for `ticketId`. */
  async function pauseOnDelete(
    accessToken: string,
    ticketId: string,
  ): Promise<{
    body: Record<string, any>;
    userMessage: string;
  }> {
    fakeLlm.add({
      match: { hasToolCalls: false },
      response: toolUse('delete_ticket', { ticketId }),
    });
    const userMessage = `delete ticket ${ticketId}`;
    const res = await request(httpServer)
      .post('/chat')
      .set(asUser(accessToken))
      .send({ message: userMessage })
      .expect(201);

    return { body: res.body, userMessage };
  }

  /** Rebuilds the client-side conversation state from a paused response. */
  function historyFromPause(
    userMessage: string,
    pausedBody: Record<string, any>,
  ) {
    return [
      { role: 'user', content: userMessage },
      {
        role: 'assistant',
        content: '',
        toolCalls: pausedBody.awaitingApproval.toolCalls,
      },
    ];
  }

  it('POST /chat/approve requires auth', async () => {
    await request(httpServer)
      .post('/chat/approve')
      .send({
        conversationHistory: [{ role: 'user', content: 'hi' }],
        decisions: [{ toolCallId: 'call-1', approved: true }],
      })
      .expect(401);
  });

  it('approve flow pauses without side effects, then deletes exactly once', async () => {
    const tenant = await signupAndAuth(httpServer);
    const created = await request(httpServer)
      .post('/tickets')
      .set(asUser(tenant.accessToken))
      .send({ title: 'Approve me' })
      .expect(201);
    const ticketId = created.body.id;

    // Step 1 — chat pauses exposing the pending destructive call
    const { body: pausedBody, userMessage } = await pauseOnDelete(
      tenant.accessToken,
      ticketId,
    );
    expect(pausedBody.stopReason).toBe('tool_use');
    expect(pausedBody.message).toContain('approval');
    expect(pausedBody.awaitingApproval.toolCalls).toHaveLength(1);
    expect(pausedBody.awaitingApproval.toolCalls[0]).toMatchObject({
      name: 'delete_ticket',
      arguments: { ticketId },
    });
    // No side effects yet
    expect(
      await prisma.ticket.findUnique({ where: { id: ticketId } }),
    ).not.toBeNull();

    // Step 2 — approve resumes and completes the deletion
    fakeLlm.add({
      match: { hasToolCalls: true },
      response: endTurn('Ticket deleted.'),
    });
    const approveRes = await request(httpServer)
      .post('/chat/approve')
      .set(asUser(tenant.accessToken))
      .send({
        conversationHistory: historyFromPause(userMessage, pausedBody),
        decisions: [
          {
            toolCallId: pausedBody.awaitingApproval.toolCalls[0].id,
            approved: true,
          },
        ],
      })
      .expect(201);

    expect(approveRes.body.stopReason).toBe('end_turn');
    expect(approveRes.body.message).toBe('Ticket deleted.');
    expect(approveRes.body.toolResults[0]).toMatchObject({
      id: pausedBody.awaitingApproval.toolCalls[0].id,
      name: 'delete_ticket',
      success: true,
    });
    expect(
      await prisma.ticket.findUnique({ where: { id: ticketId } }),
    ).toBeNull();
  });

  it('reject flow keeps the ticket and feeds REJECTED_BY_USER to the model', async () => {
    const tenant = await signupAndAuth(httpServer);
    const created = await request(httpServer)
      .post('/tickets')
      .set(asUser(tenant.accessToken))
      .send({ title: 'Keep me' })
      .expect(201);
    const ticketId = created.body.id;

    const { body: pausedBody, userMessage } = await pauseOnDelete(
      tenant.accessToken,
      ticketId,
    );

    fakeLlm.add({
      match: { hasToolCalls: true },
      response: endTurn('Understood, cancellation kept.'),
    });
    const rejectRes = await request(httpServer)
      .post('/chat/approve')
      .set(asUser(tenant.accessToken))
      .send({
        conversationHistory: historyFromPause(userMessage, pausedBody),
        decisions: [
          {
            toolCallId: pausedBody.awaitingApproval.toolCalls[0].id,
            approved: false,
          },
        ],
      })
      .expect(201);

    expect(rejectRes.body.stopReason).toBe('end_turn');
    expect(rejectRes.body.toolResults[0].success).toBe(false);
    expect(rejectRes.body.toolResults[0].result).toMatchObject({
      code: 'REJECTED_BY_USER',
    });

    // Synthetic result reached the model as a paired tool message
    const lastRequest = fakeLlm.requests[fakeLlm.requests.length - 1];
    const toolMsg = lastRequest.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('REJECTED_BY_USER');

    // Ticket survives
    expect(
      await prisma.ticket.findUnique({ where: { id: ticketId } }),
    ).not.toBeNull();
  });

  it('400 on forged state without calling the LLM', async () => {
    const tenant = await signupAndAuth(httpServer);

    fakeLlm.add({
      match: {},
      response: endTurn('should never be returned'),
    });
    await request(httpServer)
      .post('/chat/approve')
      .set(asUser(tenant.accessToken))
      .send({
        conversationHistory: [
          { role: 'user', content: 'nothing pending here' },
        ],
        decisions: [{ toolCallId: 'made-up-id', approved: true }],
      })
      .expect(400);

    expect(fakeLlm.requests).toHaveLength(0);
  });

  it('400 when payload shape is invalid (validation pipe)', async () => {
    const tenant = await signupAndAuth(httpServer);

    await request(httpServer)
      .post('/chat/approve')
      .set(asUser(tenant.accessToken))
      .send({
        conversationHistory: [{ role: 'user', content: 'hi' }],
        decisions: [{ toolCallId: 'call-1' }], // missing `approved`
      })
      .expect(400);

    await request(httpServer)
      .post('/chat/approve')
      .set(asUser(tenant.accessToken))
      .send({
        conversationHistory: [{ role: 'user', content: 'hi' }],
        decisions: [{ toolCallId: 'call-1', approved: true }],
        sneakyExtraField: true, // forbidNonWhitelisted
      })
      .expect(400);
  });

  describe('cross-tenant isolation through approve', () => {
    it('tenant A approving delete of tenant B ticket gets NOT_FOUND', async () => {
      const tenantA = await signupAndAuth(httpServer);
      const tenantB = await signupAndAuth(httpServer);
      const createdB = await request(httpServer)
        .post('/tickets')
        .set(asUser(tenantB.accessToken))
        .send({ title: 'B private' })
        .expect(201);
      const bTicketId = createdB.body.id;

      const { body: pausedBody, userMessage } = await pauseOnDelete(
        tenantA.accessToken,
        bTicketId,
      );

      fakeLlm.add({
        match: { hasToolCalls: true },
        response: endTurn('That ticket does not exist.'),
      });
      const res = await request(httpServer)
        .post('/chat/approve')
        .set(asUser(tenantA.accessToken))
        .send({
          conversationHistory: historyFromPause(userMessage, pausedBody),
          decisions: [
            {
              toolCallId: pausedBody.awaitingApproval.toolCalls[0].id,
              approved: true,
            },
          ],
        })
        .expect(201);

      expect(res.body.toolResults[0].success).toBe(false);
      expect(res.body.toolResults[0].result).toMatchObject({
        code: 'NOT_FOUND',
      });
      // Tenant B ticket untouched
      expect(
        await prisma.ticket.findUnique({ where: { id: bTicketId } }),
      ).not.toBeNull();
    });
  });

  it('approve can chain into a new pause when the model requests another approval', async () => {
    const tenant = await signupAndAuth(httpServer);
    const created = await request(httpServer)
      .post('/tickets')
      .set(asUser(tenant.accessToken))
      .send({ title: 'First' })
      .expect(201);
    const firstId = created.body.id;
    const second = await request(httpServer)
      .post('/tickets')
      .set(asUser(tenant.accessToken))
      .send({ title: 'Second' })
      .expect(201);
    const secondId = second.body.id;

    // Pause #1 on the first ticket
    const { body: pausedBody, userMessage } = await pauseOnDelete(
      tenant.accessToken,
      firstId,
    );

    // Resume asks for ANOTHER approval-required call → re-pause
    fakeLlm.add({
      match: { hasToolCalls: true },
      response: toolUse('delete_ticket', { ticketId: secondId }),
    });
    const resumeRes = await request(httpServer)
      .post('/chat/approve')
      .set(asUser(tenant.accessToken))
      .send({
        conversationHistory: historyFromPause(userMessage, pausedBody),
        decisions: [
          {
            toolCallId: pausedBody.awaitingApproval.toolCalls[0].id,
            approved: true,
          },
        ],
      })
      .expect(201);

    expect(resumeRes.body.stopReason).toBe('tool_use');
    // First decision materialized: its result is present and side effect happened
    expect(resumeRes.body.toolResults[0]).toMatchObject({
      id: pausedBody.awaitingApproval.toolCalls[0].id,
      success: true,
    });
    expect(
      await prisma.ticket.findUnique({ where: { id: firstId } }),
    ).toBeNull();
    // New pending set exposed for the second ticket
    expect(resumeRes.body.awaitingApproval.toolCalls).toHaveLength(1);
    expect(resumeRes.body.awaitingApproval.toolCalls[0]).toMatchObject({
      name: 'delete_ticket',
      arguments: { ticketId: secondId },
    });
    expect(
      await prisma.ticket.findUnique({ where: { id: secondId } }),
    ).not.toBeNull();

    // Second decision also works from the re-paused state
    fakeLlm.clear();
    fakeLlm.add({
      match: { hasToolCalls: true },
      response: endTurn('Both deleted.'),
    });
    const history2 = [
      ...historyFromPause(userMessage, pausedBody),
      {
        role: 'tool',
        content: JSON.stringify(
          resumeRes.body.toolResults[0].result ?? { deleted: true },
        ),
        toolCallId: pausedBody.awaitingApproval.toolCalls[0].id,
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: resumeRes.body.awaitingApproval.toolCalls,
      },
    ];
    const finalRes = await request(httpServer)
      .post('/chat/approve')
      .set(asUser(tenant.accessToken))
      .send({
        conversationHistory: history2,
        decisions: [
          {
            toolCallId: resumeRes.body.awaitingApproval.toolCalls[0].id,
            approved: true,
          },
        ],
      })
      .expect(201);

    expect(finalRes.body.stopReason).toBe('end_turn');
    expect(
      await prisma.ticket.findUnique({ where: { id: secondId } }),
    ).toBeNull();
  });

  it('approve with arguments that fail the Zod schema yields VALIDATION_ERROR without deleting', async () => {
    const tenant = await signupAndAuth(httpServer);
    const created = await request(httpServer)
      .post('/tickets')
      .set(asUser(tenant.accessToken))
      .send({ title: 'Survives bad args' })
      .expect(201);
    const ticketId = created.body.id;

    fakeLlm.add({
      match: { hasToolCalls: true },
      response: endTurn('Could not delete that ticket.'),
    });

    // Forged-but-plausible pause whose arguments violate z.string().uuid()
    const badCallId = 'call-bad-args';
    const res = await request(httpServer)
      .post('/chat/approve')
      .set(asUser(tenant.accessToken))
      .send({
        conversationHistory: [
          { role: 'user', content: 'delete it' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: badCallId,
                name: 'delete_ticket',
                arguments: { ticketId: 'not-a-uuid' },
              },
            ],
          },
        ],
        decisions: [{ toolCallId: badCallId, approved: true }],
      })
      .expect(201);

    expect(res.body.stopReason).toBe('end_turn');
    expect(res.body.toolResults[0]).toMatchObject({
      id: badCallId,
      name: 'delete_ticket',
      success: false,
    });
    expect(res.body.toolResults[0].result.code).toBe('VALIDATION_ERROR');
    // Schema rejection means zero destructive effect
    expect(
      await prisma.ticket.findUnique({ where: { id: ticketId } }),
    ).not.toBeNull();
  });
});
