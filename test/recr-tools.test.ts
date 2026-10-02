/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/sdb';
import { createDefaultExecutor, getStore, type ToolCall } from '../src/recr';

const UUID = '11111111-1111-4111-8111-111111111111';

/** The gate level that opens every tool, so one executor covers all of them. */
const ex = () => createDefaultExecutor({ level: 'all', endpoints: [] });

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `${name}-${UUID}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

async function run(name: string, args: Record<string, unknown>) {
  const [msg] = await ex().execute([call(name, args)], getStore());
  return msg.content;
}

beforeEach(async () => {
  await db.das.clear();
});

describe('file tools', () => {
  it('writes and reads a file ref, tagging the created row', async () => {
    expect(await run('write_file', { filePath: 'src/a.ts', content: 'const a = 1' }))
      .toBe('Wrote 11 chars to src/a.ts');
    expect(await run('read_file', { filePath: 'src/a.ts' })).toBe('const a = 1');

    const row = await db.das.where('[ref+type]').equals(['src/a.ts', 'src']).first();
    expect(row?.tags).toEqual(['ai']);
  });

  it('shelves the pre-edit version on rewrite, like the editor does', async () => {
    await run('write_file', { filePath: 'src/b.ts', content: 'one' });
    await run('write_file', { filePath: 'src/b.ts', content: 'two' });

    const row = await db.das.where('[ref+type]').equals(['src/b.ts', 'src']).first();
    expect(row?.txt).toBe('two');
    expect(Object.values(row?.rec.ver ?? {}).map(v => (v as { txt: string }).txt)).toEqual(['one']);
  });

  it('selects a markdown row by extension rather than by the write path', async () => {
    await run('write_file', { filePath: 'notes.md', content: '# hi' });
    expect((await db.das.where('[ref+type]').equals(['notes.md', 'md']).first())?.txt).toBe('# hi');
  });

  it('reports a missing file by ref', async () => {
    expect(await run('read_file', { filePath: 'nope.ts' })).toBe('Error: file not found: nope.ts');
  });

  it('slices a line range', async () => {
    await run('write_file', { filePath: 'src/c.ts', content: 'a\nb\nc\nd' });
    expect(await run('read_file', { filePath: 'src/c.ts', startLine: 2, endLine: 3 })).toBe('b\nc');
  });

  it('lists one level, marking directories', async () => {
    await run('write_file', { filePath: 'src/a.ts', content: '' });
    await run('write_file', { filePath: 'src/lib/deep.ts', content: '' });
    await run('write_file', { filePath: 'readme.md', content: '' });
    expect(await run('list_dir', { path: 'src' })).toBe('a.ts\nlib/');
    expect(await run('list_dir', { path: '' })).toBe('readme.md\nsrc/');
  });

  it('searches file bodies with ref and line number', async () => {
    await run('write_file', { filePath: 'src/a.ts', content: 'const needle = 1\nother' });
    await run('write_file', { filePath: 'src/b.ts', content: 'nothing' });
    expect(await run('search_content', { query: 'Needle' })).toBe('src/a.ts:1: const needle = 1');
    expect(await run('search_content', { query: 'zzz' })).toBe('No matches found for "zzz"');
  });

  it('scopes a search to a directory prefix', async () => {
    await run('write_file', { filePath: 'src/a.ts', content: 'needle' });
    await run('write_file', { filePath: 'other/b.ts', content: 'needle' });
    expect(await run('search_content', { query: 'needle', directory: 'other' })).toBe('other/b.ts:1: needle');
  });
});

describe('run_src', () => {
  beforeEach(async () => {
    await run('write_file', { filePath: 'scripts/double.ts'
      , content: 'return ctx.args.n * 2' });
  });

  it('awaits the script and forwards args through ctx', async () => {
    expect(await run('run_src', { ref: 'scripts/double.ts', args: { n: 21 } })).toBe('42');
  });

  it('stringifies a non-string result', async () => {
    await run('write_file', { filePath: 'scripts/obj.ts', content: 'return { ok: true }' });
    expect(await run('run_src', { ref: 'scripts/obj.ts' })).toBe('{\n  "ok": true\n}');
  });

  it('runs in page context, so the script can reach the db it was given', async () => {
    await run('write_file', { filePath: 'scripts/count.ts'
      , content: 'return "db:" + typeof ctx.db.das.where' });
    expect(await run('run_src', { ref: 'scripts/count.ts' })).toBe('db:function');
  });

  it('reports a thrown error with the script ref', async () => {
    await run('write_file', { filePath: 'scripts/boom.ts', content: 'throw new Error("boom")' });
    expect(await run('run_src', { ref: 'scripts/boom.ts' })).toBe('Error running scripts/boom.ts: boom');
  });

  it('reports an unknown script', async () => {
    expect(await run('run_src', { ref: 'scripts/none.ts' })).toBe('Error: script not found: scripts/none.ts');
  });
});
