import { Body, Controller, Post } from '@nestjs/common';
import { AgentService } from './agent.service';
import { ApproveChatDto } from './dto/approve-chat.dto';
import { ChatDto } from './dto/chat.dto';

@Controller('chat')
export class ChatController {
  constructor(private readonly agent: AgentService) {}

  @Post()
  async chat(@Body() dto: ChatDto) {
    return this.agent.chat(
      dto.message,
      dto.conversationHistory,
      dto.systemPrompt,
    );
  }

  /**
   * Human-in-the-loop resume. JWT required (not in PUBLIC_PATHS). The client
   * replays the paused conversation state plus one decision per pending call.
   */
  @Post('approve')
  async approve(@Body() dto: ApproveChatDto) {
    return this.agent.approve(dto.conversationHistory, dto.decisions);
  }
}
