import { IsArray, IsOptional, IsString } from 'class-validator';
import type { ChatMessage } from '../../llm/llm.types';

export class ChatDto {
  @IsString()
  message!: string;

  /** Optional: reuse a server-persisted conversation. Omit to start a new one. */
  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsOptional()
  @IsArray()
  conversationHistory?: ChatMessage[];

  @IsOptional()
  @IsString()
  systemPrompt?: string;
}
