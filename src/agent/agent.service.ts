import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
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

export interface ToolCallResult {
  id: string;
  name: string;
  success: boolean;
  result: unknown;
}

export interface ChatResponse {
  message: string;
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
  toolResults: ToolCallResult[];
  usage: LlmUsage;
  stopReason: LlmStopReason;
  iterations: number;
}

export interface PendingApproval {
  toolCalls: LlmToolCall[];
  conversationState: ChatMessage[];
}

interface LoopBudget {
  maxIterations: number;
  maxTotalTokens: number;
  maxWallClockMs: number;
}

const DEFAULT_SYSTEM_PROMPT = `You are AgentDesk, an AI support agent. You help users manage their support tickets.
You can create, list, search, update, and delete tickets. Always be helpful and concise.
When a user asks you to do something with tickets, use the appropriate tool.
When a tool returns an error, analyze the error code:
- NOT_FOUND: the resource doesn't exist, try a different ID or ask the user
- VALIDATION_ERROR: fix the input and retry
- INTERNAL_ERROR: do NOT retry, tell the user something went wrong on our end`;

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly budget: LoopBudget;
  private readonly defaultSystemPrompt: string;
  private readonly maxRetries: number;

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly registry: ToolRegistry,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.budget = {
      maxIterations: ENV.AGENT_MAX_ITERATIONS,
      maxTotalTokens: ENV.AGENT_MAX_TOTAL_TOKENS,
      maxWallClockMs: ENV.AGENT_MAX_WALL_CLOCK_MS,
    };
    this.defaultSystemPrompt = ENV.AGENT_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
    this.maxRetries = ENV.AGENT_LLM_MAX_RETRIES;
  }

  async chat(
    userMessage: string,
    conversationHistory?: ChatMessage[],
    systemPrompt?: string,
  ): Promise<ChatResponse> {
    const tools = this.registry.getDefinitions();
    const messages: ChatMessage[] = [
      ...(conversationHistory ?? []),
      { role: 'user', content: userMessage },
    ];

    const allToolCalls: ChatResponse['toolCalls'] = [];
    const allToolResults: ToolCallResult[] = [];
    const totalUsage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    let iterations = 0;
    const startTime = Date.now();

    while (iterations < this.budget.maxIterations) {
      // Check composite budget before each LLM call
      const budgetCheck = this.checkBudget(iterations, totalUsage, startTime);
      if (budgetCheck) {
        this.logger.warn(`Budget exceeded: ${budgetCheck}`);
        return {
          message: `I stopped early: ${budgetCheck}. Please try a simpler request.`,
          toolCalls: allToolCalls,
          toolResults: allToolResults,
          usage: totalUsage,
          stopReason: 'max_iterations',
          iterations,
        };
      }

      iterations++;

      const response = await this.callLlmWithRetry(
        messages,
        tools,
        systemPrompt ?? this.defaultSystemPrompt,
        `iteration-${iterations}`,
      );

      totalUsage.inputTokens += response.usage.inputTokens;
      totalUsage.outputTokens += response.usage.outputTokens;

      this.eventEmitter.emit('agent.iteration', {
        iteration: iterations,
        stopReason: response.stopReason,
        toolCallCount: response.toolCalls.length,
        usage: response.usage,
      });

      // Exit: model finished or no tool calls
      if (
        response.stopReason !== 'tool_use' ||
        response.toolCalls.length === 0
      ) {
        return {
          message: response.content,
          toolCalls: allToolCalls,
          toolResults: allToolResults,
          usage: totalUsage,
          stopReason: response.stopReason,
          iterations,
        };
      }

      // Append assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      });

      // Check for tools requiring approval — pause and return pending state
      const needsApproval = response.toolCalls.filter((tc) => {
        const tool = this.registry.getTool(tc.name);
        return tool?.requiresApproval === true;
      });

      if (needsApproval.length > 0) {
        this.eventEmitter.emit('agent.awaiting_approval', {
          toolCalls: needsApproval,
          iteration: iterations,
        });
        return {
          message:
            'I need your approval before proceeding with the following actions.',
          toolCalls: [...allToolCalls, ...needsApproval],
          toolResults: allToolResults,
          usage: totalUsage,
          stopReason: 'tool_use',
          iterations,
        };
      }

      // Partition into read-only (safe to parallelize) and mutating (sequential)
      const readOnly: LlmToolCall[] = [];
      const mutating: LlmToolCall[] = [];

      for (const tc of response.toolCalls) {
        const tool = this.registry.getTool(tc.name);
        if (tool?.mutating) {
          mutating.push(tc);
        } else {
          readOnly.push(tc);
        }
      }

      // Execute read-only tools in parallel
      if (readOnly.length > 0) {
        const results = await Promise.allSettled(
          readOnly.map((tc) =>
            this.registry
              .execute(tc.name, tc.arguments)
              .then((r) => ({ tc, result: r })),
          ),
        );

        for (const settled of results) {
          if (settled.status === 'fulfilled') {
            const { tc, result } = settled.value;
            allToolCalls.push(tc);
            allToolResults.push({
              id: tc.id,
              name: tc.name,
              success: result.success,
              result: result.success ? result.data : result.error,
            });
            messages.push({
              role: 'tool',
              content: JSON.stringify(
                result.success ? result.data : result.error,
              ),
              toolCallId: tc.id,
            });
          } else {
            // Promise itself rejected (shouldn't happen, but defensive)
            const tc = readOnly[results.indexOf(settled)];
            allToolCalls.push(tc);
            allToolResults.push({
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

      // Execute mutating tools sequentially (preserves order + enables idempotency)
      for (const tc of mutating) {
        allToolCalls.push(tc);

        const result = await this.registry.execute(tc.name, tc.arguments);
        allToolResults.push({
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
    }

    this.logger.warn(
      `Agent loop hit max iterations (${this.budget.maxIterations}) — forcing stop`,
    );

    return {
      message:
        'I reached the maximum number of actions for this request. Please try again with a simpler request.',
      toolCalls: allToolCalls,
      toolResults: allToolResults,
      usage: totalUsage,
      stopReason: 'max_iterations',
      iterations,
    };
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
      try {
        return await this.llm.complete({
          model: ENV.LLM_MODEL,
          system,
          messages,
          tools,
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(
          `LLM call failed (attempt ${attempt}/${this.maxRetries}, ${contextLabel}): ${lastError.message}`,
        );

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
