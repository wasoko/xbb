// @vitest-environment happy-dom
/**
 * srcfeedAutoAppend.test.ts — adding the Bilibili entries to a registry that was
 * seeded before they existed. The pure append keeps existing blocks, and the store
 * migration writes once and respects a tombstoned script row.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, type Da } from '../../src/sdb';
import { appendSourceEntries, parseSrcFeedDoc, SRCFEED_REF } from '../../src/srcfeed';
import {
  BB_FEED_REF, BB_HIST_BODY, BB_HIST_REF, BB_LIST_LEGACY_BLOCK, BB_LIST_REF, BB_LISTS_REF,
  BB_SOURCE_ENTRIES, BB_SUBS_REF, EXTDOM_GR_REF, GR_EXTRACT_BODY, GR_SOURCE_ENTRIES,
  SRCFEED_DOC,
} from '../../src/srcfeedRows';
import { ensureBbListMax, ensureBbSrcFeedEntries, ensureGrSrcFeedEntry } from '../../src/srcfeedStore';

/** A registry that already has one entry and a fallback section. */
const EXISTING = `# srcfeed

## Sources

### sina
* URL: https://www.sina.cn/media/1

## Fallback

* Retries: 2
`;

/** One row in the store. */
const seed = (ref: string, type: string, txt: string, tags: string[] = ['srcfeed']): Promise<unknown> =>
  db.das.put({ ref, type, txt, tags, rec: {} } as Da);

/** The `srcfeed.md` row as written. */
const registry = async (): Promise<Da | undefined> =>
  db.das.where('[ref+type]').equals([SRCFEED_REF, 'md']).first();

beforeEach(async () => {
  await db.das.clear();
  await db.tree.clear();
});

describe('appendSourceEntries', () => {
  it('parses the five entries from the fresh-install registry', () => {
    const registry = parseSrcFeedDoc(SRCFEED_DOC);
    const names = registry.entries.map((entry) => entry.name);

    expect(names).toContain(BB_HIST_REF);
    expect(names).toContain(BB_LISTS_REF);
    expect(names).toContain(BB_LIST_REF);
    expect(names).toContain(BB_SUBS_REF);
    expect(names).toContain(BB_FEED_REF);
    expect(registry.entries.find((entry) => entry.name === BB_HIST_REF)).toMatchObject({
      src: BB_HIST_REF,
      max: 111,
    });
    expect(registry.entries.find((entry) => entry.name === BB_LIST_REF)).toMatchObject({
      src: BB_LIST_REF,
      max: 5555,
    });
    expect(registry.entries.find((entry) => entry.name === BB_LISTS_REF)).toMatchObject({
      src: BB_LISTS_REF,
      max: 5555,
    });
    expect(registry.entries.find((entry) => entry.name === BB_SUBS_REF)).toMatchObject({
      src: BB_SUBS_REF,
      max: 5555,
    });
    expect(registry.entries.find((entry) => entry.name === BB_FEED_REF)).toMatchObject({
      src: BB_FEED_REF,
      max: 5555,
    });
  });

  it('adds the missing blocks under Sources and before the next section', () => {
    const out = appendSourceEntries(EXISTING, BB_SOURCE_ENTRIES);

    expect(out.added).toEqual([BB_HIST_REF, BB_LISTS_REF, BB_LIST_REF, BB_SUBS_REF, BB_FEED_REF]);
    expect(out.text.indexOf('### sina')).toBeLessThan(out.text.indexOf('### bb-hist'));
    expect(out.text.indexOf('### bb-list')).toBeLessThan(out.text.indexOf('## Fallback'));
    expect(out.text.endsWith('\n')).toBe(true);
  });

  it('is a no-op when every block is present', () => {
    const once = appendSourceEntries(EXISTING, BB_SOURCE_ENTRIES);
    const twice = appendSourceEntries(once.text, BB_SOURCE_ENTRIES);

    expect(twice.added).toEqual([]);
    expect(twice.text).toBe(once.text);
  });

  it('leaves an edited block alone and adds only the others', () => {
    const edited = `# srcfeed

## Sources

### bb-hist
* URL: https://www.bilibili.com/history
* Src: bb-hist
* Max: 5
`;
    const out = appendSourceEntries(edited, BB_SOURCE_ENTRIES);

    expect(out.added).toEqual([BB_LISTS_REF, BB_LIST_REF, BB_SUBS_REF, BB_FEED_REF]);
    expect(out.text).toContain('* Max: 5');
  });

  it('creates a Sources section when the document has none', () => {
    const out = appendSourceEntries('# srcfeed\n', BB_SOURCE_ENTRIES);

    expect(out.added).toHaveLength(5);
    expect(out.text).toContain('## Sources');
    expect(out.text).toContain('### bb-hist');
  });
});

describe('ensureBbSrcFeedEntries', () => {
  it('appends the entries, writes the row bodies, and runs once', async () => {
    await seed(SRCFEED_REF, 'md', EXISTING);

    const first = await ensureBbSrcFeedEntries();
    expect(new Set(first)).toEqual(new Set([BB_HIST_REF, BB_LISTS_REF, BB_LIST_REF, BB_SUBS_REF, BB_FEED_REF]));

    const row = await registry();
    expect(row?.txt).toContain('### bb-hist');
    expect(row?.txt).toContain('### bb-lists');
    expect(row?.txt).toContain('### bb-list');
    expect(row?.txt).toContain('### bb-subs');
    expect(row?.txt).toContain('### bb-feed');
    expect(row?.txt).toContain('### sina');
    const script = await db.das.where('[ref+type]').equals([BB_HIST_REF, 'src']).first();
    expect(script?.txt).toBe(BB_HIST_BODY);

    expect(await ensureBbSrcFeedEntries()).toEqual([]);
  });

  it('does not resurrect a tombstoned script row or add its entry', async () => {
    await seed(SRCFEED_REF, 'md', EXISTING);
    await seed(BB_HIST_REF, 'src', 'old body', ['srcfeed', '[del]']);

    const added = await ensureBbSrcFeedEntries();

    expect(added).not.toContain(BB_HIST_REF);
    expect((await registry())?.txt).not.toContain('### bb-hist');
    expect((await registry())?.txt).toContain('### bb-lists');
    const script = await db.das.where('[ref+type]').equals([BB_HIST_REF, 'src']).first();
    expect(script?.tags).toContain('[del]');
    expect(script?.txt).toBe('old body');
  });

  it('keeps a user-edited block and only adds the missing ones', async () => {
    const edited = `# srcfeed

## Sources

### bb-hist
* URL: https://www.bilibili.com/history
* Src: bb-hist
* Max: 5
`;
    await seed(SRCFEED_REF, 'md', edited);
    await seed(BB_HIST_REF, 'src', BB_HIST_BODY);

    const added = await ensureBbSrcFeedEntries();

    expect(added).not.toContain(BB_HIST_REF);
    expect(added).toContain(BB_LISTS_REF);
    expect((await registry())?.txt).toContain('* Max: 5');
  });
});

describe('ensureBbListMax', () => {
  it('rewrites the exact legacy block once', async () => {
    await seed(SRCFEED_REF, 'md', `# srcfeed\n\n## Sources\n\n${BB_LIST_LEGACY_BLOCK}\n`);

    expect(await ensureBbListMax()).toBe(true);
    expect((await registry())?.txt).toContain('* Max: 5555');
    expect((await registry())?.txt).not.toContain('* Max: 111');
    expect(await ensureBbListMax()).toBe(false);
  });

  it('leaves an edited block alone', async () => {
    const edited = BB_LIST_LEGACY_BLOCK.replace('* Max: 111', '* Max: 7');
    await seed(SRCFEED_REF, 'md', `# srcfeed\n\n## Sources\n\n${edited}\n`);

    expect(await ensureBbListMax()).toBe(false);
    expect((await registry())?.txt).toContain('* Max: 7');
  });
});

describe('ensureGrSrcFeedEntry', () => {
  it('appends the entry, writes the row body, and runs once', async () => {
    await seed(SRCFEED_REF, 'md', EXISTING);

    expect(await ensureGrSrcFeedEntry()).toEqual(['gr']);

    const row = await registry();
    expect(row?.txt).toContain('### gr');
    expect(row?.txt).toContain('### sina');
    const script = await db.das.where('[ref+type]').equals([EXTDOM_GR_REF, 'src']).first();
    expect(script?.txt).toBe(GR_EXTRACT_BODY);

    expect(await ensureGrSrcFeedEntry()).toEqual([]);
  });

  it('does not resurrect a tombstoned row or add its entry', async () => {
    await seed(SRCFEED_REF, 'md', EXISTING);
    await seed(EXTDOM_GR_REF, 'src', 'old body', ['srcfeed', '[del]']);

    expect(await ensureGrSrcFeedEntry()).toEqual([]);
    expect((await registry())?.txt).not.toContain('### gr');
    const script = await db.das.where('[ref+type]').equals([EXTDOM_GR_REF, 'src']).first();
    expect(script?.tags).toContain('[del]');
    expect(script?.txt).toBe('old body');
  });

  it('keeps a registry that already names the entry', async () => {
    await seed(SRCFEED_REF, 'md', appendSourceEntries(EXISTING, GR_SOURCE_ENTRIES).text);

    expect(await ensureGrSrcFeedEntry()).toEqual([]);
    expect((await registry())?.txt).toContain('### gr');
  });
});
