import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { AnthropicLlmProvider } from './anthropic-llm.provider';
import { toJsonSchemaTools } from './tool-schema';
describe('AnthropicLlmProvider', () => {
  const create = jest.fn();
  const client = { messages: { create } } as unknown as Anthropic;
  const provider = new AnthropicLlmProvider(client, 'claude-test');

  beforeEach(() => {
    create.mockReset();
  });

  it('maps a text response into the provider-agnostic shape', async () => {
    create.mockResolvedValue({
      content: [{ type: 'text', text: 'Hi there' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 7 },
      model: 'claude-test',
    });

    const out = await provider.complete({
      model: 'claude-test',
      system: 'you are helpful',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(out).toEqual({
      content: 'Hi there',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 7 },
      model: 'claude-test',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-test',
        system: 'you are helpful',
        max_tokens: 1024,
      }),
    );
  });

  it('extracts tool calls from the response', async () => {
    create.mockResolvedValue({
      content: [
        { type: 'text', text: 'Let me check.' },
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'get_ticket',
          input: { ticketId: 'abc' },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 3, output_tokens: 3 },
      model: 'claude-test',
    });

    const out = await provider.complete({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'status?' }],
    });

    expect(out.stopReason).toBe('tool_use');
    expect(out.toolCalls).toEqual([
      { id: 'tu_1', name: 'get_ticket', arguments: { ticketId: 'abc' } },
    ]);
  });

  it('sends tool results and assistant tool calls back in Anthropic format', async () => {
    create.mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-test',
    });

    await provider.complete({
      model: 'claude-test',
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tu_1', name: 'get_ticket', arguments: { ticketId: 'x' } },
          ],
        },
        { role: 'tool', content: '{"status":"OPEN"}', toolCallId: 'tu_1' },
      ],
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu_1',
                name: 'get_ticket',
                input: { ticketId: 'x' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                content: '{"status":"OPEN"}',
              },
            ],
          },
        ],
      }),
    );
  });

  it('maps unknown stop reasons to error', async () => {
    create.mockResolvedValue({
      content: [],
      stop_reason: 'refusal',
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'claude-test',
    });
    const out = await provider.complete({ model: 'claude-test', messages: [] });
    expect(out.stopReason).toBe('error');
  });

  it('passes the tool schemas converted from Zod', async () => {
    create.mockResolvedValue({
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'claude-test',
    });

    await provider.complete({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        {
          name: 'get_ticket',
          description: 'Fetches a ticket',
          inputSchema: z.object({ ticketId: z.string() }),
        },
      ],
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          {
            name: 'get_ticket',
            description: 'Fetches a ticket',
            input_schema: expect.objectContaining({
              type: 'object',
              properties: {
                ticketId: expect.objectContaining({ type: 'string' }),
              },
            }),
          },
        ],
      }),
    );
  });
});

describe('toJsonSchemaTools', () => {
  it('converts Zod schemas to plain JSON Schema objects', () => {
    const tools = toJsonSchemaTools([
      {
        name: 'get_ticket',
        description: 'Fetches a ticket',
        inputSchema: z.object({
          ticketId: z.string().uuid(),
          includeHistory: z.boolean().optional(),
        }),
      },
    ]);

    expect(tools).toHaveLength(1);
    expect(tools[0].input_schema.type).toBe('object');
    expect(tools[0].input_schema.properties.ticketId).toEqual(
      expect.objectContaining({ type: 'string', format: 'uuid' }),
    );
    expect(tools[0].input_schema.properties.includeHistory).toEqual({
      type: 'boolean',
    });
    expect(tools[0].input_schema.required).toEqual(['ticketId']);
  });
});
