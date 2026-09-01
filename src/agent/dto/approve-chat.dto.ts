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
  /** Server-persisted conversation id returned by the paused /chat response. */
  @IsString()
  conversationId!: string;

  /** One decision per pending (awaitingApproval) tool call. Any pending call
   *  not covered here is treated as REJECTED_BY_USER (never executed). */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ApproveDecisionDto)
  decisions!: ApproveDecisionDto[];
}
