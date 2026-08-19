import { z } from 'zod';

/**
 * Error code for tool failures. The agent loop uses this to distinguish
 * recoverable errors (the model can try a different approach) from
 * non-recoverable ones (retrying won't help).
 */
export type ToolErrorCode = 'NOT_FOUND' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR';

export interface ToolError {
  code: ToolErrorCode;
  message: string;
}

/**
 * A tool the agent can invoke. `inputSchema` is a Zod v4 schema — it validates
 * the LLM-provided arguments at runtime AND generates the JSON Schema the model
 * sees (via z.toJSONSchema). No duplication.
 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  /** Whether this tool mutates state. Used for idempotency and parallelism. */
  mutating?: boolean;
  /** If true, the agent loop pauses and requests human approval before executing. */
  requiresApproval?: boolean;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

export type ToolResult =
  { success: true; data: unknown } | { success: false; error: ToolError };
