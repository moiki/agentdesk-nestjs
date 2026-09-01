import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { getTenantId } from '../tenancy/tenant-context';
import { TenantScopedPrismaService } from '../tenancy/tenant-scoped-prisma.service';
import type { ChatMessage } from '../llm/llm.types';
import { ConversationStatus } from '../generated/prisma/client';
import type { Prisma } from '../generated/prisma/client';
import type { ScopedPrismaClient } from '../tenancy/tenant-scoped.prisma';

/**
 * Server-side persistence for agent conversations.
 *
 * The chat was previously fully stateless: the client replayed the history on
 * every call, which let a crashed session leave orphaned toolCalls behind and
 * produced unrecoverable 400s. This service moves the source of truth to the
 * harness, storing a consistent message history per conversation so a sudden
 * client disconnect no longer corrupts context.
 *
 * Every operation goes through the tenant-scoped Prisma client, so rows are
 * always filtered/stamped with the active tenant.
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(private readonly scopedPrisma: TenantScopedPrismaService) {}

  private get db(): ScopedPrismaClient {
    return this.scopedPrisma.prisma;
  }

  /**
   * Finds a conversation owned by the active tenant. Throws 404 if it does not
   * exist or belongs to another tenant (the scoping extension fails closed, so
   * cross-tenant reads can never match).
   */
  async find(id: string) {
    const conversation = await this.db.conversation.findFirst({
      where: { id },
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    return conversation;
  }

  /** Creates a new conversation with an initial message history (or empty). */
  async create(
    messages: ChatMessage[],
    opts: { userId?: string } = {},
  ): Promise<ConversationIdAndMessages> {
    const tenantId = getTenantId()!;
    const conversation = await this.db.conversation.create({
      data: {
        tenantId,
        userId: opts.userId ?? null,
        messages: toJsonValue(messages),
        status: ConversationStatus.ACTIVE,
      },
    });
    return {
      id: conversation.id,
      messages: conversation.messages as unknown as ChatMessage[],
    };
  }

  /** Replaces the stored message history atomically and returns it. */
  async updateMessages(
    id: string,
    messages: ChatMessage[],
    status?: ConversationStatus,
  ): Promise<ChatMessage[]> {
    const saved = await this.db.conversation.update({
      where: { id },
      data: {
        messages: toJsonValue(messages),
        ...(status ? { status } : {}),
      },
    });
    return saved.messages as unknown as ChatMessage[];
  }

  /** Marks a conversation as paused (awaiting approval) or completed. */
  async setStatus(id: string, status: ConversationStatus): Promise<void> {
    await this.db.conversation.update({
      where: { id },
      data: { status },
    });
  }

  /** Parses messages from the persisted conversation, with a safety fallback. */
  toMessages(value: unknown): ChatMessage[] {
    if (Array.isArray(value)) {
      return value as ChatMessage[];
    }
    this.logger.warn('Stored conversation.messages is not an array; resetting.');
    return [];
  }
}

// Prisma adapts arbitrary JSON (the messages array) to its InputJsonValue;
// the generated type is opaque, so bridge it with a minimal cast.
function toJsonValue(messages: ChatMessage[]): Prisma.InputJsonValue {
  return messages as unknown as Prisma.InputJsonValue;
}

export interface ConversationIdAndMessages {
  id: string;
  messages: ChatMessage[];
}
