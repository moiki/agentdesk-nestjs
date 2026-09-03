import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import type { ChatMessage } from '../../llm/llm.types';

export class ChatDto {
  @IsString()
  message!: string;

  /** Optional: reuse a server-persisted conversation. Omit to start a new one. */
  @IsOptional()
  @IsString()
  conversationId?: string;

  /**
   * Optional: client-supplied idempotency key. When creating a new conversation
   * (no `conversationId`), a retried request with the same key resolves to the
   * already-created conversation instead of spawning a duplicate thread.
   */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;

  @IsOptional()
  @IsArray()
  conversationHistory?: ChatMessage[];

  @IsOptional()
  @IsString()
  systemPrompt?: string;
}
