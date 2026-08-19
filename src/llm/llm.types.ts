import { z } from 'zod';

/**
 * Shared types for the LLM layer. Providers (Anthropic, fake, ...) speak this
 * provider-agnostic shape; the agent loop and the tool layer never see the
 * vendor SDK types.
 */

export interface ChatMessage {
  /** Message role. System instructions travel in LlmRequest.system. */
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant messages that produced tool calls (conversation history). */
  toolCalls?: LlmToolCall[];
  /** Tool result messages: which tool call this answers. */
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** Single source of truth for input validation AND the function-calling schema. */
  inputSchema: z.ZodTypeAny;
}

export type LlmStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'error'
  | 'max_iterations';

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
}

export interface LlmResponse {
  content: string;
  toolCalls: LlmToolCall[];
  stopReason: LlmStopReason;
  usage: LlmUsage;
  /** Model that actually produced the response (echoed by the provider). */
  model: string;
}
