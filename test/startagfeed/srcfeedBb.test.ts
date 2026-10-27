// @vitest-environment happy-dom
/**
 * srcfeedBb.test.ts — the seeded Bilibili rows behind a real `*.feed.md` read.
 *
 * The network is stubbed at `fetch`; the registry and the row are the texts
 * `seedSrcFeedRows` writes. The compiled-twin case proves the extension page's path
 * returns the same items without evaluating the row text.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBbApiGlobal, setBbFetch } from '../../src/bb';
import { db, type Da } from '../../src/sdb';
import { registerBodyTwins, setEvalProbe } from '../../src/runsrc';
import { parseWFeedDoc, runSrcFeed, SRCFEED_REF } from '../../src/srcfeed';
import {
  BB_FEED_BODY, BB_FEED_REF, BB_HIST_BODY, BB_HIST_REF, BB_LIST_BODY, BB_LIST_REF,
  BB_SUBS_BODY, BB_SUBS_REF, SRCFEED_BODY_TWINS,
} from '../../src/srcfeedRows';
import { sdbSrcFeedStore } from '../../src/srcfeedStore';

/** The registry entry and row under test. */
const HISTORY_REG = `# srcfeed

## Sources

### bb-hist
* URL: https://www.bilibili.com/history
* Src: bb-hist
* Max: 3
* Tags:
  - bilibili
  - history
`;

/** A feed that names the entry and nothing else. */
const FEED = `# probe.feed

## Setup
freq: 2hr
next:
sources: bb-hist
`;

/** A list entry whose URL is the list the user chose. */
const LIST_REG = `# srcfeed

## Sources

### bb-list
* URL: https://space.bilibili.com/1/favlist?fid=10&ftype=create
* Src: bb-list
* Max: 2
* Tags:
  - bilibili
  - list
`;

/** A feed that names the list entry. */
const LIST_FEED = `# probe.feed

## Setup
freq: 2hr
next:
sources: bb-list
`;

/** A subscribed-lists entry; it needs no URL. */
const SUBS_REG = `# srcfeed

## Sources

### bb-subs
* URL: https://space.bilibili.com/
* Src: bb-subs
* Max: 1
* Tags:
  - bilibili
  - list
  - subscribed
`;

/** A feed that names the subscribed-lists entry. */
const SUBS_FEED = `# probe.feed

## Setup
freq: 2hr
next:
sources: bb-subs
`;

/** A space feed whose URL names the spaces' subscriptions. */
const FEED_REG = `# srcfeed

## Sources

### bb-feed
* URL: https://space.bilibili.com/
* Src: bb-feed
* Max: 2
* Tags:
  - bilibili
  - feed
`;

/** A feed that names the space feed. */
const FEED_FEED = `# probe.feed

## Setup
freq: 2hr
next:
sources: bb-feed
URL: https://space.bilibili.com/486979785
`;

/** One history item. */
const historyItem = (index: number) => ({
  title: `t${index}`,
  long_title: '',
  author_name: 'up',
  view_at: 1_700_000_000 + index,
  duration: 65,
  progress: 0,
  cover: '',
  history: { oid: String(index), bvid: `BV${index}`, business: 'archive' },
});

/** A list item. */
const videoItem = (index: number) => ({
  id: String(10 + index),
  bvid: `BV1${index}`,
  title: `v${index}`,
  upper: { name: 'up1' },
  duration: 125,
  pubtime: 1_700_000_000 + index,
  cover: '',
});

/** One row in the store. */
const seed = (ref: string, type: string, txt: string): Promise<unknown> =>
  db.das.put({ ref, type, txt, tags: ['srcfeed'], rec: {} } as Da);

/** One read at a fixed stamp. */
const run = (ref = 'probe.feed.md') =>
  runSrcFeed({
    ref,
    now: new Date('2026-10-16T07:00:00Z'),
    store: sdbSrcFeedStore(),
    push: async () => undefined,
  });

/** The block a feed document carries. */
const block = async (ref = 'probe.feed.md') => {
  const row = await db.das.where('[ref+type]').equals([ref, 'md']).first();
  return parseWFeedDoc(row?.txt ?? '').posts[0]?.items ?? [];
};

beforeEach(async () => {
  await db.das.clear();
  /* The seeded rows read cookies; model the extension page that owns them. */
  vi.stubGlobal('location', { protocol: 'chrome-extension:' });
  vi.stubGlobal('chrome', { runtime: { id: 'test' } });
  installBbApiGlobal();
});

afterEach(() => {
  setBbFetch(undefined);
  vi.unstubAllGlobals();
  setEvalProbe(null);
  delete (globalThis as { bbapi?: unknown }).bbapi;
});

describe('seeded bb-hist', () => {
  it('runs the row body through the global engine and writes the capped items', async () => {
    await seed(SRCFEED_REF, 'md', HISTORY_REG);
    await seed(BB_HIST_REF, 'src', BB_HIST_BODY);
    await seed('probe.feed.md', 'md', FEED);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { list: [4, 3, 2, 1, 0].map(historyItem) } }),
    })));

    const report = await run();

    expect(report.answered).toEqual(['bb-hist']);
    expect(report.items).toHaveLength(3);
    expect(report.items[0]).toEqual({
      feed: 'bb-hist',
      text: 't4 — up · 1:05',
      ref: 'https://www.bilibili.com/video/BV4',
    });
    expect(await block()).toEqual([
      '- **bb-hist** t4 — up · 1:05 — https://www.bilibili.com/video/BV4',
      '- **bb-hist** t3 — up · 1:05 — https://www.bilibili.com/video/BV3',
      '- **bb-hist** t2 — up · 1:05 — https://www.bilibili.com/video/BV2',
    ]);
  });

  it('uses the compiled twin when the page cannot eval', async () => {
    await seed(SRCFEED_REF, 'md', HISTORY_REG);
    await seed(BB_HIST_REF, 'src', BB_HIST_BODY);
    await seed('probe.feed.md', 'md', FEED);
    registerBodyTwins(SRCFEED_BODY_TWINS);
    setEvalProbe(false);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { list: [2, 1, 0].map(historyItem) } }),
    })));

    const report = await run();

    expect(report.pathNote).toContain('compiled body');
    expect(report.items).toHaveLength(3);
    expect(report.items[0].ref).toBe('https://www.bilibili.com/video/BV2');
  });

  it('lets the feed header cap the read below the entry Max', async () => {
    await seed(SRCFEED_REF, 'md', HISTORY_REG);
    await seed(BB_HIST_REF, 'src', BB_HIST_BODY);
    await seed('probe.feed.md', 'md', FEED.replace('sources:', 'max: 2\nsources:'));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { list: [4, 3, 2, 1, 0].map(historyItem) } }),
    })));

    const report = await run();

    expect(report.items).toHaveLength(2);
    expect(report.items.map((item) => item.ref)).toEqual([
      'https://www.bilibili.com/video/BV4',
      'https://www.bilibili.com/video/BV3',
    ]);
  });

  it('uses the installed webapp transport outside the extension page', async () => {
    await seed(SRCFEED_REF, 'md', HISTORY_REG);
    await seed(BB_HIST_REF, 'src', BB_HIST_BODY);
    await seed('probe.feed.md', 'md', FEED);
    vi.stubGlobal('location', { protocol: 'https:' });
    setBbFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { list: [2, 1, 0].map(historyItem) } }),
    }));

    const report = await run();

    expect(report.answered).toEqual(['bb-hist']);
    expect(report.items).toHaveLength(3);
    expect(report.items[0].ref).toBe('https://www.bilibili.com/video/BV2');
  });
});

describe('seeded bb-subs', () => {
  it('reads a subscribed list through the seeded body', async () => {
    await seed(SRCFEED_REF, 'md', SUBS_REG);
    await seed(BB_SUBS_REF, 'src', BB_SUBS_BODY);
    await seed('probe.feed.md', 'md', SUBS_FEED);
    vi.stubGlobal('fetch', vi.fn(async (raw: string) => {
      const path = new URL(raw).pathname;
      if (path === '/x/web-interface/nav') {
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { isLogin: true, mid: 1 } }) };
      }
      if (path === '/x/v3/fav/folder/collected/list') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            data: { list: [{ id: 20, mid: 2, title: 'fav', media_count: 1, type: 11 }], has_more: false },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { medias: [videoItem(0)], has_more: false } }),
      };
    }));

    const report = await run();

    expect(report.answered).toEqual(['bb-subs']);
    expect(report.items).toEqual([
      { feed: 'bb-subs', text: 'v0 — up1 · 2:05', ref: 'https://www.bilibili.com/video/BV10' },
    ]);
  });
});

describe('seeded bb-feed', () => {
  it('maps a space URL to the latest video of each subscription', async () => {
    await seed(SRCFEED_REF, 'md', FEED_REG);
    await seed(BB_FEED_REF, 'src', BB_FEED_BODY);
    await seed('probe.feed.md', 'md', FEED_FEED);
    vi.stubGlobal('fetch', vi.fn(async (raw: string) => {
      const url = new URL(raw);
      if (url.pathname === '/x/v3/fav/folder/collected/list') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            data: {
              list: [
                { id: 5292482, title: 'AAAAA博物馆攻略', type: 21 },
                { id: 4704451, title: 'NVIDIA显卡合集', type: 21 },
              ],
              has_more: false,
            },
          }),
        };
      }
      const season = url.searchParams.get('season_id');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            medias: [season === '5292482'
              ? { ...videoItem(0), bvid: 'BV1bgLEzpE6N', title: 'museum' }
              : { ...videoItem(1), bvid: 'BV164sGzSEUy', title: 'gpu' }],
          },
        }),
      };
    }));

    const report = await run();

    expect(report.answered).toEqual(['bb-feed']);
    expect(report.items.map((item) => item.ref)).toEqual([
      'https://www.bilibili.com/video/BV164sGzSEUy',
      'https://www.bilibili.com/video/BV1bgLEzpE6N',
    ]);
    const stored = await db.das.where('[ref+type]').equals(['probe.feed.md', 'md']).first();
    expect(stored?.txt).toContain('URL: https://space.bilibili.com/486979785');
  });
});

describe('seeded bb-list', () => {
  it('reads the list URL the entry declares', async () => {
    await seed(SRCFEED_REF, 'md', LIST_REG);
    await seed(BB_LIST_REF, 'src', BB_LIST_BODY);
    await seed('probe.feed.md', 'md', LIST_FEED);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        data: { medias: [videoItem(0), videoItem(1)], has_more: true },
      }),
    })));

    const report = await run();

    expect(report.items).toHaveLength(2);
    expect(report.items[0]).toEqual({
      feed: 'bb-list',
      text: 'v0 — up1 · 2:05',
      ref: 'https://www.bilibili.com/video/BV10',
    });
  });
});
