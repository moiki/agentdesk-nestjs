import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { ENV } from '../common/constants';

let sdk: NodeSDK | null = null;
let processor: LangfuseSpanProcessor | null = null;

/**
 * Tracing is an opt-in side channel. When LANGFUSE_ENABLED is set it registers
 * an OpenTelemetry NodeSDK that pipes Langfuse + GenAI spans to Langfuse via the
 * LangfuseSpanProcessor. Live-only, so dev/tests that don't set the flag stay
 * silent and fast.
 */
export function isTracingEnabled(): boolean {
  return ENV.LANGFUSE_ENABLED;
}

/**
 * Boots the OpenTelemetry SDK + Langfuse span processor. Idempotent. Called from
 * main.ts before the Nest app is created, so every span the agent creates later
 * is wired to the same tracer. Returns null when tracing is disabled.
 */
export function setupTracing(): NodeSDK | null {
  if (!isTracingEnabled()) {
    return null;
  }
  if (sdk) {
    return sdk;
  }
  processor = new LangfuseSpanProcessor({ environment: ENV.NODE_ENV });
  sdk = new NodeSDK({ spanProcessors: [processor] });
  sdk.start();
  return sdk;
}

/**
 * Forces any buffered spans to be flushed to Langfuse. Useful for short-lived
 * processes (scripts, test runs). A long-running server exports in the
 * background and generally does not need this.
 */
export function flushTracing(): Promise<void> {
  return processor ? processor.forceFlush() : Promise.resolve();
}
