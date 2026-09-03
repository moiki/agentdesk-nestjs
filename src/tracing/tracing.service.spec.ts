import { TracingService } from './tracing.service';

// Tracing is opt-in via LANGFUSE_ENABLED. In the test/dev environment this flag
// is unset (or explicitly false), so the service takes its no-op path — the
// contract these tests assert.
describe('TracingService (disabled)', () => {
  it('reports enabled=false by default', () => {
    const svc = new TracingService();
    expect(svc.enabled).toBe(false);
  });

  it('traceAgentTurn calls fn with a null span and returns its result', async () => {
    const svc = new TracingService();
    const seen: (TraceObservationLike | null)[] = [];
    const result = await svc.traceAgentTurn(
      { name: 'agent-turn', userId: 'u1', sessionId: 'c1' },
      (span) => {
        seen.push(span);
        return 'done';
      },
    );
    expect(seen).toEqual([null]);
    expect(result).toBe('done');
  });

  it('startLlmCall and startTool are no-ops (return null) when disabled', () => {
    const svc = new TracingService();
    expect(svc.startLlmCall('llm-call', { model: 'm' })).toBeNull();
    expect(svc.startTool('get_ticket', {})).toBeNull();
  });
});

type TraceObservationLike = {
  update: (attrs: unknown) => void;
  end: () => void;
} | null;
