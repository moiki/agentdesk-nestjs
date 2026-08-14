import { Body, Controller, Post } from '@nestjs/common';
import { SignupDto } from './dto/signup.dto';
import { SignupService } from './signup.service';

/**
 * Public self-service onboarding. No auth — this is the entry point for a new
 * tenant. Every other endpoint requires a JWT.
 */
@Controller('signup')
export class SignupController {
  constructor(private readonly signupService: SignupService) {}

  @Post()
  create(@Body() dto: SignupDto) {
    return this.signupService.signup(dto);
  }
}
