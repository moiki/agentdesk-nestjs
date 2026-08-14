import { FakeLlmProvider, matchesCassette } from './fake-llm.provider';
import type { LlmRequest, LlmResponse } from './llm.types';

const response: LlmResponse = {
  content: 'ok',
  toolCalls: [],
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5 },
  model: 'fake-model',
};

function request(overrides: Partial<LlmRequest>): LlmRequest {
  return {
    model: 'model-a',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

describe('matchesCassette', () => {
  it('matches a request with no constraints', () => {
    expect(matchesCassette({}, request({}))).toBe(true);
  });

  it('matches on model', () => {
    expect(matchesCassette({ model: 'model-a' }, request({}))).toBe(true);
    expect(matchesCassette({ model: 'model-b' }, request({}))).toBe(false);
  });

  it('matches on last tool call name', () => {
    const req = request({
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'get_ticket', arguments: {} }],
        },
        { role: 'user', content: 'done' },
      ],
    });
    expect(matchesCassette({ toolName: 'get_ticket' }, req)).toBe(true);
    expect(matchesCassette({ toolName: 'other_tool' }, req)).toBe(false);
  });

  it('matches on hasToolCalls', () => {
    const withCalls = request({
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'get_ticket', arguments: {} }],
        },
      ],
    });
    expect(matchesCassette({ hasToolCalls: true }, withCalls)).toBe(true);
    expect(matchesCassette({ hasToolCalls: false }, withCalls)).toBe(false);
    expect(matchesCassette({ hasToolCalls: true }, request({}))).toBe(false);
  });

  it('matches on text inside the last user message', () => {
    expect(
      matchesCassette(
        { includesText: 'refund' },
        request({ messages: [{ role: 'user', content: 'I want a refund' }] }),
      ),
    ).toBe(true);
    expect(
      matchesCassette(
        { includesText: 'order' },
        request({ messages: [{ role: 'user', content: 'I want a refund' }] }),
      ),
    ).toBe(false);
  });

  it('requires all set fields to match', () => {
    const req = request({
      model: 'model-a',
      messages: [{ role: 'user', content: 'refund please' }],
    });
    expect(
      matchesCassette({ model: 'model-a', includesText: 'refund' }, req),
    ).toBe(true);
    expect(
      matchesCassette({ model: 'model-b', includesText: 'refund' }, req),
    ).toBe(false);
  });
});

describe('FakeLlmProvider', () => {
  it('returns the recorded response for a matching cassette', async () => {
    const provider = new FakeLlmProvider({
      cassettes: [{ match: { includesText: 'refund' }, response }],
    });
    const out = await provider.complete(
      request({ messages: [{ role: 'user', content: 'I need a refund' }] }),
    );
    expect(out).toEqual(response);
  });

  it('records every request for assertions', async () => {
    const provider = new FakeLlmProvider({
      cassettes: [{ match: {}, response }],
    });
    await provider.complete(request({}));
    await provider.complete(request({ model: 'other' }));
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].model).toBe('other');
  });

  it('supports the fluent add() API', async () => {
    const provider = new FakeLlmProvider();
    provider.add({ match: { toolName: 'get_ticket' }, response });
    const req = request({
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'get_ticket', arguments: {} }],
        },
        { role: 'user', content: 'here' },
      ],
    });
    await expect(provider.complete(req)).resolves.toEqual(response);
  });

  it('throws in strict mode when no cassette matches', async () => {
    const provider = new FakeLlmProvider();
    await expect(provider.complete(request({}))).rejects.toThrow(
      /no cassette matches/,
    );
  });

  it('falls back to defaultResponse when not strict', async () => {
    const provider = new FakeLlmProvider({
      strict: false,
      defaultResponse: response,
    });
    await expect(provider.complete(request({}))).resolves.toEqual(response);
  });
});
