// @vitest-environment happy-dom
/**
 * wFeedRun.test.ts — one `w.feed.md` read end to end: the sources `webfeed.md`
 * declares in, a `## Posts as of …` block and a moved `next:` out.
 *
 * The network is stubbed at `fetch`, the push is stubbed with a spy, and the store is
 * fake-indexeddb, so what the assertions cover is this module's own work: which rows it
 * reads, what it writes, and what it leaves alone when a source answers with nothing.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/sdb';
import { installWebfeedGlobal } from '../../src/webfeed';
import { WEBFEED_EXTRACT_BODY, WEBFEED_EXTRACT_REF } from '../../src/webfeedRows';
import { W_FEED_REF, parseWFeedDoc } from '../../src/wFeed';
import { runWFeedRefresh } from '../../src/ui/wFeedRun';
import type { Da } from '../../src/sdb';

/** A config with one block, read by the `direct` strategy so no API or session is needed. */
const CONFIG = `# Feeds

## Sources

### wallstreetcn
* URL: https://demo.test/page
* Type: url
* Tags:
  - finance
`;

/** Three links, which is what `markdownFeedItems` reads as the feed itself. */
const PAGE = `- [the first item of the feed](https://demo.test/1)
- [the second item of the feed](https://demo.test/2)
- [the third item of the feed](https://demo.test/3)
`;

const noPush = vi.fn(async () => undefined);

/** One row in the store, the way a seeded document arrives. */
const seed = (ref: string, type: string, txt: string): Promise<unknown> =>
  db.das.put({ ref, type, txt, tags: ['webfeed'], rec: {} } as Da);

/** A fetch that answers every URL with one status and body. */
const stubFetch = (status: number, body: string) => vi.stubGlobal('fetch', vi.fn(async () => ({
  ok: status < 400, status, text: async () => body,
})));

const held = async (ref: string): Promise<Da | undefined> =>
  (await db.das.where('[ref+type]').equals([ref, 'md']).toArray())[0];

beforeEach(async () => {
  await db.das.clear();
  noPush.mockClear();
  installWebfeedGlobal();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).webfeed;
});

describe('runWFeedRefresh', () => {
  it('reads the declared sources and stores the items in a new w.feed.md', async () => {
    await seed('webfeed.md', 'md', CONFIG);
    await seed(WEBFEED_EXTRACT_REF, 'src', WEBFEED_EXTRACT_BODY);
    stubFetch(200, PAGE);
    const now = new Date('2026-10-16T07:00:00Z');

    const report = await runWFeedRefresh({ now, push: noPush });

    expect(report.error).toBeUndefined();
    expect(report.items.map((i) => i.feed)).toEqual(['wallstreetcn', 'wallstreetcn', 'wallstreetcn']);
    expect(report.sources).toEqual(['wallstreetcn']);
    expect(noPush).toHaveBeenCalledTimes(1);

    const row = await held(W_FEED_REF);
    expect(row?.type).toBe('md');
    const doc = parseWFeedDoc(row?.txt ?? '');
    expect(doc.setup.freqText).toBe('2hr');
    expect(doc.setup.nextText).toBe('2026-10-16T09:00:00.000Z');
    expect(doc.posts[0].asOf?.toISOString()).toBe(now.toISOString());
    expect(doc.posts[0].items[0])
      .toBe('- **wallstreetcn** the first item of the feed — https://demo.test/1');
  });

  it('keeps the earlier blocks and moves only next on a second read', async () => {
    await seed('webfeed.md', 'md', CONFIG);
    await seed(WEBFEED_EXTRACT_REF, 'src', WEBFEED_EXTRACT_BODY);
    stubFetch(200, PAGE);
    await runWFeedRefresh({ now: new Date('2026-10-16T07:00:00Z'), push: noPush });

    stubFetch(200, `- [a later item of the feed](https://demo.test/9)\n`);
    const report = await runWFeedRefresh({ now: new Date('2026-10-16T11:00:00Z'), push: noPush });

    expect(report.items).toHaveLength(1);
    const doc = parseWFeedDoc((await held(W_FEED_REF))?.txt ?? '');
    expect(doc.posts).toHaveLength(2);
    expect(doc.posts[0].asOf?.toISOString()).toBe('2026-10-16T11:00:00.000Z');
    expect(doc.posts[1].asOf?.toISOString()).toBe('2026-10-16T07:00:00.000Z');
    expect(doc.setup.nextText).toBe('2026-10-16T13:00:00.000Z');
  });

  it('reads the document itself when the script row is gone', async () => {
    await seed('webfeed.md', 'md', CONFIG);
    stubFetch(200, PAGE);

    const report = await runWFeedRefresh({ now: new Date('2026-10-16T07:00:00Z'), push: noPush });

    expect(report.error).toBeUndefined();
    expect(report.items).toHaveLength(3);
    expect(await held(W_FEED_REF)).toBeDefined();
  });

  it('creates the ref it was pointed at, from that refs template', async () => {
    await seed('webfeed.md', 'md', CONFIG);
    stubFetch(200, PAGE);
    const now = new Date('2026-10-16T07:00:00Z');

    await runWFeedRefresh({ ref: 'my.feed.md', now, push: noPush });

    expect(await held(W_FEED_REF)).toBeUndefined();
    const row = await held('my.feed.md');
    expect(row?.txt.startsWith('# my.feed\n')).toBe(true);
    const doc = parseWFeedDoc(row?.txt ?? '');
    expect(doc.setup.freqText).toBe('2hr');
    expect(doc.setup.nextText).toBe('2026-10-16T09:00:00.000Z');
    expect(doc.posts[0].items).toHaveLength(3);
  });

  it('writes nothing when no source answers with an item', async () => {
    await seed('webfeed.md', 'md', CONFIG);
    stubFetch(403, 'no');

    const report = await runWFeedRefresh({ now: new Date('2026-10-16T07:00:00Z'), push: noPush });

    expect(report.error).toBeUndefined();
    expect(report.items).toEqual([]);
    expect(await held(W_FEED_REF)).toBeUndefined();
    expect(noPush).not.toHaveBeenCalled();
  });

  it('reports the failure and writes nothing when there is no webfeed.md', async () => {
    const report = await runWFeedRefresh({ now: new Date('2026-10-16T07:00:00Z'), push: noPush });

    expect(report.error).toMatch(/webfeed\.md/);
    expect(await held(W_FEED_REF)).toBeUndefined();
  });
});
