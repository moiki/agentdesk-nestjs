import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from '../agent/agent.service';
import { tenantContextStore } from '../tenancy/tenant-context';

/**
 * Groq smoke test — REAL model, REAL database. Standalone on purpose:
 * it needs network + credentials, so it never runs under Jest/CI.
 *
 *   pnpm run test:groq   (the script itself forces LLM_PROVIDER=groq)
 *
 * Flow: pause (model requests delete_ticket) → approve → ticket deleted.
 * Cleans up its tenant (cascade) in finally; exits 1 on any failure.
 */
async function main(): Promise<number> {
  if (!process.env.GROQ_API_KEY) {
    console.warn('⚠️  GROQ_API_KEY not set — skipping Groq smoke test.');
    return 0;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const prisma = app.get(PrismaService);
  const agent = app.get(AgentService);

  const tenant = await prisma.tenant.create({
    data: { name: 'Groq Smoke', slug: `groq-smoke-${Date.now()}` },
  });

  try {
    const ticket = await prisma.ticket.create({
      data: { title: `Groq smoke ticket ${Date.now()}`, tenantId: tenant.id },
    });
    console.log(`🎟️  Ticket created: ${ticket.id}`);

    await tenantContextStore.run({ tenantId: tenant.id }, async () => {
      // Phase 1 — the model should request delete_ticket → loop pauses
      const paused = await agent.chat(
        `Delete the ticket with id "${ticket.id}" using the delete_ticket tool. Do not ask questions.`,
      );
      console.log('⏸️  Phase 1 stopReason:', paused.stopReason);
      if (!paused.awaitingApproval?.toolCalls.length) {
        throw new Error(
          `Expected a pause with pending tool calls, got: ${JSON.stringify({
            stopReason: paused.stopReason,
            awaitingApproval: paused.awaitingApproval,
          })}`,
        );
      }
      console.log('⏸️  Pending call:', paused.awaitingApproval.toolCalls[0]);

      if (!(await prisma.ticket.findUnique({ where: { id: ticket.id } }))) {
        throw new Error('Ticket was deleted BEFORE approval!');
      }

      // Phase 2 — human approves → tool runs once → end_turn
      const final = await agent.approve(
        [
          {
            role: 'user',
            content: `Delete the ticket with id "${ticket.id}" using the delete_ticket tool. Do not ask questions.`,
          },
          {
            role: 'assistant',
            content: paused.message,
            toolCalls: paused.awaitingApproval.toolCalls,
          },
        ],
        [
          {
            toolCallId: paused.awaitingApproval.toolCalls[0].id,
            approved: true,
          },
        ],
      );
      console.log('▶️  Phase 2 stopReason:', final.stopReason);
      console.log('💬 Model:', final.message);
      console.log('🔧 toolResults:', JSON.stringify(final.toolResults));

      if (final.stopReason !== 'end_turn') {
        throw new Error(`Expected end_turn, got ${final.stopReason}`);
      }
    });

    if (await prisma.ticket.findUnique({ where: { id: ticket.id } })) {
      throw new Error('Ticket still exists after approval flow');
    }
    console.log('✅ Groq smoke passed — real model, real tools, clean DB.');
    return 0;
  } finally {
    await prisma.tenant
      .delete({ where: { id: tenant.id } })
      .catch(() => undefined);
    await app.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('❌ Groq smoke failed:', error);
    process.exit(1);
  });
