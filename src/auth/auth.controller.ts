import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ENV } from '../common/constants';
import { TenantScopedPrismaService } from '../tenancy/tenant-scoped-prisma.service';
import { AuthService } from './auth.service';
import type { AuthenticatedRequest } from './auth.types';
import { LoginDto } from './dto/login.dto';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';

/**
 * Public sign-in + refresh/logout + authenticated profile bootstrap.
 * Sessions are kept in HttpOnly cookies so the login persists across tabs and
 * reloads; the access cookie is short-lived and the refresh cookie is rotated
 * via POST /auth/refresh.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly scopedPrisma: TenantScopedPrismaService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken } = await this.authService.login(dto);

    this.setCookies(res, accessToken, refreshToken);

    return { accessToken };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = this.getRefreshToken(req);
    const { accessToken } = await this.authService.refresh(refreshToken);

    res.cookie(ACCESS_COOKIE, accessToken, this.accessCookieOptions());
    return { accessToken };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(this.getRefreshToken(req));
    this.clearCookies(res);
    return { success: true };
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

  private getRefreshToken(req: Request): string {
    const cookies = req.cookies as Record<string, string> | undefined;
    const fromCookie = cookies?.[REFRESH_COOKIE];
    return typeof fromCookie === 'string' ? fromCookie : '';
  }

  private setCookies(res: Response, accessToken: string, refreshToken: string) {
    res.cookie(ACCESS_COOKIE, accessToken, this.accessCookieOptions());
    res.cookie(REFRESH_COOKIE, refreshToken, this.refreshCookieOptions());
  }

  private accessCookieOptions() {
    return {
      httpOnly: true,
      secure: ENV.COOKIE_SECURE,
      sameSite: ENV.COOKIE_SAME_SITE,
      path: '/',
      maxAge: ENV.COOKIE_ACCESS_TTL_MS,
    };
  }

  private refreshCookieOptions() {
    return {
      httpOnly: true,
      secure: ENV.COOKIE_SECURE,
      sameSite: ENV.COOKIE_SAME_SITE,
      path: '/',
      maxAge: ENV.COOKIE_REFRESH_TTL_MS,
    };
  }

  private clearCookies(res: Response) {
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
  }
}
