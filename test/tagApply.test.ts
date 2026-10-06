/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/sdb';
import { applyTagUpdates, revertTagUpdates, tagRowsWithQuery, tagRowsWithTags } from '../src/ui/tagApply';
import type { Da } from '../src/sdb';

/** A clean server row: `dt` set, no local edit, so `daEdit` shelves its version. */
async function seed(tid: number, txt: string, over: Partial<Da> = {}): Promise<Da> {
  const row: Da = {
    tid, txt, ref: `https://example.com/${tid}`, type: 'url',
    tags: ['user'], dt: new Date('2026-10-05T10:00:00Z'), rec: {}, ...over,
  };
  await db.das.put(row);
  return row;
}

const get = (tid: number) => db.das.get(tid);
/** The push is stubbed: the real one talks to the server. */
const noPush = vi.fn(async () => undefined);

beforeEach(async () => {
  await db.das.clear();
  noPush.mockClear();
});

describe('tagRowsWithQuery', () => {
  it('tags the matching rows with the query tokens', async () => {
    await seed(1, 'react hooks tutorial');
    await seed(2, 'react state management');

    const res = await tagRowsWithQuery(await db.das.toArray(), 'react', { push: noPush });

    expect(res.rows).toBe(2);
    expect(res.tags).toEqual(['react']);
    expect((await get(1))?.tags).toEqual(['user', 'react']);
    expect((await get(2))?.tags).toEqual(['user', 'react']);
    expect(noPush).toHaveBeenCalledTimes(1);
  });

  it('keeps the version shelf while recording provenance', async () => {
    await seed(1, 'react hooks tutorial');

    await tagRowsWithQuery(await db.das.toArray(), 'react', { push: noPush });

    const row = await get(1);
    // daEdit's shelf survives the provenance merge, so a later sync can patch against it
    expect(Object.keys(row?.rec.ver ?? {})).toHaveLength(1);
    expect(row?.rec.tagAuto).toMatchObject({ react: { src: 'omnibox' } });
  });

  it('is add-only: an existing tag is never removed', async () => {
    await seed(1, 'vue tutorial', { tags: ['user', 'pinned', '[del]'] });

    await tagRowsWithQuery(await db.das.toArray(), 'vue', { push: noPush });

    expect((await get(1))?.tags).toEqual(['user', 'pinned', '[del]', 'vue']);
  });

  it('does nothing when the query carries no usable token', async () => {
    await seed(1, 'react hooks');

    const res = await tagRowsWithQuery(await db.das.toArray(), 'the a of', { push: noPush });

    expect(res).toMatchObject({ rows: 0, tags: [] });
    expect((await get(1))?.tags).toEqual(['user']);
    expect(noPush).not.toHaveBeenCalled();
  });

  it('skips a row that is not part of the tag UI', async () => {
    await seed(1, 'react hooks');
    await seed(2, 'react session node', { type: 'recr' });

    const res = await tagRowsWithQuery(await db.das.toArray(), 'react', { push: noPush });

    expect(res.rows).toBe(1);
    expect((await get(2))?.tags).toEqual(['user']);
  });
});

describe('tagRowsWithTags', () => {
  it('writes only the named tag, and only to the rows that support it', async () => {
    await seed(1, 'react hooks tutorial');
    await seed(2, 'vue composition api guide');

    const res = await tagRowsWithTags(await db.das.toArray(), ['react hooks'], { push: noPush });

    expect(res.rows).toBe(1);
    expect(res.tags).toEqual(['react hooks']);
    expect((await get(1))?.tags).toEqual(['user', 'react hooks']);
    expect((await get(2))?.tags).toEqual(['user']);
    expect((await get(1))?.rec.tagAuto).toMatchObject({ 'react hooks': { src: 'suggest' } });
  });

  it('writes nothing when no row supports the tag', async () => {
    await seed(1, 'react hooks tutorial');

    const res = await tagRowsWithTags(await db.das.toArray(), ['quantum computing'], { push: noPush });

    expect(res).toMatchObject({ rows: 0, tags: [] });
    expect((await get(1))?.tags).toEqual(['user']);
    expect(noPush).not.toHaveBeenCalled();
  });

  it('names the provenance channel the caller asked for', async () => {
    await seed(1, 'react hooks tutorial');

    await tagRowsWithTags(await db.das.toArray(), ['react'], { push: noPush, src: 'chat' });

    expect((await get(1))?.rec.tagAuto).toMatchObject({ react: { src: 'chat' } });
  });
});

describe('revertTagUpdates', () => {
  it('restores the tags and provenance the write replaced', async () => {
    await seed(1, 'react hooks tutorial');
    const before = await get(1);

    const res = await tagRowsWithQuery(await db.das.toArray(), 'react', { push: noPush });
    expect((await get(1))?.tags).toEqual(['user', 'react']);

    await revertTagUpdates(res.undo, noPush);
    const after = await get(1);
    expect(after?.tags).toEqual(before?.tags);
    expect(after?.rec.tagAuto).toBeUndefined();
    expect(noPush).toHaveBeenCalledTimes(2);
  });
});

describe('applyTagUpdates', () => {
  it('writes the planned tags and reports one undo entry per row', async () => {
    await seed(1, 'react hooks');

    const undo = await applyTagUpdates([{
      tid: 1, ref: 'https://example.com/1', add: ['react'], remove: [],
      tags: ['user', 'react'], rec: { tagAuto: { react: { score: 1, src: 'test', at: 'x' } } },
    }], noPush);

    expect(undo).toEqual([{
      tid: 1, ref: 'https://example.com/1', tags: ['user'],
      rec: expect.objectContaining({}),
    }]);
    expect((await get(1))?.tags).toEqual(['user', 'react']);
  });

  it('skips an update whose row is gone', async () => {
    const undo = await applyTagUpdates([{
      tid: 99, ref: 'gone', add: ['x'], remove: [], tags: ['x'], rec: {},
    }], noPush);

    expect(undo).toEqual([]);
    expect(noPush).not.toHaveBeenCalled();
  });
});
