import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { FakeLlmProvider } from '../src/llm/fake-llm.provider';
import { LLM_PROVIDER } from '../src/llm/llm.module';
import type { LlmResponse } from '../src/llm/llm.types';

describe('LlmProvider (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('resolves the FakeLlmProvider in test environment', () => {
    const provider = app.get(LLM_PROVIDER);
    expect(provider).toBeInstanceOf(FakeLlmProvider);
  });

  it('serves a cassette recorded response through the DI provider', async () => {
    const provider = app.get<FakeLlmProvider>(LLM_PROVIDER);
    const recorded: LlmResponse = {
      content: 'cassette answer',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'fake',
    };
    provider.add({ match: {}, response: recorded });

    await expect(
      provider.complete({
        model: 'fake',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).resolves.toEqual(recorded);
    expect(provider.requests).toHaveLength(1);
  });
});
