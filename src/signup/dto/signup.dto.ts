import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Plan } from '../../generated/prisma/client';

export class SignupDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  companyName!: string;

  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, {
    message:
      'workspaceName must be a 3-40 char slug (lowercase letters, digits, hyphens)',
  })
  workspaceName!: string;

  @IsEmail()
  adminEmail!: string;

  @IsString()
  @MinLength(8)
  adminPassword!: string;

  @IsOptional()
  @IsEnum(Plan)
  plan?: Plan;
}
