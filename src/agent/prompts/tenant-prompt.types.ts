/**
 * The subset of the Tenant model needed to build a tenant-specific system
 * prompt. Kept as a plain interface so the builder stays decoupled from Prisma
 * and unit-testable without a database.
 */
export interface TenantPromptContext {
  id: string;
  name: string;
  domain: string;
  plan: string;
  industry?: string | null;
  companyDescription?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  brandVoice?: string | null;
  defaultLanguage?: string | null;
}
