import { Injectable } from '@nestjs/common';
import { ENV } from '../../common/constants';
import { DEFAULT_IDENTITY_PROMPT } from './identity.prompt';
import type { TenantPromptContext } from './tenant-prompt.types';

export const MAX_EXTRA_INSTRUCTIONS = 2000;

const BRAND_VOICE_LABELS: Record<string, string> = {
  professional: 'professional',
  friendly: 'friendly',
  technical: 'technical',
  casual: 'casual',
};

/**
 * Builds the system prompt for a tenant by composing the shared AgentDesk
 * identity base with the tenant's company context captured during signup.
 *
 * When no tenant context is available (or fields are missing), it degrades
 * gracefully to the identity base with sensible defaults.
 */
@Injectable()
export class TenantPromptService {
  private readonly identityBase: string;

  constructor() {
    // AGENT_SYSTEM_PROMPT, if set, overrides the identity BASE only. It does
    // not replace the tenant context composition.
    this.identityBase = ENV.AGENT_SYSTEM_PROMPT || DEFAULT_IDENTITY_PROMPT;
  }

  buildForTenant(ctx: TenantPromptContext | null | undefined): string {
    const identity = this.identityBase;
    if (!ctx) {
      return identity;
    }

    const tenantSection: string[] = [];
    tenantSection.push(`## About the tenant`);
    tenantSection.push(
      `You are assisting users of ${ctx.name} (${ctx.domain}).`,
    );

    if (ctx.industry) {
      tenantSection.push(`Industry: ${ctx.industry}.`);
    }
    if (ctx.companyDescription) {
      tenantSection.push(`What they do: ${ctx.companyDescription}`);
    }

    if (ctx.supportEmail || ctx.supportPhone) {
      const contact: string[] = [];
      if (ctx.supportEmail) contact.push(`email ${ctx.supportEmail}`);
      if (ctx.supportPhone) contact.push(`phone ${ctx.supportPhone}`);
      tenantSection.push(
        `When the user needs to escalate, provide the support channels: ${contact.join(' or ')}.`,
      );
    }

    const voice = ctx.brandVoice
      ? (BRAND_VOICE_LABELS[ctx.brandVoice] ?? ctx.brandVoice)
      : 'professional';
    tenantSection.push(`Adopt a ${voice} tone in your responses.`);

    const language = ctx.defaultLanguage || 'es';
    tenantSection.push(
      `Respond primarily in ${language === 'en' ? 'English' : 'Spanish'}, but follow the language the user writes in.`,
    );

    return `${identity}\n\n${tenantSection.join('\n')}`;
  }

  /**
   * Appends optional, untrusted client instructions after the full tenant
   * prompt. Capped in length so a client can never bloat or hijack the prompt.
   */
  appendExtraInstructions(prompt: string, extraInstructions?: string): string {
    if (!extraInstructions || extraInstructions.trim().length === 0) {
      return prompt;
    }
    const capped = extraInstructions.trim().slice(0, MAX_EXTRA_INSTRUCTIONS);
    return `${prompt}\n\n## Additional instructions\n${capped}`;
  }
}
