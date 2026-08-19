import { IsArray, IsOptional, IsString } from 'class-validator';
import type { ChatMessage } from '../../llm/llm.types';

export class ChatDto {
  @IsString()
  message!: string;

  @IsOptional()
  @IsArray()
  conversationHistory?: ChatMessage[];

  @IsOptional()
  @IsString()
  systemPrompt?: string;
}
