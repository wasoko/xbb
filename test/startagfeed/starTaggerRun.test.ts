// @vitest-environment happy-dom
/**
 * starTaggerRun.test.ts — the row seed and the write-back around the pure
 * `## Taxonomy` builder.
 *
 * fake-indexeddb supplies the store; qarf runs over a handful of tab/tag rows,
 * so the assertions cover which rows the seed reads, which row it excludes, and
 * what a second identical write leaves alone.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type Da } from '../../src/sdb';
import {
  STAR_TAGGER_DOC, STAR_TAGGER_REF, defaultStarSetup, parseStarTaggerDoc, setSetupValue,
} from '../../src/starTagger';
import { loadPinGraph } from '../../src/ui/seaPinGraph';
import { ensureStarTaggerRow, writeStarTaggerTrace } from '../../src/ui/starTaggerRun';

const put = (row: Partial<Da> & Pick<Da, 'txt' | 'ref' | 'type'>): Promise<number> =>
  db.das.add({ tags: [], rec: {}, ...row } as Da);

const held = async (ref: string): Promise<Da | undefined> =>
  (await db.das.where('[ref+type]').equals([ref, 'md']).toArray())[0];

beforeEach(async () => {
  await db.das.clear();
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

describe('writeStarTaggerTrace', () => {
  it('writes the generated section, keeps Setup and Notes, and skips an unchanged rerun', async () => {
    await put({ tid: 1, ref: 'https://a.test/1', type: 'tab', txt: 'react hooks state' });
    await put({ tid: 2, ref: 'pin/demo.md', type: 'md', txt: '## #react', tags: ['pin'] });
    await ensureStarTaggerRow();
    const seed = await loadPinGraph({ ...defaultStarSetup(), base: 10 });
    const at = new Date('2026-10-17T00:00:00Z');

    const first = await writeStarTaggerTrace(seed, seed.setup, seed.timings, at);
    expect(first.wrote).toBe(true);
    const row = await held(STAR_TAGGER_REF);
    const doc = parseStarTaggerDoc(row?.txt ?? '');
    expect(doc.taxonomy).toContain('| tag | reach | kind |');
    expect(doc.notes).toContain('This row customizes');
    expect(doc.setup.reset).toBe(false);

    const second = await writeStarTaggerTrace(
      seed, seed.setup, seed.timings, new Date('2026-10-18T00:00:00Z'),
    );
    expect(second.wrote).toBe(false);
  });

  it('clears a one-shot reset after rebuilding the trace', async () => {
    await put({ tid: 1, ref: 'https://a.test/1', type: 'tab', txt: 'react hooks state' });
    await ensureStarTaggerRow();
    await db.das.update((await held(STAR_TAGGER_REF))!.tid!, {
      txt: setSetupValue(STAR_TAGGER_DOC, 'reset', 'yes'),
    });
    const seed = await loadPinGraph({ ...defaultStarSetup(), base: 10 });
    const report = await writeStarTaggerTrace(seed, { ...seed.setup, reset: true }, seed.timings);

    expect(report.wrote).toBe(true);
    expect(parseStarTaggerDoc((await held(STAR_TAGGER_REF))?.txt ?? '').setup.reset).toBe(false);
  });
});
