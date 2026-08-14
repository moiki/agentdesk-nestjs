import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { TicketStatus } from '../generated/prisma/client';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { TicketsService } from './tickets.service';

/**
 * Tenant-facing ticket API. The active tenant is resolved by the
 * AuthContextMiddleware from the verified JWT — never from the body.
 */
@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @Post()
  create(@Body() dto: CreateTicketDto) {
    return this.ticketsService.create(dto);
  }

  @Get()
  findAll(@Query('status') status?: TicketStatus) {
    return this.ticketsService.findAll(status);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.ticketsService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTicketDto) {
    return this.ticketsService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.ticketsService.remove(id);
  }
}
