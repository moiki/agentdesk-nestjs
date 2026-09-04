import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TenantController } from './tenant.controller';
import { TenantService } from './tenant.service';

@Module({
  imports: [TenancyModule],
  controllers: [TenantController],
  providers: [TenantService],
})
export class TenantModule {}
