import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { TicketStatus } from '../../generated/prisma/client';

export class UpdateTicketDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;
}
