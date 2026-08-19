import { Body, Controller, Post } from '@nestjs/common';
import { AgentService } from './agent.service';
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
}
