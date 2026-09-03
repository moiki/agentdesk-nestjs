import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Mutex } from 'async-mutex';
import { ENV } from '../common/constants';
import type { LlmProvider } from '../llm/llm-provider.interface';
import { LLM_PROVIDER } from '../llm/llm.module';
import type {
  ChatMessage,
  LlmStopReason,
  LlmToolCall,
  LlmUsage,
} from '../llm/llm.types';
import { ToolRegistry } from './tools/tool-registry.service';
import type { ToolResult } from './tools/tool.interface';
import { ConversationService } from './conversation.service';
import { ConversationStatus } from '../generated/prisma/client';
import { getTenantContext } from '../tenancy/tenant-context';
import { TenantScopedPrismaService } from '../tenancy/tenant-scoped-prisma.service';
import { TenantPromptService } from './prompts/tenant-prompt.service';
import type { TenantPromptContext } from './prompts/tenant-prompt.types';
import { TracingService } from '../tracing/tracing.service';
import type { TraceObservation } from '../tracing/tracing.service';
import { isUniqueViolation } from '../common/prisma-error';

export interface ToolCallResult {
  id: string;
  name: string;
  success: boolean;
  result: unknown;
}

export interface ChatResponse {
  /** Server-side conversation handle. Every /chat and /chat/approve returns it. */
  conversationId: string;
  message: string;
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
  toolResults: ToolCallResult[];
  usage: LlmUsage;
  stopReason: LlmStopReason;
  iterations: number;
  /** Set when the loop paused waiting for human approval (requiresApproval tools). */
  awaitingApproval?: PendingApproval;
}

export interface PendingApproval {
  toolCalls: LlmToolCall[];
}

interface LoopBudget {
  maxIterations: number;
  maxTotalTokens: number;
  maxWallClockMs: number;
}

/** Mutable per-run state accumulated across loop iterations. */
interface LoopAccumulators {
  toolCalls: ChatResponse['toolCalls'];
  toolResults: ToolCallResult[];
  usage: LlmUsage;
  iterations: number;
}

function getUserId(): string | undefined {
  return getTenantContext()?.userId;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly budget: LoopBudget;
  private readonly maxRetries: number;

  /**
   * Per-conversation mutexes serializing chat/approve turns on the same
   * conversation. Prevents concurrent requests from both running the agent
   * loop and double-executing mutating tools, or one request silently
   * overwriting another's persisted history. Entries are evicted once no
   * waiter remains to keep memory flat.
   */
  private readonly locks = new Map<string, Mutex>();

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly registry: ToolRegistry,
    private readonly eventEmitter: EventEmitter2,
    private readonly conversations: ConversationService,
    private readonly tenantPrompts: TenantPromptService,
    private readonly scopedPrisma: TenantScopedPrismaService,
    private readonly tracing: TracingService,
  ) {
    this.budget = {
      maxIterations: ENV.AGENT_MAX_ITERATIONS,
      maxTotalTokens: ENV.AGENT_MAX_TOTAL_TOKENS,
      maxWallClockMs: ENV.AGENT_MAX_WALL_CLOCK_MS,
    };
    this.maxRetries = ENV.AGENT_LLM_MAX_RETRIES;
  }

  /**
   * Runs the agent for a user message. The conversation is persisted
   * server-side: pass a `conversationId` to continue an existing thread, or
   * omit it to start a new one. The harness owns the message history, so the
   * persisted state is always consistent (no orphaned tool calls), even if the
   * client disconnects mid-turn.
   */
  async chat(
    userMessage: string,
    conversationHistory?: ChatMessage[],
    systemPrompt?: string,
    conversationId?: string,
    idempotencyKey?: string,
  ): Promise<ChatResponse> {
    // Continuing an existing thread must be serialized on that conversation so
    // concurrent /chat and /approve calls can't double-run tools or clobber
    // each other's persisted history.
    if (conversationId) {
      return this.withConversationLock(conversationId, () =>
        this.runChatTurn(
          userMessage,
          conversationHistory,
          systemPrompt,
          conversationId,
          true,
        ),
      );
    }

    // New thread: create it (deduplicating by idempotencyKey on retry), then
    // run it under the mutex on the resolved conversation.
    const resolved = await this.createConversationForChat(
      conversationHistory ?? [],
      idempotencyKey,
    );
    return this.withConversationLock(resolved.id, () =>
      this.runChatTurn(
        userMessage,
        conversationHistory,
        systemPrompt,
        resolved.id,
        resolved.isExisting,
      ),
    );
  }

  /**
   * Creates a new conversation, or resolves to the original one when the client
   * supplied an `idempotencyKey` that was already used (retried /chat). The
   * Postgres unique constraint on `(tenantId, idempotencyKey)` is the atomic
   * guard — exactly one conversation row is ever created per key.
   */
  private async createConversationForChat(
    history: ChatMessage[],
    idempotencyKey?: string,
  ): Promise<{ id: string; isExisting: boolean }> {
    try {
      const created = await this.conversations.create(history, {
        userId: getUserId(),
        idempotencyKey,
      });
      return { id: created.id, isExisting: false };
    } catch (err) {
      if (idempotencyKey && isUniqueViolation(err)) {
        const existing =
          await this.conversations.findByIdempotencyKey(idempotencyKey);
        if (existing) {
          return { id: existing.id, isExisting: true };
        }
      }
      throw err;
    }
  }

  /** Runs the traced agent turn for a chat message under an acquired lock. */
  private async runChatTurn(
    userMessage: string,
    conversationHistory: ChatMessage[] | undefined,
    systemPrompt: string | undefined,
    conversationId: string,
    reloadFromDb: boolean,
  ): Promise<ChatResponse> {
    const ctx = getTenantContext();
    return this.tracing.traceAgentTurn<ChatResponse>(
      {
        name: 'agent-turn',
        input: userMessage,
        userId: ctx?.userId,
        sessionId: conversationId,
        tags: ['agent-desktop', 'chat'],
        metadata: { tenantId: ctx?.tenantId ?? '', endpoint: 'chat' },
      },
      async (span) => {
        // Fresh turn: forget any cached tool results from a prior turn so a
        // reused toolCallId always triggers a real execution.
        this.registry.startTurn();

        // Base history: persisted state (existing thread) or client history
        // (fresh thread). The version ref threads optimistic-locking through
        // every persist so concurrent writers are detected (defense in depth
        // on top of the mutex).
        const persisted = reloadFromDb
          ? await this.loadConversation(conversationId)
          : null;
        const base = persisted ? persisted.messages : conversationHistory;
        const messages: ChatMessage[] = [
          ...(base ?? []),
          { role: 'user', content: userMessage },
        ];

        // The system prompt is composed per-tenant by the server. A
        // client-supplied 'systemPrompt' is treated as optional, capped extra
        // instructions only — it can no longer hijack the agent's identity.
        const system = await this.resolveSystemPrompt(systemPrompt);

        const versionRef = { current: persisted?.version };
        const response = await this.runLoop(
          messages,
          system,
          {
            toolCalls: [],
            toolResults: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            iterations: 0,
          },
          conversationId,
          (next, status) =>
            this.persistConversation(conversationId, next, status, versionRef),
        );
        this.setTurnOutput(span, response);
        return response;
      },
    );
  }

  /**
   * Persists conversation messages, advancing the optimistic-lock version ref
   * so the next persist within this turn CAS's against the just-written state.
   */
  private async persistConversation(
    id: string,
    messages: ChatMessage[],
    status: ConversationStatus | undefined,
    versionRef: { current: number | undefined },
  ): Promise<void> {
    await this.conversations.updateMessages(
      id,
      messages,
      status,
      versionRef.current,
    );
    if (versionRef.current !== undefined) {
      versionRef.current += 1;
    }
  }

  /**
   * Serializes a critical section on a conversation via a per-conversation
   * mutex. Evicts the mutex from the map once no waiter remains.
   */
  private async withConversationLock<T>(
    conversationId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let mutex = this.locks.get(conversationId);
    if (!mutex) {
      mutex = new Mutex();
      this.locks.set(conversationId, mutex);
    }
    try {
      return await mutex.runExclusive(fn);
    } finally {
      if (!mutex.isLocked && this.locks.get(conversationId) === mutex) {
        this.locks.delete(conversationId);
      }
    }
  }

  /**
   * Resumes a paused run after a human decision.
   *
   * The conversation state is loaded from the server (source of truth), so the
   * history can never be forged or corrupted by a crashed client. Pending =
   * the awaitingApproval tool calls persisted on the paused turn. Decisions
   * are applied per call; any pending call NOT covered by a decision (e.g.
   * orphaned by an interrupted session) is treated as REJECTED_BY_USER —
   * it is never executed, but the loop still recovers instead of 400ing.
   */
  async approve(
    conversationId: string,
    decisions: { toolCallId: string; approved: boolean }[],
  ): Promise<ChatResponse> {
    // Serialize the whole approve flow on the conversation so concurrent
    // /approve calls can't both execute the same pending tool.
    return this.withConversationLock(conversationId, () =>
      this.runApproveTurn(conversationId, decisions),
    );
  }

  private async runApproveTurn(
    conversationId: string,
    decisions: { toolCallId: string; approved: boolean }[],
  ): Promise<ChatResponse> {
    this.registry.startTurn();
    const existing = await this.loadConversation(conversationId);
    const messages: ChatMessage[] = (existing.messages ?? []).map((m) => ({
      ...m,
    }));
    const versionRef = { current: existing.version };

    // Pending = assistant toolCalls without an answering role:'tool' message.
    const answeredIds = new Set(
      messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId),
    );
    const pending: LlmToolCall[] = messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.toolCalls ?? [])
      .filter((tc) => !answeredIds.has(tc.id));

    if (pending.length === 0) {
      throw new BadRequestException(
        'No pending approval tool calls found for this conversation.',
      );
    }

    // Decisions must not be duplicated and may only reference the pending set.
    const decisionById = new Map<string, boolean>();
    for (const decision of decisions) {
      if (decisionById.has(decision.toolCallId)) {
        throw new BadRequestException(
          `Duplicate decision for toolCallId "${decision.toolCallId}".`,
        );
      }
      if (!pending.some((tc) => tc.id === decision.toolCallId)) {
        throw new BadRequestException(
          `Unknown toolCallId "${decision.toolCallId}".`,
        );
      }
      decisionById.set(decision.toolCallId, decision.approved);
    }

    // Only tools explicitly flagged requiresApproval are decidable here.
    for (const tc of pending) {
      const tool = this.registry.getTool(tc.name);
      if (!tool || tool.requiresApproval !== true) {
        throw new BadRequestException(
          `Tool "${tc.name}" is not part of the approval flow.`,
        );
      }
    }

    // The paused turn already consumed one iteration of the budget.
    const acc: LoopAccumulators = {
      toolCalls: [],
      toolResults: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      iterations: 1,
    };

    // Orphaned pending calls (no decision) are discarded as rejected: they are
    // never executed, but the conversation recovers instead of being stuck.
    const allDecided = new Set(decisionById.keys());
    const effective: { tc: LlmToolCall; approved: boolean }[] = pending.map(
      (tc) => ({
        tc,
        approved: allDecided.has(tc.id)
          ? decisionById.get(tc.id) === true
          : false,
      }),
    );

    for (const { tc, approved } of effective) {
      acc.toolCalls.push(tc);

      const result = approved
        ? await this.executeTracedTool(tc.name, tc.arguments, tc.id)
        : {
            success: false as const,
            error: {
              code: 'REJECTED_BY_USER' as const,
              message: 'The user denied this action.',
            },
          };

      this.eventEmitter.emit(
        approved ? 'agent.approval_granted' : 'agent.approval_denied',
        { toolCallId: tc.id, name: tc.name, iteration: acc.iterations },
      );

      acc.toolResults.push({
        id: tc.id,
        name: tc.name,
        success: result.success,
        result: result.success ? result.data : result.error,
      });

      messages.push({
        role: 'tool',
        content: JSON.stringify(result.success ? result.data : result.error),
        toolCallId: tc.id,
      });
    }

    const ctx = getTenantContext();
    return this.tracing.traceAgentTurn<ChatResponse>(
      {
        name: 'agent-turn',
        input: {
          conversationId,
          decisions: decisions.map((d) => d.toolCallId),
        },
        userId: ctx?.userId,
        sessionId: conversationId,
        tags: ['agent-desktop', 'approval'],
        metadata: { tenantId: ctx?.tenantId ?? '', endpoint: 'approve' },
      },
      async (span) => {
        const response = await this.runLoop(
          messages,
          await this.resolveSystemPrompt(),
          acc,
          conversationId,
          (next, status) =>
            this.persistConversation(conversationId, next, status, versionRef),
        );
        this.setTurnOutput(span, response);
        return response;
      },
    );
  }

  /**
   * Composes the system prompt for the current tenant (identity base + tenant
   * context) and appends optional, capped client extra instructions.
   *
   * Uses the active tenant from AsyncLocalStorage. When there is no tenant
   * context or the Tenant row cannot be loaded, it degrades gracefully to the
   * identity base — the loop never fails because prompt composition failed.
   */
  private async resolveSystemPrompt(
    extraInstructions?: string,
  ): Promise<string> {
    const tenantId = getTenantContext()?.tenantId;
    let ctx: TenantPromptContext | null = null;

    if (tenantId) {
      try {
        const tenant = await this.scopedPrisma.prisma.tenant.findUnique({
          where: { id: tenantId },
        });
        if (tenant) {
          ctx = {
            id: tenant.id,
            name: tenant.name,
            domain: tenant.slug,
            plan: tenant.plan,
            industry: tenant.industry,
            companyDescription: tenant.companyDescription,
            supportEmail: tenant.supportEmail,
            supportPhone: tenant.supportPhone,
            brandVoice: tenant.brandVoice,
            defaultLanguage: tenant.defaultLanguage,
          };
        }
      } catch (err) {
        this.logger.warn(
          `Failed to load tenant context for prompt (${tenantId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const base = this.tenantPrompts.buildForTenant(ctx);
    return this.tenantPrompts.appendExtraInstructions(base, extraInstructions);
  }

  /**
   * Executes a tool call wrapped in a Langfuse `tool` observation. Records the
   * outcome (data or error) on the observation so the trace shows exactly what
   * each tool returned to the model.
   */
  private async executeTracedTool(
    name: string,
    input: Record<string, unknown>,
    toolCallId?: string,
  ): Promise<ToolResult> {
    const tool = this.tracing.startTool(name, input);
    try {
      const result = await this.registry.execute(name, input, toolCallId);
      tool?.update({
        output: result.success ? result.data : result.error,
        level: result.success ? 'DEFAULT' : 'WARNING',
        statusMessage: result.success
          ? undefined
          : (result.error?.message ?? 'Tool call failed'),
      });
      tool?.end();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tool?.update({ level: 'ERROR', statusMessage: message });
      tool?.end();
      throw err;
    }
  }

  /** Sets the human-meaningful output on the turn's root observation. */
  private setTurnOutput(
    span: TraceObservation | null,
    response: ChatResponse,
  ): void {
    span?.update({
      output: {
        message: response.message,
        stopReason: response.stopReason,
        iterations: response.iterations,
        awaitedApproval: response.awaitingApproval !== undefined,
      },
    });
  }

  /**
   * Loads a conversation owned by the active tenant and returns its persisted
   * message history. Cross-tenant or missing ids fail closed (404).
   */
  private async loadConversation(conversationId: string) {
    const conversation = await this.conversations.find(conversationId);
    return {
      id: conversation.id,
      messages: this.conversations.toMessages(conversation.messages),
      version: conversation.version as number | undefined,
    };
  }

  /**
   * Core agentic loop. Shared by `chat()` (fresh run) and the approval-resume
   * flow (seeded accumulators + pre-built message history). Persists the
   * message history via `persist` at every terminal point (pause or finish),
   * so a client disconnect never leaves the server with stale/orphaned state.
   */
  private async runLoop(
    messages: ChatMessage[],
    system: string,
    acc: LoopAccumulators,
    conversationId: string,
    persist: (
      messages: ChatMessage[],
      status?: ConversationStatus,
    ) => Promise<unknown>,
  ): Promise<ChatResponse> {
    const tools = this.registry.getDefinitions();
    const startTime = Date.now();

    while (acc.iterations < this.budget.maxIterations) {
      // Check composite budget before each LLM call
      const budgetCheck = this.checkBudget(
        acc.iterations,
        acc.usage,
        startTime,
      );
      if (budgetCheck) {
        this.logger.warn(`Budget exceeded: ${budgetCheck}`);
        const response = {
          message: `I stopped early: ${budgetCheck}. Please try a simpler request.`,
          toolCalls: acc.toolCalls,
          toolResults: acc.toolResults,
          usage: acc.usage,
          stopReason: 'max_iterations' as const,
          iterations: acc.iterations,
        };
        await persist(messages, ConversationStatus.COMPLETED);
        return { conversationId, ...response };
      }

      acc.iterations++;

      const response = await this.callLlmWithRetry(
        messages,
        tools,
        system,
        `iteration-${acc.iterations}`,
      );

      acc.usage.inputTokens += response.usage.inputTokens;
      acc.usage.outputTokens += response.usage.outputTokens;

      this.eventEmitter.emit('agent.iteration', {
        iteration: acc.iterations,
        stopReason: response.stopReason,
        toolCallCount: response.toolCalls.length,
        usage: response.usage,
      });

      // Exit: model finished or no tool calls
      if (
        response.stopReason !== 'tool_use' ||
        response.toolCalls.length === 0
      ) {
        await persist(messages, ConversationStatus.COMPLETED);
        return {
          conversationId,
          message: response.content,
          toolCalls: acc.toolCalls,
          toolResults: acc.toolResults,
          usage: acc.usage,
          stopReason: response.stopReason,
          iterations: acc.iterations,
        };
      }

      // Append assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      });

      // Partition into read-only (parallel), mutating (sequential) and
      // approval-needing (paused, never executed here) tool calls. Safe tools
      // in a mixed batch still run so the pending set stays fully decidable
      // and the history keeps every tool_use paired with a tool result.
      const readOnly: LlmToolCall[] = [];
      const mutating: LlmToolCall[] = [];
      const needsApproval: LlmToolCall[] = [];

      for (const tc of response.toolCalls) {
        const tool = this.registry.getTool(tc.name);
        if (tool?.requiresApproval === true) {
          needsApproval.push(tc);
        } else if (tool?.mutating) {
          mutating.push(tc);
        } else {
          readOnly.push(tc);
        }
      }

      // Execute read-only tools in parallel
      await this.executeReadOnly(readOnly, messages, acc);

      // Execute mutating tools sequentially (preserves order + enables idempotency)
      for (const tc of mutating) {
        acc.toolCalls.push(tc);

        const result = await this.executeTracedTool(
          tc.name,
          tc.arguments,
          tc.id,
        );
        acc.toolResults.push({
          id: tc.id,
          name: tc.name,
          success: result.success,
          result: result.success ? result.data : result.error,
        });

        messages.push({
          role: 'tool',
          content: JSON.stringify(result.success ? result.data : result.error),
          toolCallId: tc.id,
        });
      }

      // Pause AFTER safe execution when destructive tools are pending.
      if (needsApproval.length > 0) {
        this.eventEmitter.emit('agent.awaiting_approval', {
          toolCalls: needsApproval,
          iteration: acc.iterations,
        });
        // Persist the pending state so /chat/approve can recover it even if
        // the client disconnected after the pause.
        await persist(messages, ConversationStatus.PAUSED);
        return {
          conversationId,
          message:
            'I need your approval before proceeding with the following actions.',
          toolCalls: [...acc.toolCalls, ...needsApproval],
          toolResults: acc.toolResults,
          usage: acc.usage,
          stopReason: 'tool_use',
          iterations: acc.iterations,
          awaitingApproval: { toolCalls: needsApproval },
        };
      }
    }

    this.logger.warn(
      `Agent loop hit max iterations (${this.budget.maxIterations}) — forcing stop`,
    );

    await persist(messages, ConversationStatus.COMPLETED);
    return {
      conversationId,
      message:
        'I reached the maximum number of actions for this request. Please try again with a simpler request.',
      toolCalls: acc.toolCalls,
      toolResults: acc.toolResults,
      usage: acc.usage,
      stopReason: 'max_iterations',
      iterations: acc.iterations,
    };
  }

  /** Executes read-only tools concurrently and records results/messages. */
  private async executeReadOnly(
    readOnly: LlmToolCall[],
    messages: ChatMessage[],
    acc: LoopAccumulators,
  ): Promise<void> {
    if (readOnly.length === 0) return;

    const results = await Promise.allSettled(
      readOnly.map(async (tc) => ({
        tc,
        result: await this.executeTracedTool(tc.name, tc.arguments, tc.id),
      })),
    );

    for (const settled of results) {
      if (settled.status === 'fulfilled') {
        const { tc, result } = settled.value;
        acc.toolCalls.push(tc);
        acc.toolResults.push({
          id: tc.id,
          name: tc.name,
          success: result.success,
          result: result.success ? result.data : result.error,
        });
        messages.push({
          role: 'tool',
          content: JSON.stringify(result.success ? result.data : result.error),
          toolCallId: tc.id,
        });
      } else {
        // Promise itself rejected (shouldn't happen, but defensive)
        const index = results.indexOf(settled);
        const tc = readOnly[index];
        acc.toolCalls.push(tc);
        acc.toolResults.push({
          id: tc.id,
          name: tc.name,
          success: false,
          result: {
            code: 'INTERNAL_ERROR',
            message: 'Tool execution failed unexpectedly',
          },
        });
        messages.push({
          role: 'tool',
          content: JSON.stringify({
            code: 'INTERNAL_ERROR',
            message: 'Tool execution failed unexpectedly',
          }),
          toolCallId: tc.id,
        });
      }
    }
  }

  private checkBudget(
    iterations: number,
    usage: LlmUsage,
    startTime: number,
  ): string | null {
    if (iterations >= this.budget.maxIterations) {
      return `max iterations reached (${this.budget.maxIterations})`;
    }
    const totalTokens = usage.inputTokens + usage.outputTokens;
    if (totalTokens >= this.budget.maxTotalTokens) {
      return `token budget exceeded (${totalTokens}/${this.budget.maxTotalTokens})`;
    }
    if (Date.now() - startTime >= this.budget.maxWallClockMs) {
      return `wall clock budget exceeded (${this.budget.maxWallClockMs}ms)`;
    }
    return null;
  }

  private async callLlmWithRetry(
    messages: ChatMessage[],
    tools: ReturnType<ToolRegistry['getDefinitions']>,
    system: string,
    contextLabel: string,
  ) {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const generation = this.tracing.startLlmCall('llm-call', {
        model: ENV.LLM_MODEL,
        input: { system, messages, tools },
      });
      try {
        const response = await this.llm.complete({
          model: ENV.LLM_MODEL,
          system,
          messages,
          tools,
        });
        generation?.update({
          model: response.model,
          output: {
            content: response.content,
            toolCalls: response.toolCalls,
            stopReason: response.stopReason,
          },
          usageDetails: {
            input: response.usage.inputTokens,
            output: response.usage.outputTokens,
          },
        });
        generation?.end();
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(
          `LLM call failed (attempt ${attempt}/${this.maxRetries}, ${contextLabel}): ${lastError.message}`,
        );
        generation?.update({
          level: 'ERROR',
          statusMessage: lastError.message,
        });
        generation?.end();

        if (attempt < this.maxRetries) {
          // Exponential backoff: 500ms, 1000ms, ...
          const delayMs = 500 * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }

    // All retries exhausted — throw so the caller can handle
    throw lastError ?? new Error('LLM call failed after retries');
  }
}
