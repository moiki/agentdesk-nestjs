import { Controller, Get } from '@nestjs/common';
import { TenantService } from './tenant.service';

/**
 * Authenticated, tenant-scoped profile endpoints. The tenant is derived from
 * the verified JWT by AuthContextMiddleware — never from the body or headers.
 */
@Controller('tenant')
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  @Get('profile')
  profile() {
    return this.tenantService.profile();
  }
}
