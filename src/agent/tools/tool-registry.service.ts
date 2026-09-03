import { Injectable, Logger } from '@nestjs/common';
import type { ToolDefinition } from '../../llm/llm.types';
import type { Tool, ToolResult } from './tool.interface';

const MAX_RESULT_CHARS = 4_000;

/** Upper bound on the in-memory tool-call dedup cache. */
const MAX_DEDUP_ENTRIES = 1_000;

function truncateResult(data: string): string {
  if (data.length <= MAX_RESULT_CHARS) return data;
  return `${data.slice(0, MAX_RESULT_CHARS)}\n\n[Result truncated — ${data.length} chars total. Refine your search to get fewer results.]`;
}

/**
 * Central registry for agent tools. Tools register themselves at module init
 * time; the agent loop pulls definitions for the LLM and dispatches calls here.
 */
@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, Tool>();

  /**
   * Dedup cache keyed by toolCallId. A toolCallId is generated per logical tool
   * call and never reused, so re-running the same id returns the cached result
   * instead of repeating side-effects (e.g. a retried agent loop creating a
   * second ticket). Bounded FIFO eviction keeps memory flat.
   */
  private readonly recentExecutions = new Map<string, ToolResult>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn(`Tool "${tool.name}" already registered — overwriting`);
    }
    this.tools.set(tool.name, tool);
    this.logger.debug(`Registered tool: ${tool.name}`);
  }

  /**
   * Start of a new agent turn: expire the dedup cache so tool call ids from a
   * previous turn never replay stale results. The cache only dedups re-emitted
   * tool calls *within* the current turn.
   */
  startTurn(): void {
    this.recentExecutions.clear();
  }

  getDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    toolCallId?: string,
  ): Promise<ToolResult> {
    if (toolCallId && this.recentExecutions.has(toolCallId)) {
      this.logger.debug(`Tool ${name} (${toolCallId}) replayed from cache`);
      return this.recentExecutions.get(toolCallId)!;
    }

    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        error: { code: 'VALIDATION_ERROR', message: `Unknown tool: ${name}` },
      };
    }

    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `Invalid input for ${name}: ${parsed.error.message}`,
        },
      };
    }

    let result: ToolResult;
    try {
      const raw = await tool.execute(
        parsed.data as Record<string, unknown>,
        toolCallId,
      );
      // Truncate large string results to prevent token blowup
      if (raw.success && typeof raw.data === 'string') {
        result = { success: true, data: truncateResult(raw.data) };
      } else if (raw.success && typeof raw.data === 'object') {
        const json = JSON.stringify(raw.data);
        const truncated = truncateResult(json);
        result = truncated !== json ? { success: true, data: truncated } : raw;
      } else {
        result = raw;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Tool ${name} failed: ${message}`);
      result = {
        success: false,
        error: { code: 'INTERNAL_ERROR', message },
      };
    }

    if (toolCallId) {
      this.recentExecutions.set(toolCallId, result);
      if (this.recentExecutions.size > MAX_DEDUP_ENTRIES) {
        const oldest = this.recentExecutions.keys().next().value as
          string | undefined;
        if (oldest !== undefined) this.recentExecutions.delete(oldest);
      }
    }
    return result;
  }
}
