// @vitest-environment happy-dom
/**
 * starTaggerRun.test.ts — the row seed, the mapping write and the one `db.bins` cache.
 *
 * fake-indexeddb supplies the store; qarf runs over a handful of tab/tag rows, so the
 * assertions cover which rows the seed reads, which row it excludes, and what the cache
 * stores and reuses.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type Da } from '../../src/sdb';
import {
  STAR_TAGGER_DOC, STAR_TAGGER_REF, defaultStarSetup, parseStarTaggerDoc, setSetupValue,
} from '../../src/starTagger';
import { loadPinGraph } from '../../src/ui/seaPinGraph';
import {
  STAR_CACHE_VERSION, dasStamp, ensureStarTaggerRow, readStarCache, sameStamp, saveStarSeed,
} from '../../src/ui/starTaggerRun';

const put = (row: Partial<Da> & Pick<Da, 'txt' | 'ref' | 'type'>): Promise<number> =>
  db.das.add({ tags: [], rec: {}, ...row } as Da);

const held = async (ref: string): Promise<Da | undefined> =>
  (await db.das.where('[ref+type]').equals([ref, 'md']).toArray())[0];

beforeEach(async () => {
  await db.das.clear();
  await db.bins.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ensureStarTaggerRow', () => {
  it('seeds a missing row once and never overwrites it', async () => {
    await ensureStarTaggerRow();
    const first = await held(STAR_TAGGER_REF);
    expect(first?.txt).toBe(STAR_TAGGER_DOC);
    expect(await db.das.count()).toBe(1);

    await db.das.update(first!.tid!, { txt: '# mine\n' });
    await ensureStarTaggerRow();
    expect((await held(STAR_TAGGER_REF))?.txt).toBe('# mine\n');
    expect(await db.das.count()).toBe(1);
  });
});

describe('loadPinGraph', () => {
  it('reads only tab/tag rows, keeps pins separately, and never seeds the tagger row', async () => {
    await put({ tid: 1, ref: 'https://a.test/1', type: 'tab', txt: 'react hooks state' });
    await put({ tid: 2, ref: 'https://a.test/2', type: 'tag', txt: 'react compiler' });
    await put({ tid: 3, ref: 'https://a.test/3', type: 'bookmark', txt: 'react' });
    await put({ tid: 4, ref: STAR_TAGGER_REF, type: 'md', txt: STAR_TAGGER_DOC });
    await put({ tid: 5, ref: 'pin/demo.md', type: 'md', txt: '## #react #hooks', tags: ['pin'] });

    const seed = await loadPinGraph({ ...defaultStarSetup(), base: 10 });

    expect(seed.rows.map((r) => r.tid)).toEqual([2, 1]);
    expect(seed.rows.every((r) => r.type === 'tab' || r.type === 'tag')).toBe(true);
    expect(seed.rows.some((r) => r.ref === STAR_TAGGER_REF)).toBe(false);
    expect(seed.pins.map((r) => r.tid)).toEqual([5]);
    expect(seed.priorityTags).toEqual(['react', 'hooks']);
    expect(seed.timings.total).toBeGreaterThanOrEqual(0);
  });

  it('honours base as the row ceiling and folds an alias into the priority tags', async () => {
    await put({ tid: 1, ref: 'https://a.test/1', type: 'tab', txt: 'js javascript' });
    await put({ tid: 2, ref: 'https://a.test/2', type: 'tag', txt: 'js' });
    await put({ tid: 3, ref: 'pin/demo.md', type: 'md', txt: '## #js', tags: ['pin'] });

    const seed = await loadPinGraph({
      ...defaultStarSetup(), base: 1, trace: 555, alias: { js: 'javascript' },
    });

    expect(seed.rows).toHaveLength(1);
    expect(seed.rows[0].tid).toBe(2);
    expect(seed.priorityTags).toEqual(['javascript']);
  });
});

describe('saveStarSeed', () => {
  /** Two evidence rows, one pin card and the seeded tagger row. */
  const seedOnce = async () => {
    await put({ tid: 1, ref: 'https://a.test/1', type: 'tab', txt: 'react hooks state' });
    await put({ tid: 2, ref: 'https://a.test/2', type: 'tag', txt: 'react compiler' });
    await put({ tid: 3, ref: 'pin/demo.md', type: 'md', txt: '## #react', tags: ['pin'] });
    await ensureStarTaggerRow();
    return loadPinGraph({ ...defaultStarSetup(), base: 10 });
  };

  it('caches the table, writes the mapping once and keeps the table out of the row', async () => {
    const seed = await seedOnce();
    const at = new Date('2026-10-17T00:00:00Z');
    const cache = await saveStarSeed(seed, seed.setup, seed.timings, at);

    expect(cache.v).toBe(STAR_CACHE_VERSION);
    expect(cache.taxonomy).toContain('seeded 2026-10-17T00:00:00.000Z');
    expect(cache.taxonomy).toContain('| tag | reach | kind |');
    expect(cache.taxonomy).toContain('### Bursts');
    expect(cache.seed.rows.map((r) => r.tid)).toEqual([2, 1]);

    const stored = await readStarCache();
    expect(stored?.taxonomy).toBe(cache.taxonomy);
    expect(stored?.fingerprint).toBe(cache.fingerprint);
    /* The graph's namer is a function, so the cache reopens it from the recorded maps. */
    expect(stored?.seed.graph.name('react')).toBe('react');
    for (const tag of stored!.seed.graph.weight.keys()) {
      expect(stored!.seed.graph.name(tag)).toBe(tag);
    }

    const doc = parseStarTaggerDoc((await held(STAR_TAGGER_REF))?.txt ?? '');
    expect(doc.taxonomy).toBe('');
    expect(doc.mapping).toContain('### Web');
    expect(doc.notes).toContain('This row customizes');
    expect(doc.setup.reset).toBe(false);
  });

  it('keeps the stored table lines when a later seed reads the same table', async () => {
    const seed = await seedOnce();
    const first = await saveStarSeed(seed, seed.setup, seed.timings, new Date('2026-10-17T00:00:00Z'));
    const second = await saveStarSeed(seed, seed.setup, seed.timings, new Date('2026-10-18T00:00:00Z'));
    expect(second.taxonomy).toBe(first.taxonomy);
    expect(second.taxonomy).toContain('seeded 2026-10-17T00:00:00.000Z');
  });

  it('records a stamp that still matches the table it read', async () => {
    const seed = await seedOnce();
    const cache = await saveStarSeed(seed, seed.setup, seed.timings);
    expect(sameStamp(cache.stamp, await dasStamp())).toBe(true);
  });

  it('reopens the graph namer for an explicit alias', async () => {
    await put({ tid: 1, ref: 'https://a.test/1', type: 'tab', txt: 'js runtime' });
    await put({ tid: 2, ref: 'pin/js.md', type: 'md', txt: '## #js', tags: ['pin'] });
    const seed = await loadPinGraph({
      ...defaultStarSetup(), base: 10, alias: { js: 'javascript' },
    });
    await saveStarSeed(seed, seed.setup, seed.timings);
    const cached = await readStarCache();
    expect(cached?.seed.graph.name('js')).toBe('javascript');
  });

  it('clears a one-shot reset and rewrites the mapping', async () => {
    const seed = await seedOnce();
    const row = await held(STAR_TAGGER_REF);
    await db.das.update(row!.tid!, { txt: setSetupValue(STAR_TAGGER_DOC, 'reset', 'yes') });
    const resetSeed = await loadPinGraph({ ...defaultStarSetup(), base: 10 });

    await saveStarSeed(resetSeed, { ...resetSeed.setup, reset: true }, resetSeed.timings);

    const doc = parseStarTaggerDoc((await held(STAR_TAGGER_REF))?.txt ?? '');
    expect(doc.setup.reset).toBe(false);
    expect(doc.mapping).toContain('### Web');
  });
});

