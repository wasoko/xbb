// @vitest-environment happy-dom
/**
 * runsrc.test.ts — the path a row takes: the row text, its compiled twin, or a tab.
 *
 * The webapp's behaviour is the constraint: when the realm can eval, the row text
 * runs and no twin is consulted. The extension's case is the fallback: an exact-text
 * twin, or a refusal that names the missing capability.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerBodyTwin, registerTabBodyRunner, runBody, runBodyWithPath, setEvalProbe,
  SrcUnavailableError, type RecrScriptContext,
} from '../src/runsrc';
import { needsTab, rowMeta } from '../src/rowMeta';
import { SRCFEED_BODY_TWINS, WEBFEED_EXTRACT_BODY, webFeedReport } from '../src/srcfeedRows';
import type { FeedAttempt, FeedDa, FeedDocResult } from '../src/srcfeedWeb';

/** `ctx` of a `run_src` call, with the test's own console. */
const ctx = (args: unknown = {}): RecrScriptContext =>
  ({ db: {}, ref: 'demo.js', args, console });

afterEach(() => {
  setEvalProbe(null);
  registerTabBodyRunner(null);
  delete (globalThis as Record<string, unknown>).webfeed;
});

describe('rowMeta', () => {
  it('reads the header and stops at the body', () => {
    const meta = rowMeta([
      '// @requires tab',
      '// @requires user-scripts',
      '// @match https://e.test/*',
      '// @max 25',
      '// @prompt open it',
      '// @version 2',
      'return 1',
    ].join('\n'));
    expect(meta.requires).toEqual(['tab', 'user-scripts']);
    expect(meta.match).toBe('https://e.test/*');
    expect(meta.max).toBe(25);
    expect(meta.prompt).toBe('open it');
    expect(meta.extra).toEqual({ version: ['2'] });
  });

  it('ignores @ inside the body', () => {
    expect(rowMeta('// plain comment\nreturn "// @requires tab"').requires).toEqual([]);
  });

  it('treats tab, extension and user-scripts as a tab requirement', () => {
    expect(needsTab(rowMeta('// @requires tab'))).toBe(true);
    expect(needsTab(rowMeta('// @requires extension'))).toBe(true);
    expect(needsTab(rowMeta('// @requires user-scripts'))).toBe(true);
    expect(needsTab(rowMeta('return 1'))).toBe(false);
  });
});

describe('path selection', () => {
  it('runs the row text when this realm can eval', async () => {
    setEvalProbe(true);
    expect(await runBody('return 40 + 2', ctx())).toBe(42);
  });

  it('never consults a twin when eval works', async () => {
    setEvalProbe(true);
    const body = 'return "row"';
    registerBodyTwin(body, async () => 'twin');
    await expect(runBodyWithPath(body, ctx())).resolves.toEqual({ value: 'row', path: 'body' });
  });

  it('uses the exact-text twin only when eval is blocked', async () => {
    setEvalProbe(false);
    const body = 'return "row"';
    registerBodyTwin(body, async () => 'twin');
    await expect(runBodyWithPath(body, ctx())).resolves.toEqual({ value: 'twin', path: 'twin' });
  });

  it('does not use a twin for an edited body', async () => {
    setEvalProbe(false);
    registerBodyTwin('return "row"', async () => 'twin');
    const error = await runBody('return "row" ', ctx()).catch(e => e);
    expect(error).toBeInstanceOf(SrcUnavailableError);
    expect((error as SrcUnavailableError).code).toBe('eval-blocked');
    expect((error as SrcUnavailableError).steps.length).toBeGreaterThan(0);
  });

  it('routes @requires tab rows to the tab runner even where eval works', async () => {
    setEvalProbe(true);
    registerTabBodyRunner(async (_body, _ctx, meta) => ({ tab: true, match: meta.match }));
    const body = '// @requires tab\n// @match https://e.test/*\nreturn null';
    await expect(runBodyWithPath(body, ctx())).resolves.toEqual({
      value: { tab: true, match: 'https://e.test/*' },
      path: 'tab',
    });
  });

  it('refuses a tab row when this host has no runner', async () => {
    const error = await runBody('// @requires tab\nreturn null', ctx()).catch(e => e);
    expect(error).toBeInstanceOf(SrcUnavailableError);
    expect((error as SrcUnavailableError).code).toBe('not-extension');
  });
});

describe('feed twin parity', () => {
  const rows = (n: number): FeedDa[] => Array.from({ length: n }, (_, i) => ({
    txt: `t${i}`, ref: `https://x.test/${i}`, type: 'url', rec: { feed: 'demo' },
  }));
  const attempt: FeedAttempt = {
    source: 'demo', strategy: 'api', url: 'https://api.test', delayMs: 0,
    ok: true, status: 200, bytes: 10, ms: 12, error: '',
  };
  const result: FeedDocResult = {
    ref: 'webfeed.md',
    sources: [{
      source: 'demo', url: 'https://demo.test', type: 'url', strategy: 'api',
      das: rows(3), attempts: [attempt], stoppedAt: '', notes: ['source note'],
    }],
    das: rows(3),
    attempts: [attempt],
    notes: ['doc note'],
  };

  it('is registered for the seeded body text', () => {
    expect(SRCFEED_BODY_TWINS.has(WEBFEED_EXTRACT_BODY)).toBe(true);
  });

  it('reproduces the body report, including showRows and the source lines', async () => {
    (globalThis as Record<string, unknown>).webfeed = { extractFromDoc: async () => result };
    const out = await runBody(WEBFEED_EXTRACT_BODY, ctx({ showRows: 2 }));
    expect(out).toEqual(webFeedReport(result, { showRows: 2 }));
    expect((out as { das: unknown[] }).das).toHaveLength(2);
    expect((out as { sources: string[] }).sources[0]).toContain('demo -> api, 3 row(s)');
    expect(out).not.toHaveProperty('attempts');
  });
});
