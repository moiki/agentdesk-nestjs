import type OpenAI from 'openai';
import { OpenAICompatibleProvider } from './openai-compatible.provider';
import { z } from 'zod';
import type { LlmRequest, ToolDefinition } from './llm.types';

function fakeClient(response: Record<string, unknown>): {
  client: OpenAI;
  createMock: jest.Mock;
} {
  const createMock = jest.fn().mockResolvedValue(response);
  return {
    client: {
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI,
    createMock,
  };
}

const deleteTicketTool: ToolDefinition = {
  name: 'delete_ticket',
  description: 'Delete a ticket by id',
  inputSchema: z.object({ ticketId: z.string().uuid() }),
};

/** assistant(toolCalls) + tool result + user — the approval-resume shape. */
function resumeRequest(): LlmRequest {
  return {
    model: 'openai/gpt-oss-120b',
    system: 'You are AgentDesk.',
    messages: [
      { role: 'user', content: 'delete ticket abc' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call-1',
            name: 'delete_ticket',
            arguments: { ticketId: 't1' },
          },
        ],
      },
      { role: 'tool', content: '{"deleted":true}', toolCallId: 'call-1' },
    ],
    tools: [deleteTicketTool],
    maxTokens: 512,
  };
}

describe('OpenAICompatibleProvider', () => {
  describe('outgoing mapping (request → chat.completions)', () => {
    it('maps system, tool-result pairing and function tools to the OpenAI payload', async () => {
      const { client, createMock } = fakeClient({
        choices: [
          {
            message: { role: 'assistant', content: 'done' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
        model: 'openai/gpt-oss-120b',
      });
      const provider = new OpenAICompatibleProvider(client, 'groq-model');

      await provider.complete(resumeRequest());

      const payload = createMock.mock.calls[0][0];
      // system message travels first
      expect(payload.messages[0]).toEqual({
        role: 'system',
        content: 'You are AgentDesk.',
      });
      // user message passes through
      expect(payload.messages[1]).toEqual({
        role: 'user',
        content: 'delete ticket abc',
      });
      // assistant toolCalls become OpenAI tool_calls with JSON-string args
      expect(payload.messages[2].role).toBe('assistant');
      expect(payload.messages[2].tool_calls).toEqual([
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'delete_ticket',
            arguments: JSON.stringify({ ticketId: 't1' }),
          },
        },
      ]);
      // tool result is paired through tool_call_id
      expect(payload.messages[3]).toEqual({
        role: 'tool',
        content: '{"deleted":true}',
        tool_call_id: 'call-1',
      });
      // registered tools become function definitions with JSON Schema parameters
      expect(payload.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'delete_ticket',
            description: 'Delete a ticket by id',
            parameters: expect.objectContaining({
              type: 'object',
              properties: expect.anything(),
            }),
          },
        },
      ]);
      expect(payload.max_tokens).toBe(512);
      expect(payload.model).toBe('groq-model');
    });

    it('omits tools when the request carries none', async () => {
      const { client, createMock } = fakeClient({
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: {},
        model: 'm',
      });
      const provider = new OpenAICompatibleProvider(client);
      const req = resumeRequest();
      req.tools = undefined;

      await provider.complete(req);

      expect(createMock.mock.calls[0][0].tools).toBeUndefined();
    });
  });

  describe('incoming mapping (chat.completions → LlmResponse)', () => {
    it('normalizes tool_calls responses (finish_reason=tool_calls)', async () => {
      const { client } = fakeClient({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'tc-9',
                  type: 'function',
                  function: {
                    name: 'delete_ticket',
                    arguments: '{"ticketId":"abc-uuid"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 4 },
        model: 'openai/gpt-oss-120b',
      });
      const provider = new OpenAICompatibleProvider(client);

      const res = await provider.complete(resumeRequest());

      expect(res.stopReason).toBe('tool_use');
      expect(res.content).toBe('');
      expect(res.toolCalls).toEqual([
        {
          id: 'tc-9',
          name: 'delete_ticket',
          arguments: { ticketId: 'abc-uuid' }, // parsed to an object
        },
      ]);
      expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 4 });
      expect(res.model).toBe('openai/gpt-oss-120b');
    });

    it.each([
      ['stop', 'end_turn'],
      ['length', 'max_tokens'],
      ['content_filter', 'stop_sequence'],
    ])(
      'maps finish_reason=%s → %s keeping content',
      async (finish, expected) => {
        const { client } = fakeClient({
          choices: [
            {
              message: { role: 'assistant', content: 'partial answer' },
              finish_reason: finish,
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          model: 'm',
        });
        const provider = new OpenAICompatibleProvider(client);

        const res = await provider.complete(resumeRequest());

        expect(res.stopReason).toBe(expected);
        expect(res.content).toBe('partial answer');
      },
    );

    it('degrades unparseable tool-call arguments to an empty object without throwing', async () => {
      const { client } = fakeClient({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'tc-bad',
                  type: 'function',
                  function: { name: 'delete_ticket', arguments: '{oops' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {},
        model: 'm',
      });
      const provider = new OpenAICompatibleProvider(client);

      const res = await provider.complete(resumeRequest());

      expect(res.stopReason).toBe('tool_use');
      expect(res.toolCalls[0].arguments).toEqual({});
    });

    it('accepts object-shaped arguments verbatim', async () => {
      const { client } = fakeClient({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'tc-obj',
                  type: 'function',
                  function: {
                    name: 'delete_ticket',
                    arguments: { ticketId: 'x' } as unknown as string,
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {},
        model: 'm',
      });
      const provider = new OpenAICompatibleProvider(client);

      const res = await provider.complete(resumeRequest());

      expect(res.toolCalls[0].arguments).toEqual({ ticketId: 'x' });
    });
  });
});
