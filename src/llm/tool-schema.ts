import { z } from 'zod';
import type { ToolDefinition } from './llm.types';

export interface JsonSchemaTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown> | null;
    required?: Array<string> | null;
    [k: string]: unknown;
  };
}

/**
 * Converts a ToolDefinition (Zod inputSchema) into the JSON Schema shape that
 * Anthropic's function-calling expects. The Zod schema stays the single source
 * of truth: the same schema validates the tool input AND generates the
 * model-facing schema (via zod 4's native `z.toJSONSchema`).
 */
export function toJsonSchemaTools(tools: ToolDefinition[]): JsonSchemaTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: z.toJSONSchema(
      tool.inputSchema,
    ) as JsonSchemaTool['input_schema'],
  }));
}
