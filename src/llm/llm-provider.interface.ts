import type { LlmRequest, LlmResponse } from './llm.types';

/**
 * Provider-agnostic LLM gateway interface. Every concrete provider (Anthropic,
 * the cassette-based fake, future OpenAI-compatible ones) implements this, so
 * the agent loop can run against real models or recorded responses without
 * changing any caller code.
 */
export interface LlmProvider {
  readonly name: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}
