/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/sdb';
import { createDefaultExecutor, getStore, TASK_COMPLETE, type ToolCall } from '../src/recr';
import { filterTools, gateTools, loadGate } from '../src/recrGate';
import type { ToolDef } from '../src/recr';

const ALL: ToolDef[] = ['read_file', 'write_file', 'search_content', 'list_dir', 'run_src', 'run_command', TASK_COMPLETE]
  .map(name => ({ name, description: '', parameters: {} }));

const names = (tools: ToolDef[]) => tools.map(t => t.name);

async function putGate(txt: string) {
  await db.das.put({ ref: 'gate.md', type: 'md', txt, rec: {}, dt: new Date() });
}

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `c-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

describe('gate levels', () => {
  beforeEach(async () => {
    await db.das.clear();
  });

  it('levels are cumulative and never gate the end of a turn', () => {
    expect([...gateTools('read')].sort()).toEqual(['list_dir', 'read_file', 'search_content', TASK_COMPLETE].sort());
    expect(gateTools('rw').has('write_file')).toBe(true);
    expect(gateTools('rw').has('run_src')).toBe(false);
    expect(gateTools('rwr').has('run_src')).toBe(true);
    expect(gateTools('rwr').has('run_command')).toBe(false);
    expect(gateTools('all').has('run_command')).toBe(true);
  });

  it('rwr offers read, write, and script tools but not run_command', async () => {
    expect(names(filterTools(ALL, 'rwr'))).not.toContain('run_command');
    expect(names(filterTools(ALL, 'rwr'))).toContain('run_src');
  });

  it('defaults to read with no endpoints when gate.md is absent', async () => {
    expect(await loadGate()).toEqual({ level: 'read', endpoints: [] });
  });

  it('reads the level and endpoint list from gate.md', async () => {
    await putGate(`## Selected
* Level: rwr

## Endpoints
- https://example.com
- https://api.test
`);
    expect(await loadGate()).toEqual({
      level: 'rwr', endpoints: ['https://example.com', 'https://api.test'],
    });
  });

  it('fails closed on an unknown level', async () => {
    await putGate('## Selected\n* Level: root\n');
    expect((await loadGate()).level).toBe('read');
  });

  it('fails closed on a tombstoned gate.md', async () => {
    await putGate('## Selected\n* Level: all\n');
    const row = await db.das.where('[ref+type]').equals(['gate.md', 'md']).first();
    await db.das.update(row!.tid!, { tags: ['[del]'], modAt: new Date() });
    expect((await loadGate()).level).toBe('read');
  });
});

describe('executor refusal', () => {
  beforeEach(async () => {
    await db.das.clear();
  });

  it('refuses a writing tool filtered out of the read level', async () => {
    const ex = createDefaultExecutor({ level: 'read', endpoints: [] });
    const [msg] = await ex.execute([call('write_file', { filePath: 'a.ts', content: 'x' })], getStore());
    expect(msg.content).toContain('not permitted');
  });

  it('refuses run_src below rwr even when the model asks for it', async () => {
    const ex = createDefaultExecutor({ level: 'rw', endpoints: [] });
    const [msg] = await ex.execute([call('run_src', { ref: 'a.ts' })], getStore());
    expect(msg.content).toContain('not permitted');
  });

  it('allows an endpoint listed under Endpoints', async () => {
    // the tool fetches for real, so stub the call rather than reach the network
    const fetchMock = vi.fn(async () => new Response('pong'));
    vi.stubGlobal('fetch', fetchMock);
    const ex = createDefaultExecutor({ level: 'all', endpoints: ['https://example.com'] });
    expect(ex.denial('run_command')).toBeUndefined();
    const [msg] = await ex.execute([call('run_command', { endpoint: 'https://example.com/x' })], getStore());
    expect(msg.content).toBe('pong');
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('refuses any endpoint when the list is empty', async () => {
    const ex = createDefaultExecutor({ level: 'all', endpoints: [] });
    const [msg] = await ex.execute([call('run_command', { endpoint: 'https://elsewhere.test' })], getStore());
    expect(msg.content).toContain('not listed in gate.md');
  });
});
