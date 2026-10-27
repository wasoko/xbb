// @vitest-environment happy-dom
/**
 * srcfeedRun.test.ts — one feed read end to end: a registry entry in, a
 * `## Posts as of …` block and a moved `next:` out.
 *
 * The network is stubbed at `fetch`, the push is a spy, and the store is
 * fake-indexeddb, so what the assertions cover is the engine's own work: which entry
 * ran on which path, what it wrote, and what it leaves alone when a source refuses.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type Da } from '../../src/sdb';
import { registerBodyTwin, registerTabBodyRunner, setEvalProbe } from '../../src/runsrc';
import {
  installSrcFeedGlobal, parseSrcFeedDoc, parseWFeedDoc, readSource, reportLine, runSrcFeed,
  EXTSRC_EXTRACT_REF, SRCFEED_REF, type SrcFeedRunOptions,
} from '../../src/srcfeed';
import { EXTDOM_DSC_REF, EXTDOM_GR_REF, SRCDOM_SINA_REF, SRCFEED_DOC } from '../../src/srcfeedRows';
import { readOrSeedSrcFeed, sdbSrcFeedStore } from '../../src/srcfeedStore';

/** One web entry, read by the `direct` strategy so no API or session is needed. */
const WEB = `# srcfeed

## Sources

### wallstreetcn
* URL: https://demo.test/page
* Type: url
* Tags:
  - finance
`;

/** The registry with one adapter entry, appended to {@link WEB}. */
const withSrc = (src: string, extra = ''): string => `${WEB}
### demo
* URL: https://demo.test/page
* Src: ${src}
${extra}`;

/** Three links, which is what `markdownFeedItems` reads as the feed itself. */
const PAGE = `- [the first item of the feed](https://demo.test/1)
- [the second item of the feed](https://demo.test/2)
- [the third item of the feed](https://demo.test/3)
`;

/** A feed document naming `names`, with the seeded schedule. */
const feedDoc = (names: string): string => `# probe.feed

## Setup
freq: 2hr
next:
sources: ${names}

## Notes
`;

const noPush = vi.fn(async () => undefined);

/** One row in the store, the way a seeded document arrives. */
const seed = (ref: string, type: string, txt: string): Promise<unknown> =>
  db.das.put({ ref, type, txt, tags: ['srcfeed'], rec: {} } as Da);

/** Replace one stored `src` row's text, the way a hand edit would. */
const editSrc = async (ref: string, txt: string): Promise<void> => {
  const [row] = await db.das.where('[ref+type]').equals([ref, 'src']).toArray();
  await db.das.update(row.tid!, { txt });
};

/** A fetch that answers every URL with one status and body. */
const stubFetch = (status: number, body: string) => vi.stubGlobal('fetch', vi.fn(async () => ({
  ok: status < 400, status, text: async () => body,
})));

const held = async (ref: string): Promise<Da | undefined> =>
  (await db.das.where('[ref+type]').equals([ref, 'md']).toArray())[0];

/** One read at a fixed stamp through the page store, with the push stubbed. */
const run = (opts: Partial<SrcFeedRunOptions> = {}) =>
  runSrcFeed({
    now: new Date('2026-10-16T07:00:00Z'),
    store: sdbSrcFeedStore(),
    push: noPush,
    ...opts,
  });

beforeEach(async () => {
  await db.das.clear();
  noPush.mockClear();
  installSrcFeedGlobal();
});

afterEach(() => {
  vi.unstubAllGlobals();
  registerTabBodyRunner(null);
  setEvalProbe(null);
  delete (globalThis as Record<string, unknown>).srcfeed;
});

describe('runSrcFeed', () => {
  it('reads the named entries and stores the items in a new feed document', async () => {
    await seed('srcfeed.md', 'md', WEB);
    stubFetch(200, PAGE);

    const report = await run();

    expect(report.error).toBeUndefined();
    expect(report.items.map((i) => i.feed)).toEqual(['wallstreetcn', 'wallstreetcn', 'wallstreetcn']);
    expect(report.sources).toEqual(['wallstreetcn']);
    expect(noPush).toHaveBeenCalledTimes(1);

    const row = await held('w.feed.md');
    expect(row?.type).toBe('md');
    const doc = parseWFeedDoc(row?.txt ?? '');
    expect(doc.setup.freqText).toBe('2hr');
    expect(doc.setup.nextText).toBe('2026-10-16T09:00:00.000Z');
    expect(doc.posts[0].asOf?.toISOString()).toBe('2026-10-16T07:00:00.000Z');
    expect(doc.posts[0].items[0])
      .toBe('- **wallstreetcn** the first item of the feed — https://demo.test/1');
  });

  it('runs a Src entry as its own row body', async () => {
    await seed('srcfeed.md', 'md', withSrc('srcdom/demo'));
    await seed('srcdom/demo', 'src',
      "return { rows: [{ txt: 'a post', ref: 'https://demo.test/1' }], notes: [] };");
    await seed('probe.feed.md', 'md', feedDoc('demo'));

    const report = await run({ ref: 'probe.feed.md' });

    expect(report.error).toBeUndefined();
    expect(report.items).toEqual([
      { feed: 'demo', text: 'a post', ref: 'https://demo.test/1' },
    ]);
    const doc = parseWFeedDoc((await held('probe.feed.md'))?.txt ?? '');
    expect(doc.posts[0].items).toEqual(['- **demo** a post — https://demo.test/1']);
  });

  it('does not cap a Src row at 200 rows when the entry declares no Max', async () => {
    await seed('srcfeed.md', 'md', withSrc('extdom/chat'));
    await seed('extdom/chat', 'src', '// @requires tab\nreturn { rows: [] };');
    await seed('probe.feed.md', 'md', feedDoc('demo'));
    const many = Array.from({ length: 250 }, (_, i) => ({
      txt: `chat ${i}`, ref: `https://demo.test/${i}`,
    }));
    const blocks: Array<{ max?: number }> = [];
    registerTabBodyRunner(vi.fn(async (_body: string, ctx: { args?: unknown }) => {
      blocks.push((ctx.args as { source?: { max?: number } }).source ?? {});
      return { rows: many, notes: [] };
    }));

    const report = await run({ ref: 'probe.feed.md' });

    expect(blocks[0]?.max).toBe(0);
    expect(report.items).toHaveLength(250);
  });

  it('runs a tab entry through the registered runner with its registry block', async () => {
    await seed('srcfeed.md', 'md', withSrc('extdom/chat', '* Item: a\n* Prompt: open the sidebar\n'));
    await seed('extdom/chat', 'src', '// @requires tab\nreturn { rows: [] };');
    await seed('probe.feed.md', 'md', feedDoc('demo'));
    const runner = vi.fn(async (_body: string, ctx: { args?: unknown }) => {
      const source = (ctx.args as { source?: { item?: string } }).source;
      return { rows: [{ txt: `item ${source?.item}`, ref: 'https://demo.test/1' }] };
    });
    registerTabBodyRunner(runner);

    const report = await run({ ref: 'probe.feed.md' });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(report.items[0].text).toBe('item a');
    expect(report.pathNote).toBe('ran in a browser tab');
  });

  it('keeps every tab\'s new chats when a Tabs: all merge changes order between reads', async () => {
    await seed('srcfeed.md', 'md', withSrc('extdom/chat', '* Tabs: all\n'));
    await seed('extdom/chat', 'src', '// @requires tab\nreturn { rows: [] };');
    await seed('probe.feed.md', 'md', feedDoc('demo'));
    /* Tab A first, then tab B: the block's last line, b1, is the next read's anchor. */
    const first = [
      { txt: 'a1', ref: 'https://demo.test/a1' },
      { txt: 'b1', ref: 'https://demo.test/b1' },
    ];
    /* Tab B is now first, and tab A holds a chat the first read did not see. */
    const second = [
      { txt: 'b1', ref: 'https://demo.test/b1' },
      { txt: 'a0', ref: 'https://demo.test/a0' },
      { txt: 'a1', ref: 'https://demo.test/a1' },
    ];
    const runner = vi.fn(async () => ({ rows: first, notes: [] }));
    registerTabBodyRunner(runner);
    await run({ ref: 'probe.feed.md' });

    runner.mockResolvedValue({ rows: second, notes: [] });
    const report = await run({ ref: 'probe.feed.md', now: new Date('2026-10-16T11:00:00Z') });

    expect(report.items.map((item) => item.ref)).toEqual(['https://demo.test/a0']);
  });

  it('runs the compiled twin when this page cannot eval row text', async () => {
    const body = "return { rows: [{ txt: 'from twin', ref: 'https://demo.test/t' }] };";
    await seed('srcfeed.md', 'md', withSrc('srcdom/twin'));
    await seed('srcdom/twin', 'src', body);
    await seed('probe.feed.md', 'md', feedDoc('demo'));
    registerBodyTwin(body, async () => ({ rows: [{ txt: 'from twin', ref: 'https://demo.test/t' }] }));
    setEvalProbe(false);

    const report = await run({ ref: 'probe.feed.md' });

    expect(report.items[0].text).toBe('from twin');
    expect(report.pathNote).toContain('compiled body');
  });

  it('keeps only the items newer than the previous read\'s newest post', async () => {
    await seed('srcfeed.md', 'md', WEB);
    stubFetch(200, PAGE);
    await run();

    stubFetch(200, `- [a later item of the feed](https://demo.test/9)\n${PAGE}`);
    const report = await run({ now: new Date('2026-10-16T11:00:00Z') });

    expect(report.items.map((i) => i.ref)).toEqual(['https://demo.test/9']);
    const doc = parseWFeedDoc((await held('w.feed.md'))?.txt ?? '');
    expect(doc.posts[0].items).toEqual([
      '- **wallstreetcn** a later item of the feed — https://demo.test/9',
    ]);
  });

  it('follows an API cursor and writes a post the page edge and anchor hid', async () => {
    await seed('srcfeed.md', 'md', `## Sources

### demo
* URL: https://demo.test/page
* API:
  - feed: https://demo.test/api?limit=33
* Tags:
  - finance
`);
    await seed('probe.feed.md', 'md', `# probe.feed

## Setup
freq: 2hr
next:
sources: demo

## Posts as of 2026-10-16T01:00:00Z

- **demo** the stored post — https://demo.test/old
`);
    const item = (id: number, title: string, uri: string, sec: number): Record<string, unknown> =>
      ({ id, title, uri, display_time: sec });
    const page = (items: unknown[], cursor = ''): string =>
      JSON.stringify({ code: 20000, data: { items, next_cursor: cursor } });
    const first = page([item(3, 'the newest post', 'https://demo.test/3', 1792630000)], 'c1');
    const second = page([
      item(2, 'the post a page edge hid', 'https://demo.test/2', 1792620000),
      item(1, 'the stored post', 'https://demo.test/old', 1792610000),
      item(0, 'the post below the anchor', 'https://demo.test/0', 1792600000),
    ]);
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => (url.includes('cursor=') ? second : first) };
    }));

    const report = await run({ ref: 'probe.feed.md', now: new Date('2026-10-16T03:00:00Z') });

    expect(report.items.map((i) => i.ref)).toEqual([
      'https://demo.test/3',
      'https://demo.test/2',
      'https://demo.test/0',
    ]);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('cursor=c1');
  });

  it('trims each source at its own last stored post, not at the block\'s newest line', async () => {
    await seed('srcfeed.md', 'md', withSrc('srcdom/demo'));
    await seed('srcdom/demo', 'src',
      "return { rows: [{ txt: '[转发 2 · 评论 0 · 赞 2] demo post', ref: 'https://demo.test/s1' }], notes: [] };");
    await seed('probe.feed.md', 'md', feedDoc('wallstreetcn demo'));
    stubFetch(200, PAGE);
    await run({ ref: 'probe.feed.md' });

    await editSrc('srcdom/demo',
      "return { rows: [{ txt: '[转发 7 · 评论 0 · 赞 5] demo post', ref: 'https://demo.test/s1' }], notes: [] };");
    stubFetch(200, `- [a later item of the feed](https://demo.test/9)\n${PAGE}`);
    const report = await run({ ref: 'probe.feed.md', now: new Date('2026-10-16T11:00:00Z') });

    expect(report.items.map((i) => i.ref)).toEqual(['https://demo.test/9']);
  });

  it('keeps reading under a pinned head that stays at the top of the list', async () => {
    await seed('srcfeed.md', 'md', withSrc('srcdom/demo'));
    await seed('probe.feed.md', 'md', feedDoc('demo'));

    /** Two pinned chats that never move, then the history newest first. */
    const list = (...chats: string[]): string => ['return { rows: [',
      "    { txt: 'Pinned chat one', ref: 'https://demo.test/p1' },",
      "    { txt: 'Pinned chat two', ref: 'https://demo.test/p2' },",
      ...chats.map((chat) => `    { txt: '${chat}', ref: 'https://demo.test/${chat}' },`),
      '  ], notes: [] };',
    ].join('\n');

    await seed('srcdom/demo', 'src', list('chat1'));
    const first = await run({ ref: 'probe.feed.md' });
    expect(first.items.map((i) => i.ref)).toEqual([
      'https://demo.test/p1', 'https://demo.test/p2', 'https://demo.test/chat1',
    ]);

    await editSrc('srcdom/demo', list('chat2', 'chat1'));
    const second = await run({ ref: 'probe.feed.md', now: new Date('2026-10-16T09:00:00Z') });
    expect(second.items.map((i) => i.ref)).toEqual(['https://demo.test/chat2']);

    await editSrc('srcdom/demo', list('chat3', 'chat2', 'chat1'));
    const third = await run({ ref: 'probe.feed.md', now: new Date('2026-10-16T11:00:00Z') });
    expect(third.items.map((i) => i.ref)).toEqual(['https://demo.test/chat3']);

    const doc = parseWFeedDoc((await held('probe.feed.md'))?.txt ?? '');
    expect(doc.posts[0].items).toEqual(['- **demo** chat3 — https://demo.test/chat3']);
  });

  it('keeps matching a source that the newest block does not name', async () => {
    await seed('srcfeed.md', 'md', withSrc('srcdom/demo'));
    await seed('srcdom/demo', 'src',
      "return { rows: [{ txt: '[转发 2 · 评论 0 · 赞 2] the older demo post', ref: 'https://demo.test/s1' }], notes: [] };");
    await seed('probe.feed.md', 'md', feedDoc('wallstreetcn demo'));
    stubFetch(200, PAGE);
    await run({ ref: 'probe.feed.md' });

    /* The second read writes only wallstreetcn: demo had nothing new. */
    await editSrc('srcdom/demo',
      "return { rows: [{ txt: '[转发 4 · 评论 0 · 赞 3] the older demo post', ref: 'https://demo.test/s1' }], notes: [] };");
    stubFetch(200, `- [a later item of the feed](https://demo.test/9)\n${PAGE}`);
    const second = await run({ ref: 'probe.feed.md', now: new Date('2026-10-16T11:00:00Z') });
    expect(second.items.map((i) => i.ref)).toEqual(['https://demo.test/9']);

    /* The third read has a new demo post above the boundary stored in the first block. */
    await editSrc('srcdom/demo', 'return { rows: [\n'
      + "    { txt: '[转发 1 · 评论 0 · 赞 1] the newer demo post', ref: 'https://demo.test/s0' },\n"
      + "    { txt: '[转发 4 · 评论 0 · 赞 3] the older demo post', ref: 'https://demo.test/s1' },\n"
      + '  ], notes: [] };');
    stubFetch(200, `- [yet another item](https://demo.test/10)\n- [a later item of the feed](https://demo.test/9)\n${PAGE}`);
    const third = await run({ ref: 'probe.feed.md', now: new Date('2026-10-16T15:00:00Z') });

    expect(third.items.map((i) => i.ref))
      .toEqual(['https://demo.test/10', 'https://demo.test/s0']);
  });

  it('matches an item with no URL after its action counts tick', async () => {
    await seed('srcfeed.md', 'md', withSrc('srcdom/demo'));
    await seed('srcdom/demo', 'src',
      "return { rows: [{ txt: '[转发 2 · 评论 0 · 赞 2] a post with no url', ref: '' }], notes: [] };");
    await seed('probe.feed.md', 'md', feedDoc('demo'));
    await run({ ref: 'probe.feed.md' });

    await editSrc('srcdom/demo',
      "return { rows: [{ txt: '[转发 9 · 评论 1 · 赞 7] a post with no url', ref: '' }], notes: [] };");
    const report = await run({ ref: 'probe.feed.md', now: new Date('2026-10-16T11:00:00Z') });

    expect(report.items).toEqual([]);
  });

  it('moves next without writing a block when every item was already stored', async () => {
    await seed('srcfeed.md', 'md', WEB);
    stubFetch(200, PAGE);
    await run();

    stubFetch(200, PAGE);
    const report = await run({ now: new Date('2026-10-16T11:00:00Z') });

    expect(report.items).toEqual([]);
    const doc = parseWFeedDoc((await held('w.feed.md'))?.txt ?? '');
    expect(doc.posts).toHaveLength(1);
    expect(doc.setup.nextText).toBe('2026-10-16T13:00:00.000Z');
  });

  it('reads sources named with spaces as well as commas', async () => {
    await seed('srcfeed.md', 'md', `${WEB}
### second
* URL: https://demo.test/second
`);
    stubFetch(200, PAGE);
    await seed('probe.feed.md', 'md', feedDoc('wallstreetcn second'));

    const report = await run({ ref: 'probe.feed.md' });

    expect(report.sources).toEqual(['wallstreetcn', 'second']);
    expect(report.items).toHaveLength(6);
  });

  it('reports a name the registry does not hold and still reads the rest', async () => {
    await seed('srcfeed.md', 'md', WEB);
    stubFetch(200, PAGE);
    await seed('probe.feed.md', 'md', feedDoc('gone, wallstreetcn'));

    const report = await run({ ref: 'probe.feed.md' });

    expect(report.items).toHaveLength(3);
    expect(report.notes[0]).toContain('gone: not in srcfeed.md');
  });

  it('reads only entries without a Src row when sources: is empty', async () => {
    await seed('srcfeed.md', 'md', withSrc('srcdom/never'));
    await seed('srcdom/never', 'src', "throw new Error('this row must not run');");
    stubFetch(200, PAGE);

    const report = await run();

    expect(report.items).toHaveLength(3);
    expect(report.notes.join('\n')).not.toContain('this row must not run');
  });

  it('names the empty selection when the registry holds only adapter entries', async () => {
    await seed('srcfeed.md', 'md', `# srcfeed

## Sources

### demo
* URL: https://demo.test/*
* Src: srcdom/demo
`);

    const report = await run();

    expect(report.error).toBeUndefined();
    expect(report.items).toEqual([]);
    expect(report.notes[0]).toContain('no entry to read');
  });

  it('creates the seeded adapter row a registry entry names but the store lacks', async () => {
    await seed('srcfeed.md', 'md', withSrc('srcdom/sinaCNmedia'));
    await seed('probe.feed.md', 'md', feedDoc('demo'));
    stubFetch(200, '<html><body><article><a class="post-link" href="https://demo.test/1"></a><div class="post-text">a post</div></article></body></html>');

    const report = await run({ ref: 'probe.feed.md' });

    expect(report.error).toBeUndefined();
    expect(report.items[0].text).toContain('a post');
    expect(await db.das.where('[ref+type]').equals([SRCDOM_SINA_REF, 'src']).count()).toBe(1);
  });

  it('leaves a tombstoned adapter row deleted', async () => {
    await seed('srcfeed.md', 'md', withSrc('srcdom/sinaCNmedia'));
    await seed('probe.feed.md', 'md', feedDoc('demo'));
    await seed(SRCDOM_SINA_REF, 'src', "return { rows: [] };");
    const [held] = await db.das.where('[ref+type]').equals([SRCDOM_SINA_REF, 'src']).toArray();
    await db.das.update(held.tid!, { tags: ['[del]'] });

    const report = await run({ ref: 'probe.feed.md' });

    expect(report.notes).toContain('demo: no row srcdom/sinaCNmedia');
    expect(await db.das.where('[ref+type]').equals([SRCDOM_SINA_REF, 'src']).count()).toBe(1);
  });

  it('creates the legacy extsrc body an old extsrc.md entry names', async () => {
    await seed('extsrc.md', 'md', '## Sources\n\n### demo\n* URL: https://chat.test/*\n* Item: a\n');
    await seed('probe.feed.md', 'md', feedDoc('demo'));

    const report = await run({ ref: 'probe.feed.md' });

    expect(await db.das.where('[ref+type]').equals([EXTSRC_EXTRACT_REF, 'src']).count()).toBe(1);
    expect(report.notes.join('\n')).toContain('needs the extension');
  });

  it('reports the missing registry and writes nothing', async () => {
    const report = await run();

    expect(report.error).toMatch(/srcfeed\.md/);
    expect(await held('w.feed.md')).toBeUndefined();
  });

  it('adapts webfeed.md when srcfeed.md is missing', async () => {
    await seed('webfeed.md', 'md', WEB.replace('# srcfeed', '# Feeds'));
    stubFetch(200, PAGE);

    const report = await run();

    expect(report.error).toBeUndefined();
    expect(report.items).toHaveLength(3);
  });

  it('names the row that is missing for an entry', async () => {
    await seed('srcfeed.md', 'md', withSrc('srcdom/absent'));
    await seed('probe.feed.md', 'md', feedDoc('demo'));

    const report = await run({ ref: 'probe.feed.md' });

    expect(report.items).toEqual([]);
    expect(report.notes).toContain('demo: no row srcdom/absent');
    expect((await held('probe.feed.md'))?.txt).toBe(feedDoc('demo'));
  });
});

describe('readSource', () => {
  it('returns the body the first strategy answered with', async () => {
    stubFetch(200, PAGE);

    const out = await readSource({ name: 'demo', url: 'https://demo.test/page' });

    expect(out.strategy).toBe('direct');
    expect(out.body).toBe(PAGE);
    expect(out.attempts).toHaveLength(1);
  });
});

describe('seeded registry', () => {
  it('reads every entry, its Src row and its tab selectors', () => {
    const registry = parseSrcFeedDoc(SRCFEED_DOC);

    expect(registry.entries.map((entry) => entry.name))
      .toEqual(['wallstreetcn', 'sina', 'dsc', 'ge', 'gr', 'bb-hist', 'bb-lists', 'bb-list', 'bb-subs', 'bb-feed']);
    expect(registry.entries.find((entry) => entry.name === 'sina')?.src).toBe(SRCDOM_SINA_REF);
    expect(registry.entries.find((entry) => entry.name === 'bb-hist')).toMatchObject({
      src: 'bb-hist', max: 111,
    });
    expect(registry.entries.find((entry) => entry.name === 'bb-lists')).toMatchObject({
      src: 'bb-lists', max: 5555,
    });
    expect(registry.entries.find((entry) => entry.name === 'bb-list')).toMatchObject({
      src: 'bb-list', max: 5555,
    });
    expect(registry.entries.find((entry) => entry.name === 'bb-subs')).toMatchObject({
      src: 'bb-subs', max: 5555,
    });
    expect(registry.entries.find((entry) => entry.name === 'bb-feed')).toMatchObject({
      src: 'bb-feed', max: 5555,
    });
    expect(registry.entries.find((entry) => entry.name === 'dsc')).toMatchObject({
      src: EXTDOM_DSC_REF, sidebar: '', item: 'a[href^="/a/chat"]', tabs: '', max: 0,
    });
    expect(registry.entries.find((entry) => entry.name === 'ge')).toMatchObject({
      src: 'extdom/ge', tabs: 'all', sidebar: '[data-test-id="chat-history-container"]',
      item: 'a[href*="/app/"]', max: 0,
    });
    expect(registry.entries.find((entry) => entry.name === 'gr')).toMatchObject({
      src: EXTDOM_GR_REF, tabs: '', item: 'a[href^="/c/"]', max: 0,
    });
    expect(registry.entries.find((entry) => entry.name === 'wallstreetcn')?.src).toBe('');
    expect(registry.fallback.proxy).toBe('https://r.jina.ai/');
  });

  it('keeps a declared Max and leaves an undeclared one to the row', () => {
    const registry = parseSrcFeedDoc(withSrc('srcdom/demo', '* Max: 7\n'));

    expect(registry.entries.find((entry) => entry.name === 'wallstreetcn')?.max).toBe(0);
    expect(registry.entries.find((entry) => entry.name === 'demo')?.max).toBe(7);
  });
});

describe('readOrSeedSrcFeed', () => {
  it('seeds the registry and its adapters when the ref has no row at all', async () => {
    expect(await db.das.count()).toBe(0);

    const row = await readOrSeedSrcFeed(SRCFEED_REF);

    expect(row?.txt).toBe(SRCFEED_DOC);
    expect(await db.das.where('[ref+type]').equals([SRCDOM_SINA_REF, 'src']).count()).toBe(1);
  });

  it('leaves a tombstoned registry alone', async () => {
    await seed(SRCFEED_REF, 'md', '# gone');
    const [held] = await db.das.where('[ref+type]').equals([SRCFEED_REF, 'md']).toArray();
    await db.das.update(held.tid!, { tags: ['[del]'] });

    expect(await readOrSeedSrcFeed(SRCFEED_REF)).toBeUndefined();
    expect(await db.das.where('[ref+type]').equals([SRCFEED_REF, 'md']).count()).toBe(1);
  });

  it('does not shadow a legacy webfeed.md with the example registry', async () => {
    await seed('webfeed.md', 'md', WEB);

    expect(await readOrSeedSrcFeed(SRCFEED_REF)).toBeUndefined();
    expect(await db.das.where('[ref+type]').equals([SRCDOM_SINA_REF, 'src']).count()).toBe(0);
  });
});

describe('reportLine', () => {
  const at = new Date('2026-10-16T07:00:00Z');
  const now = new Date('2026-10-16T07:05:00Z');
  const item = { feed: 'sina', text: 'a post', ref: 'https://a.test/1' };

  it('carries the per-source notes without calling a successful read failed', () => {
    const line = reportLine({
      at, items: [item], sources: ['sina', 'ge'], answered: ['sina'],
      notes: ['ge: no open tab matches https://gemini.google.com/*'],
    }, now);

    expect(line).toContain('1 new item(s) from sina');
    expect(line).toContain('no open tab');
    expect(line).not.toContain('read failed');
  });

  it('puts a real failure in the heading', () => {
    const line = reportLine({
      at, items: [], sources: ['sina'], answered: [],
      notes: ['sina direct: Failed to fetch'],
    }, now);

    expect(line).toMatch(/^read failed/);
    expect(line).toContain('Failed to fetch');
  });

  it('says no new items when the source answered with only stored posts', () => {
    const line = reportLine({
      at, items: [], sources: ['sina'], answered: ['sina'], notes: [],
    }, now);

    expect(line).toContain('no new item(s)');
  });
});
