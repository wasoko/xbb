/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/sdb';
import { createDefaultExecutor, getStore, isModuleSource, type ToolCall } from '../src/recr';

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

/** Seed a script row the way the browser check does: a raw put carrying the `srcType` tag. */
async function putSrc(ref: string, txt: string) {
  await db.das.put({ ref, type: 'src', txt, tags: ['srcType'], rec: {}, dt: new Date() });
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

  it('marks a rewrite dirty without shelving a version of its own', async () => {
    await run('write_file', { filePath: 'src/b.ts', content: 'one' });
    await run('write_file', { filePath: 'src/b.ts', content: 'two' });

    const row = await db.das.where('[ref+type]').equals(['src/b.ts', 'src']).first();
    expect(row?.txt).toBe('two');
    expect(row?.modAt).toBeInstanceOf(Date);
    // no server has named this text: a version enters rec.ver only when one does
    expect(row?.rec.ver).toBeUndefined();
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

  it('ignores the srcType tag when resolving the row', async () => {
    await putSrc('scripts/tagged.js', 'return "tagged"');
    expect(await run('run_src', { ref: 'scripts/tagged.js' })).toBe('tagged');
  });
});

describe('run_src module rows', () => {
  it('imports a module row and calls its default export with ctx', async () => {
    await putSrc('scripts/mod.js', 'export default async function (ctx) { return ctx.args.n * 2 }');
    expect(await run('run_src', { ref: 'scripts/mod.js', args: { n: 21 } })).toBe('42');
  });

  it('stringifies a non-string module result', async () => {
    await putSrc('scripts/mod_obj.js', 'export default () => ({ ok: true })');
    expect(await run('run_src', { ref: 'scripts/mod_obj.js' })).toBe('{\n  "ok": true\n}');
  });

  it('reports a module without a default function', async () => {
    await putSrc('scripts/mod_named.js', 'export const value = 1');
    expect(await run('run_src', { ref: 'scripts/mod_named.js' }))
      .toBe('Error running scripts/mod_named.js: module row must export a default function(ctx)');
  });

  it('reports a module syntax error with the ref', async () => {
    await putSrc('scripts/mod_bad.js', 'export default function (');
    expect(await run('run_src', { ref: 'scripts/mod_bad.js' }))
      .toContain('Error running scripts/mod_bad.js:');
  });

  it('detects module syntax that shares a line with earlier statements', async () => {
    await putSrc('scripts/mod_inline.js', 'let n = 0; export default () => ++n');
    expect(await run('run_src', { ref: 'scripts/mod_inline.js' })).toBe('1');
  });

  it('keeps module state across two calls while the text is unchanged', async () => {
    await putSrc('scripts/mod_state.js', 'let n = 0\nexport default () => ++n');
    expect(await run('run_src', { ref: 'scripts/mod_state.js' })).toBe('1');
    expect(await run('run_src', { ref: 'scripts/mod_state.js' })).toBe('2');
  });
});

describe('run_src source classification', () => {
  it('separates module statements from function-body expressions', () => {
    expect(isModuleSource('export default 1')).toBe(true);
    expect(isModuleSource('import x from "y"')).toBe(true);
    expect(isModuleSource('  export{ a }')).toBe(true);
    expect(isModuleSource('import.meta.url')).toBe(true);
    expect(isModuleSource('exports.n = 1')).toBe(false);
    expect(isModuleSource('const m = await import("x")')).toBe(false);
    expect(isModuleSource('import("x")')).toBe(false);
    expect(isModuleSource('return 1')).toBe(false);
  });
});
