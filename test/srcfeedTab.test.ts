// @vitest-environment happy-dom
/**
 * srcfeedTab.test.ts — the tab port of a feed source: the header, the refusal
 * catalogue, and the body that reads a live tab.
 *
 * The body is exercised by evaluating the wrapper `chrome.userScripts` would be
 * given, against a happy-dom document: the wrapper is the same string either way.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { parseExtSrcDoc } from '../src/srcfeed';
import { EXTSRC_DOC, EXTSRC_EXTRACT_BODY } from '../src/srcfeedRows';
import {
  isExtensionPage, resetTabEnv, runTabRow, tabEnv, tabFailure, wrapTabBody,
  type ExtTab, type TabClient,
} from '../src/srcfeedTab';
import type { RecrScriptContext } from '../src/runsrc';
import { rowMeta } from '../src/rowMeta';

/** What one wrapped body resolves to. */
interface WrappedResult {
  ok: boolean;
  error?: string;
  logs: string[];
  value?: {
    rows: Array<{ txt: string; ref: string; tags?: string[]; rec?: { html?: string } }>;
    notes: string[];
    needsUser?: string;
  };
}

/** Evaluate the wrapper the way `chrome.userScripts.execute` does. */
async function runInTab(source: Record<string, unknown>): Promise<WrappedResult> {
  const code = wrapTabBody(EXTSRC_EXTRACT_BODY, { ref: 'extsrc/extract.js', args: { source } });
  const run = new Function(`return ${code}`) as () => Promise<WrappedResult>;
  return run();
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetTabEnv();
});

describe('legacy document dialect', () => {
  it('reads the seeded sources', () => {
    const sources = parseExtSrcDoc(EXTSRC_DOC);
    expect(sources.map(s => s.name)).toEqual(['gemini', 'deepseek']);
    expect(sources[0]).toMatchObject({
      url: 'https://gemini.google.com/*', item: 'a[href*="/app/"]', tabs: 'all', mode: 'dom', max: 55555,
    });
    expect(sources[0].prompt).toContain('chat sidebar');
    expect(sources[0].tags).toEqual(['gemini', 'chat']);
  });

  it('skips a block without a URL', () => {
    expect(parseExtSrcDoc('## Sources\n\n### broken\n* Item: a\n')).toEqual([]);
  });
});

describe('row header', () => {
  it('declares the tab requirement the seeded body needs', () => {
    expect(rowMeta(EXTSRC_EXTRACT_BODY).requires).toEqual(['tab', 'user-scripts']);
  });
});

describe('refusal catalogue', () => {
  it('names the setting, the steps and the reference when user scripts are off', () => {
    const f = tabFailure('user-scripts-off', { ref: 'extdom/dsc' });
    const steps = f.steps.join('\n');
    expect(f.message).toBe('Allow User Scripts is off for this extension');
    expect(steps).toContain('chrome://extensions');
    expect(steps).toContain('Allow User Scripts');
    expect(steps).toContain('Developer mode');
    expect(steps).toContain('https://developer.chrome.com/docs/extensions/reference/api/userScripts');
  });

  it('carries the probe reason when it has one', () => {
    const f = tabFailure('user-scripts-off', { ref: 'r', reason: 'no such permission' });
    expect(f.message).toContain('no such permission');
  });

  it('names the pattern when no tab matches', () => {
    const f = tabFailure('no-tab', { ref: 'r', url: 'https://e.test/*' });
    expect(f.message).toBe('no open tab matches https://e.test/*');
    expect(f.steps[0]).toContain('Open https://e.test/*');
  });

  it('uses the source prompt when the page needs a manual step', () => {
    const f = tabFailure('needs-user', { ref: 'r', prompt: 'open the history sidebar' });
    expect(f.message).toBe('open the history sidebar');
  });

  it('names the extension when the webapp runs a tab row', () => {
    expect(tabFailure('not-extension', { ref: 'extdom/dsc' }).message).toContain('needs the extension');
  });
});

describe('environment', () => {
  it('reports a webapp, not an extension page', async () => {
    expect(isExtensionPage()).toBe(false);
    await expect(tabEnv()).resolves.toMatchObject({ extension: false, userScripts: false });
  });
});

describe('tab body', () => {
  it('reads the anchors of the open sidebar', async () => {
    document.body.innerHTML = '<aside class="hist">'
      + '<a href="/a/chat/1">First chat</a><a href="/a/chat/2">Second chat</a>'
      + '</aside>';
    const res = await runInTab({
      name: 'demo', url: 'https://e.test/*', sidebar: '.hist',
      item: 'a[href^="/a/chat"]', mode: 'dom', max: 10, tags: ['chat'],
    });
    expect(res.ok).toBe(true);
    expect(res.value?.rows.map(r => r.txt)).toEqual(['First chat', 'Second chat']);
    expect(res.value?.rows[0].ref.endsWith('/a/chat/1')).toBe(true);
    expect(res.value?.rows[0].tags).toEqual(['demo', 'chat']);
  });

  it('asks the user to open the sidebar instead of returning an empty list', async () => {
    document.body.innerHTML = '<div></div>';
    const res = await runInTab({
      name: 'demo', url: 'https://e.test/*', sidebar: '.hist', item: 'a',
      prompt: 'open the history sidebar',
    });
    expect(res.ok).toBe(true);
    expect(res.value?.rows).toEqual([]);
    expect(res.value?.needsUser).toBe('open the history sidebar');
  });

  it('asks for the entry prompt when the list is empty and no Sidebar is declared', async () => {
    document.body.innerHTML = '<div></div>';
    const res = await runInTab({
      name: 'demo', url: 'https://e.test/*', item: 'a[href^="/a/chat"]',
      prompt: 'open the history sidebar',
    });
    expect(res.value?.rows).toEqual([]);
    expect(res.value?.needsUser).toBe('open the history sidebar');
  });

  it('reads the list when the sidebar wrapper it was told to expect is gone', async () => {
    document.body.innerHTML = '<nav class="renamed">'
      + '<a href="/a/chat/1">First chat</a><a href="/a/chat/2">Second chat</a>'
      + '</nav>';
    const res = await runInTab({
      name: 'demo', url: 'https://e.test/*', sidebar: '.hist',
      item: 'a[href^="/a/chat"]', prompt: 'open the history sidebar',
    });
    expect(res.ok).toBe(true);
    expect(res.value?.rows.map(r => r.txt)).toEqual(['First chat', 'Second chat']);
    expect(res.value?.needsUser).toBeUndefined();
  });

  it('reports the selector that matched nothing', async () => {
    document.body.innerHTML = '<aside class="hist"></aside>';
    const res = await runInTab({
      name: 'demo', url: 'https://e.test/*', sidebar: '.hist', item: 'a.missing',
    });
    expect(res.value?.notes).toContain('no element matched a.missing');
  });

  it('keeps outerHTML in html mode', async () => {
    document.body.innerHTML = '<aside class="hist"><a href="/a/chat/1">First chat</a></aside>';
    const res = await runInTab({
      name: 'demo', url: 'https://e.test/*', sidebar: '.hist',
      item: 'a[href^="/a/chat"]', mode: 'html',
    });
    expect(res.value?.rows[0].rec?.html).toContain('<a');
  });

  it('reports a body error instead of throwing across the boundary', async () => {
    const res = await runInTab({});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('source.url is missing');
  });
});

/** A tab port over a fixed tab list; `run` answers what the body returned in each tab. */
function fakeClient(
  tabs: ExtTab[],
  run: (tabId: number) => unknown,
  opts: { fail?: (tabId: number) => string | undefined } = {},
): TabClient & { runs: number[] } {
  const runs: number[] = [];
  return {
    runs,
    env: async () => ({ extension: true, userScripts: true }),
    tabs: async () => tabs,
    execute: async (tabId) => {
      runs.push(tabId);
      const failure = opts.fail?.(tabId);
      if (failure !== undefined) throw new Error(failure);
      return [{ result: { ok: true, value: run(tabId) } }];
    },
  };
}

/** The `run_src` context one Gemini entry is read with. */
function ctxOf(source: Record<string, unknown>): RecrScriptContext {
  return {
    db: undefined,
    ref: 'extdom/ge',
    args: { source: { url: 'https://gemini.google.com/*', item: 'a[href*="/app/"]', ...source } },
    console,
  };
}

/** What a merged multi-tab read returns. */
interface MergedRows {
  rows: Array<{ txt: string; ref: string }>;
  notes: string[];
}

describe('multiple login tabs', () => {
  const geminiTabs: ExtTab[] = [
    { id: 1, url: 'https://gemini.google.com/u/2/app?pli=1' },
    { id: 2, url: 'https://gemini.google.com/u/3/app?pli=1' },
    { id: 3, url: 'https://gemini.google.com/u/4/app?pli=1' },
  ];

  it('reads the first matching tab when the entry names no Tabs', async () => {
    const client = fakeClient(geminiTabs, (id) => ({
      rows: [{ txt: `chat ${id}`, ref: `/u/${id}/app/x` }], notes: [],
    }));

    const out = await runTabRow(EXTSRC_EXTRACT_BODY, ctxOf({}), client) as MergedRows;

    expect(client.runs).toEqual([1]);
    expect(out.rows.map((row) => row.ref)).toEqual(['/u/1/app/x']);
  });

  it('reads every matching tab with Tabs: all and merges by ref', async () => {
    const client = fakeClient(geminiTabs, (id) => ({
      rows: [{ txt: `chat ${id}`, ref: `/u/${id}/app/x` }, { txt: 'New chat', ref: '/app' }],
      notes: [],
    }));

    const out = await runTabRow(EXTSRC_EXTRACT_BODY, ctxOf({ tabs: 'all' }), client) as MergedRows;

    expect(client.runs).toEqual([1, 2, 3]);
    expect(out.rows.map((row) => row.ref))
      .toEqual(['/u/1/app/x', '/app', '/u/2/app/x', '/u/3/app/x']);
  });

  it('keeps the tabs that answered when another needs its sidebar', async () => {
    const client = fakeClient(geminiTabs, (id) => (id === 2
      ? { rows: [], notes: [], needsUser: 'open the chat sidebar' }
      : { rows: [{ txt: `chat ${id}`, ref: `/u/${id}/app/x` }], notes: [] }));

    const out = await runTabRow(EXTSRC_EXTRACT_BODY, ctxOf({ tabs: 'all' }), client) as MergedRows;

    expect(out.rows.map((row) => row.ref)).toEqual(['/u/1/app/x', '/u/3/app/x']);
    expect(out.notes).toContain('u/3: open the chat sidebar');
  });

  it('labels the notes a tab reported', async () => {
    const client = fakeClient(geminiTabs, (id) => ({
      rows: [{ txt: `chat ${id}`, ref: `/u/${id}/app/x` }],
      notes: [`no element matched a[href*="/app/"]`],
    }));

    const out = await runTabRow(EXTSRC_EXTRACT_BODY, ctxOf({ tabs: 'all' }), client) as MergedRows;

    expect(out.notes).toContain('u/2: no element matched a[href*="/app/"]');
  });

  it('keeps the tabs that ran when another tab cannot run the row', async () => {
    const client = fakeClient(
      geminiTabs,
      (id) => ({ rows: [{ txt: `chat ${id}`, ref: `/u/${id}/app/x` }], notes: [] }),
      { fail: (id) => (id === 2 ? 'No tab with id 2' : undefined) },
    );

    const out = await runTabRow(EXTSRC_EXTRACT_BODY, ctxOf({ tabs: 'all' }), client) as MergedRows;

    expect(out.rows.map((row) => row.ref)).toEqual(['/u/1/app/x', '/u/3/app/x']);
    expect(out.notes.join('\n')).toContain('u/3: extdom/ge could not run in tab 2');
  });

  it('asks for the manual step only when no tab produced a row', async () => {
    const client = fakeClient(geminiTabs, () => ({
      rows: [], notes: [], needsUser: 'open the chat sidebar',
    }));

    await expect(runTabRow(EXTSRC_EXTRACT_BODY, ctxOf({ tabs: 'all' }), client))
      .rejects.toThrow('open the chat sidebar');
  });

  it('names the pattern when no tab matches', async () => {
    const client = fakeClient([], () => ({}));

    await expect(runTabRow(EXTSRC_EXTRACT_BODY, ctxOf({ tabs: 'all' }), client))
      .rejects.toThrow('no open tab matches https://gemini.google.com/*');
  });
});
