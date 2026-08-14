import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { TenantScopedPrismaService } from '../tenancy/tenant-scoped-prisma.service';
import { AuthService } from './auth.service';
import type { AuthenticatedRequest } from './auth.types';
import { LoginDto } from './dto/login.dto';

/**
 * Public sign-in + authenticated profile bootstrap.
 * The active user/tenant comes from the verified JWT (AuthContextMiddleware).
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly scopedPrisma: TenantScopedPrismaService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get('me')
  async me(@Req() req: AuthenticatedRequest) {
    const user = req.user!;
    const tenant = await this.scopedPrisma.prisma.tenant.findUnique({
      where: { id: user.tenantId },
    });

    return {
      userId: user.userId,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role,
      tenantName: tenant?.name ?? null,
      plan: tenant?.plan ?? null,
    };
  }
}
