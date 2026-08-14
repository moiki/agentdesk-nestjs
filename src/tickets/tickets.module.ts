import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [TenancyModule],
  controllers: [TicketsController],
  providers: [TicketsService],
})
export class TicketsModule {}
