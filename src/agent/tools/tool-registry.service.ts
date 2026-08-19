import { Injectable, Logger } from '@nestjs/common';
import type { ToolDefinition } from '../../llm/llm.types';
import type { Tool, ToolResult } from './tool.interface';

const MAX_RESULT_CHARS = 4_000;

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

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn(`Tool "${tool.name}" already registered — overwriting`);
    }
    this.tools.set(tool.name, tool);
    this.logger.debug(`Registered tool: ${tool.name}`);
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
  ): Promise<ToolResult> {
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

    try {
      const result = await tool.execute(parsed.data as Record<string, unknown>);
      // Truncate large string results to prevent token blowup
      if (result.success && typeof result.data === 'string') {
        return { success: true, data: truncateResult(result.data) };
      }
      if (result.success && typeof result.data === 'object') {
        const json = JSON.stringify(result.data);
        const truncated = truncateResult(json);
        if (truncated !== json) {
          return { success: true, data: truncated };
        }
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Tool ${name} failed: ${message}`);
      return {
        success: false,
        error: { code: 'INTERNAL_ERROR', message },
      };
    }
  }
}
