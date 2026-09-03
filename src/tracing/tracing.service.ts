import { Injectable } from '@nestjs/common';
import {
  propagateAttributes,
  startActiveObservation,
  startObservation,
} from '@langfuse/tracing';
import type { LangfuseAgent } from '@langfuse/tracing';
import type { LangfuseGenerationAttributes } from '@langfuse/tracing';
import { ENV } from '../common/constants';
import { isTracingEnabled } from './tracing.setup';

export type TraceLevel = 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';

/**
 * Structural handle over a Langfuse observation. Lets callers set attributes
 * and close the observation without depending on the Langfuse SDK types, which
 * keeps the agent loop testable and swappable.
 */
export interface TraceObservation {
  update(attrs: TraceUpdateAttributes): void;
  end(): void;
}

export interface TraceUpdateAttributes {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, string>;
  usageDetails?: Record<string, number>;
  model?: string;
  level?: TraceLevel;
  statusMessage?: string;
}

export interface TraceTurnOptions {
  /** Stable, verb-first name (e.g. `agent-turn`). Kept free of dynamic values. */
  name: string;
  input?: unknown;
  userId?: string;
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, string>;
}

/**
 * Thin, tracing-aware facade around the Langfuse JS/TS SDK (v5, OTel-based).
 *
 * Every method is a no-op when tracing is disabled (LANGFUSE_ENABLED unset),
 * so the agent loop runs identically in dev/test without any observability
 * overhead or failures.
 *
 * Architecture per Langfuse best practices:
 *  - One trace per agent turn (`agent` observation), rooted via
 *    `startActiveObservation`, with trace attributes (user/session/tags)
 *    propagated to all descendants via `propagateAttributes`.
 *  - Each LLM invocation becomes a `generation` child observation with model,
 *    input, output and token usage.
 *  - Each tool call becomes a `tool` child observation nested as a sibling of
 *    the generation that requested it.
 */
@Injectable()
export class TracingService {
  get enabled(): boolean {
    return isTracingEnabled();
  }

  /**
   * Runs `fn` inside a traced agent turn.
   *
   * Opens a root `agent` observation that becomes the active span, propagates
   * trace attributes to everything created inside, sets the turn input/output,
   * and closes it when `fn` resolves. Returns `fn`'s result (identity for the
   * caller) plus the observation handle so the caller can set the final output.
   */
  async traceAgentTurn<T>(
    opts: TraceTurnOptions,
    fn: (span: TraceObservation | null) => Promise<T> | T,
  ): Promise<T> {
    if (!isTracingEnabled()) {
      return fn(null);
    }

    let result!: T;
    await propagateAttributes(
      {
        userId: opts.userId,
        sessionId: opts.sessionId,
        tags: opts.tags,
        metadata: opts.metadata,
        traceName: opts.name,
        environment: ENV.NODE_ENV,
      },
      async () => {
        await startActiveObservation(
          opts.name,
          async (agent: LangfuseAgent) => {
            agent.update({ input: opts.input });
            const span = toTraceObservation(agent);
            result = await fn(span);
          },
          { asType: 'agent' },
        );
      },
    );
    return result;
  }

  /**
   * Opens a `generation` observation for a single LLM invocation. Must be
   * `.end()`ed by the caller. Returns null when tracing is disabled.
   */
  startLlmCall(
    name: string,
    attrs: {
      model?: string;
      modelParameters?: Record<string, string | number>;
      input?: unknown;
    },
  ): TraceObservation | null {
    if (!isTracingEnabled()) return null;
    const gen = startObservation(
      name,
      {
        model: attrs.model,
        modelParameters: attrs.modelParameters,
        input: attrs.input,
      } as LangfuseGenerationAttributes,
      { asType: 'generation' },
    );
    return toTraceObservation(gen);
  }

  /**
   * Opens a `tool` observation for a tool call. Must be `.end()`ed by the
   * caller. Returns null when tracing is disabled.
   */
  startTool(name: string, input: unknown): TraceObservation | null {
    if (!isTracingEnabled()) return null;
    const tool = startObservation(name, { input }, { asType: 'tool' });
    return toTraceObservation(tool);
  }
}

function toTraceObservation(ob: {
  update(attrs: Record<string, unknown>): unknown;
  end(): unknown;
}): TraceObservation {
  return {
    update: (attrs) => {
      ob.update(attrs as unknown as Record<string, unknown>);
    },
    end: () => {
      ob.end();
    },
  };
}
