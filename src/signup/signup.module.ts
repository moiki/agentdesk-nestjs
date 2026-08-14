import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { SignupController } from './signup.controller';
import { SignupService } from './signup.service';

@Module({
  imports: [TenancyModule],
  controllers: [SignupController],
  providers: [SignupService],
})
export class SignupModule {}
