import {
  IsEmail,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Plan } from '../../generated/prisma/client';

export const BRAND_VOICES = [
  'professional',
  'friendly',
  'technical',
  'casual',
] as const;
export type BrandVoice = (typeof BRAND_VOICES)[number];

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

  @IsOptional()
  @IsString()
  @MaxLength(80)
  industry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  companyDescription?: string;

  @IsOptional()
  @IsEmail()
  supportEmail?: string;

  @IsOptional()
  @Matches(/^\+?[0-9\s\-()]{7,20}$/, {
    message: 'supportPhone must be a valid phone number',
  })
  supportPhone?: string;

  @IsOptional()
  @IsIn(BRAND_VOICES)
  brandVoice?: BrandVoice;

  @IsOptional()
  @IsIn(['es', 'en'])
  defaultLanguage?: 'es' | 'en';
}
