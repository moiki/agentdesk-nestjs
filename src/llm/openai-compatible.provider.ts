import type OpenAI from 'openai';
import type { LlmProvider } from './llm-provider.interface';
import type {
  ChatMessage,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
  LlmToolCall,
} from './llm.types';
import { toJsonSchemaTools } from './tool-schema';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_MAX_TOKENS = 1024;

/**
 * Provider for every OpenAI-compatible chat-completions API (OpenAI, Groq,
 * Together, ...). All wire-format specifics live here: message/tool mapping
 * and finish_reason translation. The agent loop only ever sees the
 * provider-agnostic LlmRequest/LlmResponse shapes.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;

  constructor(
    private readonly client: OpenAI,
    private readonly defaultModel: string = DEFAULT_MODEL,
    private readonly defaultMaxTokens: number = DEFAULT_MAX_TOKENS,
    name: string = 'openai-compatible',
  ) {
    this.name = name;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const completion = await this.client.chat.completions.create({
      // The factory-configured model is authoritative (e.g. GROQ_MODEL);
      // request.model only fills in when no default was provided.
      model: this.defaultModel || request.model,
      max_tokens: request.maxTokens ?? this.defaultMaxTokens,
      messages: this.toOpenAiMessages(request),
      tools: request.tools?.length
        ? request.tools.map((tool) => ({
            type: 'function' as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: toJsonSchemaTools([tool])[0].input_schema,
            },
          }))
        : undefined,
    });

    const choice = completion.choices[0];
    const message = choice.message;

    const toolCalls: LlmToolCall[] = (message.tool_calls ?? [])
      .filter(
        (call): call is OpenAI.Chat.ChatCompletionMessageFunctionToolCall =>
          call.type === 'function',
      )
      .map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: parseArguments(call.function.arguments),
      }));

    return {
      content: message.content ?? '',
      toolCalls,
      stopReason: mapFinishReason(choice.finish_reason),
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      },
      model: completion.model,
    };
  }

  private toOpenAiMessages(
    request: LlmRequest,
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (request.system) {
      messages.push({ role: 'system', content: request.system });
    }
    for (const message of request.messages) {
      messages.push(this.toOpenAiMessage(message));
    }
    return messages;
  }

  private toOpenAiMessage(
    message: ChatMessage,
  ): OpenAI.Chat.ChatCompletionMessageParam {
    switch (message.role) {
      case 'user':
        return { role: 'user', content: message.content };

      case 'assistant':
        return {
          role: 'assistant',
          content: message.content || null,
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                })),
              }
            : {}),
        };

      case 'tool':
        return {
          role: 'tool',
          content: message.content,
          tool_call_id: message.toolCallId ?? '',
        };
    }
  }
}

/**
 * Providers may deliver arguments as a JSON string (spec) or an object
 * (lenient SDKs/mocks). A malformed string degrades to `{}` so the loop can
 * continue and the tool layer reports VALIDATION_ERROR instead of crashing.
 */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') {
    return (raw ?? {}) as Record<string, unknown>;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return {};
  }
}

function mapFinishReason(finishReason: string | null): LlmStopReason {
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      // function_call (legacy), content_filter, null... keep the text flowing.
      return 'stop_sequence';
  }
}
