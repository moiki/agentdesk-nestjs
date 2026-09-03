import { z } from 'zod';
import { ToolRegistry } from './tool-registry.service';
import type { Tool } from './tool.interface';

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'test_tool',
    description: 'A test tool',
    inputSchema: z.object({ input: z.string() }),
    execute: (input) => Promise.resolve({ success: true, data: input }),
    ...overrides,
  };
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('registers a tool and retrieves it', () => {
    const tool = makeTool();
    registry.register(tool);

    expect(registry.has('test_tool')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('returns ToolDefinitions for all registered tools', () => {
    registry.register(makeTool({ name: 'alpha' }));
    registry.register(makeTool({ name: 'beta' }));

    const defs = registry.getDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.name)).toEqual(['alpha', 'beta']);
  });

  it('overwrites a tool with the same name', () => {
    registry.register(makeTool({ name: 'dup', description: 'first' }));
    registry.register(makeTool({ name: 'dup', description: 'second' }));

    const defs = registry.getDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].description).toBe('second');
  });

  it('getTool returns the tool by name', () => {
    const tool = makeTool({ name: 'findable' });
    registry.register(tool);

    expect(registry.getTool('findable')).toBe(tool);
    expect(registry.getTool('nope')).toBeUndefined();
  });

  it('executes a registered tool with validated input', async () => {
    registry.register(
      makeTool({
        execute: (input) =>
          Promise.resolve({
            success: true,
            data: `processed:${(input as { input: string }).input}`,
          }),
      }),
    );

    const result = await registry.execute('test_tool', { input: 'hello' });
    expect(result).toEqual({ success: true, data: 'processed:hello' });
  });

  it('returns structured VALIDATION_ERROR for unknown tool', async () => {
    const result = await registry.execute('nope', {});
    expect(result).toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Unknown tool: nope' },
    });
  });

  it('returns structured VALIDATION_ERROR for invalid input', async () => {
    registry.register(makeTool());

    const result = await registry.execute('test_tool', { wrong: 123 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.message).toContain('Invalid input');
    }
  });

  it('returns structured INTERNAL_ERROR for executor failures', async () => {
    registry.register(
      makeTool({
        execute: () => {
          throw new Error('boom');
        },
      }),
    );

    const result = await registry.execute('test_tool', { input: 'x' });
    expect(result).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'boom' },
    });
  });

  it('truncates large string results', async () => {
    const bigString = 'x'.repeat(8000);
    registry.register(
      makeTool({
        execute: () => Promise.resolve({ success: true, data: bigString }),
      }),
    );

    const result = await registry.execute('test_tool', { input: 'x' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as string).length).toBeLessThan(8000);
      expect(result.data).toContain('[Result truncated');
    }
  });

  it('truncates large object results', async () => {
    const bigArray = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      data: 'x'.repeat(50),
    }));
    registry.register(
      makeTool({
        execute: () => Promise.resolve({ success: true, data: bigArray }),
      }),
    );

    const result = await registry.execute('test_tool', { input: 'x' });
    expect(result.success).toBe(true);
    if (result.success) {
      const json = JSON.stringify(result.data);
      expect(json).toContain('[Result truncated');
    }
  });

  it('does not truncate small results', async () => {
    registry.register(
      makeTool({
        execute: () => Promise.resolve({ success: true, data: 'small' }),
      }),
    );

    const result = await registry.execute('test_tool', { input: 'x' });
    expect(result).toEqual({ success: true, data: 'small' });
  });

  it('replays a cached result for a repeated toolCallId (dedup)', async () => {
    let calls = 0;
    registry.register(
      makeTool({
        execute: () => {
          calls += 1;
          return Promise.resolve({ success: true, data: `call-${calls}` });
        },
      }),
    );

    const first = await registry.execute('test_tool', { input: 'x' }, 'call-a');
    const second = await registry.execute(
      'test_tool',
      { input: 'x' },
      'call-a',
    );

    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  it('executes independently for distinct toolCallIds', async () => {
    let calls = 0;
    registry.register(
      makeTool({
        execute: () => {
          calls += 1;
          return Promise.resolve({ success: true, data: `call-${calls}` });
        },
      }),
    );

    await registry.execute('test_tool', { input: 'x' }, 'id-1');
    await registry.execute('test_tool', { input: 'x' }, 'id-2');

    expect(calls).toBe(2);
  });
});
