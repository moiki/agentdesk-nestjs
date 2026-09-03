import { Test, TestingModule } from '@nestjs/testing';
import {
  MAX_EXTRA_INSTRUCTIONS,
  TenantPromptService,
} from './tenant-prompt.service';
import type { TenantPromptContext } from './tenant-prompt.types';

describe('TenantPromptService', () => {
  let service: TenantPromptService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TenantPromptService],
    }).compile();
    service = module.get(TenantPromptService);
  });

  const baseCtx: TenantPromptContext = {
    id: 'tenant-1',
    name: 'Acme',
    domain: 'acme',
    plan: 'FREE',
  };

  it('builds a prompt with the AgentDesk identity base when no tenant context', () => {
    const prompt = service.buildForTenant(null);
    expect(prompt).toContain('You are AgentDesk');
    expect(prompt).toContain('NOT_FOUND');
    expect(prompt).toContain('REJECTED_BY_USER');
    expect(prompt).toContain('Approval policy');
  });

  it('includes the tenant name and domain', () => {
    const prompt = service.buildForTenant(baseCtx);
    expect(prompt).toContain('You are assisting users of Acme');
    expect(prompt).toContain('acme');
  });

  it('includes industry, company description and support channels when present', () => {
    const prompt = service.buildForTenant({
      ...baseCtx,
      industry: 'SaaS',
      companyDescription: 'Plataforma de tickets',
      supportEmail: 'soporte@acme.dev',
      supportPhone: '+34 600 123 456',
    });
    expect(prompt).toContain('Industry: SaaS');
    expect(prompt).toContain('Plataforma de tickets');
    expect(prompt).toContain('soporte@acme.dev');
    expect(prompt).toContain('+34 600 123 456');
  });

  it('defaults tone to professional and language to Spanish when unset', () => {
    const prompt = service.buildForTenant(baseCtx);
    expect(prompt).toContain('professional tone');
    expect(prompt).toContain('Spanish');
  });

  it('uses the tenant brandVoice and defaultLanguage when provided', () => {
    const prompt = service.buildForTenant({
      ...baseCtx,
      brandVoice: 'friendly',
      defaultLanguage: 'en',
    });
    expect(prompt).toContain('friendly tone');
    expect(prompt).toContain('English');
  });

  it('gracefully handles a tenant with all context fields null', () => {
    const prompt = service.buildForTenant({
      ...baseCtx,
      industry: null,
      companyDescription: null,
      supportEmail: null,
      supportPhone: null,
      brandVoice: null,
      defaultLanguage: null,
    });
    expect(prompt).toContain('You are assisting users of Acme');
    expect(prompt).toContain('You are AgentDesk');
  });

  it('appendExtraInstructions returns prompt unchanged when empty', () => {
    const prompt = service.appendExtraInstructions('base', '   ');
    expect(prompt).toBe('base');
    expect(service.appendExtraInstructions('base', undefined)).toBe('base');
  });

  it('appends capped extra instructions', () => {
    const prompt = service.appendExtraInstructions('base', 'Speak briefly.');
    expect(prompt).toContain('## Additional instructions');
    expect(prompt).toContain('Speak briefly.');
  });

  it('caps extra instructions to MAX_EXTRA_INSTRUCTIONS', () => {
    const long = 'x'.repeat(MAX_EXTRA_INSTRUCTIONS + 100);
    const prompt = service.appendExtraInstructions('base', long);
    expect(prompt).not.toContain('#'.repeat(101));
  });
});
