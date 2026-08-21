import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Mirror of the tool calls embedded in assistant history messages. */
export class ToolCallDto {
  @IsString()
  id!: string;

  @IsString()
  name!: string;

  @IsObject()
  arguments!: Record<string, unknown>;
}

/**
 * Mirror of the provider-agnostic chat message the client persists and
 * replays. Shape must stay compatible with LlmMessage (llm.types.ts).
 */
export class ChatMessageDto {
  @IsIn(['user', 'assistant', 'tool'])
  role!: 'user' | 'assistant' | 'tool';

  @IsString()
  @MaxLength(100_000)
  content!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ToolCallDto)
  toolCalls?: ToolCallDto[];

  @IsOptional()
  @IsString()
  toolCallId?: string;
}

export class ApproveDecisionDto {
  @IsString()
  toolCallId!: string;

  @IsBoolean()
  approved!: boolean;
}

export class ApproveChatDto {
  /** Full conversation state as returned by the paused /chat response. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  conversationHistory!: ChatMessageDto[];

  /** Exactly one decision per pending (awaitingApproval) tool call. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ApproveDecisionDto)
  decisions!: ApproveDecisionDto[];
}
