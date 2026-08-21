import { ENV } from '../common/constants';
import { FakeLlmProvider } from './fake-llm.provider';
import { createLlmProvider } from './llm.module';
import { OpenAICompatibleProvider } from './openai-compatible.provider';

describe('createLlmProvider (factory)', () => {
  let replaced: Array<{ restore: () => void }>;

  beforeEach(() => {
    replaced = [];
  });

  afterEach(() => {
    for (const entry of replaced) entry.restore();
  });

  function selectEnv(key: string, value: string): void {
    replaced.push(jest.replaceProperty(ENV, key, value));
  }

  it('fails fast naming GROQ_API_KEY when groq is selected without a key', () => {
    selectEnv('LLM_PROVIDER', 'groq');
    selectEnv('GROQ_API_KEY', '');

    expect(() => createLlmProvider()).toThrow(/GROQ_API_KEY/);
  });

  it('builds an OpenAICompatibleProvider named "groq" when configured', () => {
    selectEnv('LLM_PROVIDER', 'groq');
    selectEnv('GROQ_API_KEY', 'gsk_test');

    const provider = createLlmProvider();

    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.name).toBe('groq');
  });

  it('falls back to the cassette fake by default and keeps anthropic untouched', () => {
    selectEnv('LLM_PROVIDER', 'fake');
    expect(createLlmProvider()).toBeInstanceOf(FakeLlmProvider);

    selectEnv('LLM_PROVIDER', 'anthropic');
    selectEnv('ANTHROPIC_API_KEY', 'sk-test');
    expect(createLlmProvider().name).toBe('anthropic');
  });
});
