import { IsString, MinLength } from 'class-validator';

/**
 * Create payload. Deliberately has NO tenantId field: the tenant comes from the
 * request context, and the global ValidationPipe (forbidNonWhitelisted) rejects
 * any attempt to spoof it in the body.
 */
export class CreateTicketDto {
  @IsString()
  @MinLength(1)
  title!: string;
}
