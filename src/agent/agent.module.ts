import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LlmModule } from '../llm/llm.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TicketsModule } from '../tickets/tickets.module';
import { PromptsModule } from './prompts/prompts.module';
import { AgentService } from './agent.service';
import { ChatController } from './chat.controller';
import { ToolRegistry } from './tools/tool-registry.service';
import { TicketTools } from './tools/ticket-tools';
import { ConversationService } from './conversation.service';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    LlmModule,
    TicketsModule,
    TenancyModule,
    PromptsModule,
  ],
  controllers: [ChatController],
  providers: [ToolRegistry, TicketTools, AgentService, ConversationService],
})
export class AgentModule {}
