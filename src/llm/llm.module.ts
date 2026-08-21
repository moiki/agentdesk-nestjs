import { Module } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ENV } from '../common/constants';
import { AnthropicLlmProvider } from './anthropic-llm.provider';
import { FakeLlmProvider } from './fake-llm.provider';
import { OpenAICompatibleProvider } from './openai-compatible.provider';
import type { LlmProvider } from './llm-provider.interface';

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/**
 * Resolves the active LLM provider from ENV:
 *  - `LLM_PROVIDER=fake` (default): cassette-based fake, no network, for dev/tests.
 *  - `LLM_PROVIDER=anthropic`: real Anthropic client (requires ANTHROPIC_API_KEY).
 *  - `LLM_PROVIDER=groq`: any OpenAI-compatible endpoint via Groq (requires GROQ_API_KEY).
 */
export function createLlmProvider(): LlmProvider {
  if (ENV.LLM_PROVIDER === 'anthropic') {
    if (!ENV.ANTHROPIC_API_KEY) {
      throw new Error(
        'ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic',
      );
    }
    return new AnthropicLlmProvider(
      new Anthropic({ apiKey: ENV.ANTHROPIC_API_KEY }),
      ENV.LLM_MODEL,
    );
  }

  if (ENV.LLM_PROVIDER === 'groq') {
    if (!ENV.GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY is required when LLM_PROVIDER=groq');
    }
    return new OpenAICompatibleProvider(
      new OpenAI({ apiKey: ENV.GROQ_API_KEY, baseURL: ENV.GROQ_BASE_URL }),
      ENV.GROQ_MODEL,
      1024,
      'groq',
    );
  }

  return new FakeLlmProvider();
}

@Module({
  providers: [
    {
      provide: LLM_PROVIDER,
      useFactory: () => createLlmProvider(),
    },
  ],
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
