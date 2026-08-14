import { Module } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { ENV } from '../common/constants';
import { AnthropicLlmProvider } from './anthropic-llm.provider';
import { FakeLlmProvider } from './fake-llm.provider';

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/**
 * Resolves the active LLM provider from ENV:
 *  - `LLM_PROVIDER=fake` (default): cassette-based fake, no network, for dev/tests.
 *  - `LLM_PROVIDER=anthropic`: real Anthropic client (requires ANTHROPIC_API_KEY).
 */
@Module({
  providers: [
    {
      provide: LLM_PROVIDER,
      useFactory: () => {
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

        return new FakeLlmProvider();
      },
    },
  ],
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
