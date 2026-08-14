import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider } from './llm-provider.interface';
import type {
  ChatMessage,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
  LlmToolCall,
} from './llm.types';
import { toJsonSchemaTools } from './tool-schema';

const DEFAULT_MODEL = 'claude-3-5-haiku-latest';
const DEFAULT_MAX_TOKENS = 1024;

/**
 * Real Anthropic implementation behind the LlmProvider interface. All Anthropic
 * specifics live here: message/content block mapping and stop-reason mapping.
 * The agent loop and the tool layer never see the vendor SDK types.
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly client: Anthropic,
    private readonly defaultModel: string = DEFAULT_MODEL,
    private readonly defaultMaxTokens: number = DEFAULT_MAX_TOKENS,
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const message = await this.client.messages.create({
      model: request.model,
      system: request.system,
      max_tokens: request.maxTokens ?? this.defaultMaxTokens,
      messages: request.messages.map((m) => this.toAnthropicMessage(m)),
      tools: request.tools?.length
        ? toJsonSchemaTools(request.tools)
        : undefined,
    });

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const toolCalls: LlmToolCall[] = message.content
      .filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      )
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments: (block.input ?? {}) as Record<string, unknown>,
      }));

    return {
      content: text,
      toolCalls,
      stopReason: mapStopReason(message.stop_reason),
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
      model: message.model,
    };
  }

  private toAnthropicMessage(message: ChatMessage): Anthropic.MessageParam {
    switch (message.role) {
      case 'tool':
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId ?? '',
              content: message.content,
            },
          ],
        };

      case 'assistant': {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (message.content) {
          blocks.push({ type: 'text', text: message.content });
        }
        for (const call of message.toolCalls ?? []) {
          blocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.arguments,
          });
        }
        return { role: 'assistant', content: blocks };
      }

      case 'user':
        return { role: 'user', content: message.content };
    }
  }
}

function mapStopReason(stopReason: string | null): LlmStopReason {
  switch (stopReason) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    default:
      return 'error';
  }
}
