import type { LlmProvider } from './llm-provider.interface';
import type { LlmRequest, LlmResponse, LlmToolCall } from './llm.types';

/**
 * A matcher that a cassette is tried against. All set fields must match.
 * `toolName` matches the LAST tool call present in the request history.
 */
export interface CassetteMatch {
  model?: string;
  hasToolCalls?: boolean;
  toolName?: string;
  /** Substring present in the last user message. */
  includesText?: string;
}

export interface LlmCassette {
  match: CassetteMatch;
  response: LlmResponse;
}

export interface FakeLlmProviderOptions {
  cassettes?: LlmCassette[];
  /**
   * Throw when no cassette matches (test mode). When false, unmatched
   * requests fall back to `defaultResponse`.
   */
  strict?: boolean;
  defaultResponse?: LlmResponse;
}

/**
 * Pure matching logic — unit-tested without any provider instance.
 */
export function matchesCassette(
  match: CassetteMatch,
  request: LlmRequest,
): boolean {
  if (match.model !== undefined && match.model !== request.model) {
    return false;
  }

  const toolCalls = collectToolCalls(request.messages);

  if (
    match.hasToolCalls !== undefined &&
    match.hasToolCalls !== toolCalls.length > 0
  ) {
    return false;
  }

  if (match.toolName !== undefined) {
    const last = toolCalls[toolCalls.length - 1];
    if (!last || last.name !== match.toolName) {
      return false;
    }
  }

  if (match.includesText !== undefined) {
    const lastUser = [...request.messages]
      .reverse()
      .find((m) => m.role === 'user');
    if (!lastUser || !lastUser.content.includes(match.includesText)) {
      return false;
    }
  }

  return true;
}

function collectToolCalls(messages: LlmRequest['messages']): LlmToolCall[] {
  return messages.flatMap((m) => m.toolCalls ?? []);
}

/**
 * Cassette/VCR-style provider for tests: requests are matched against recorded
 * cassettes and the recorded response is returned verbatim — no network, no
 * tokens spent, fully deterministic. Every request is recorded in `requests`
 * so tests can assert on what the caller actually sent.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly name = 'fake';

  private readonly cassettes: LlmCassette[];
  private readonly strict: boolean;
  private readonly defaultResponse?: LlmResponse;

  /** Every `complete()` call, in order — used for assertions. */
  readonly requests: LlmRequest[] = [];

  constructor(options: FakeLlmProviderOptions = {}) {
    this.cassettes = options.cassettes ? [...options.cassettes] : [];
    this.strict = options.strict ?? true;
    this.defaultResponse = options.defaultResponse;
  }

  add(cassette: LlmCassette): this {
    this.cassettes.push(cassette);
    return this;
  }

  addCassettes(cassettes: LlmCassette[]): this {
    this.cassettes.push(...cassettes);
    return this;
  }

  complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);

    const hit = this.cassettes.find((c) => matchesCassette(c.match, request));
    if (hit) {
      return Promise.resolve(hit.response);
    }

    if (this.strict || !this.defaultResponse) {
      return Promise.reject(
        new Error(
          `FakeLlmProvider: no cassette matches the request "${describe(request)}"`,
        ),
      );
    }

    return Promise.resolve(this.defaultResponse);
  }
}

function describe(request: LlmRequest): string {
  const toolCalls = collectToolCalls(request.messages);
  const lastTool = toolCalls[toolCalls.length - 1];
  return `model=${request.model}${lastTool ? ` lastTool=${lastTool.name}` : ''} includes=${JSON.stringify(
    [...request.messages]
      .reverse()
      .find((m) => m.role === 'user')
      ?.content.slice(0, 60) ?? '',
  )}`;
}
