/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const NEW_SNAP = 'tags.22.cbor.pako';
const OLD_SNAP = 'tags.11.cbor.pako';

/** CDN state the fake client serves: the listing is fixed, the payload is per test. */
const cdn = vi.hoisted(() => ({
  loaded: [] as string[],
  payload: null as Uint8Array | null,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'u-test' } } } }),
      setSession: async () => ({ data: {} }),
      signOut: async () => ({}),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    storage: { from: () => ({
      list: async () => ({ data: [
        { name: NEW_SNAP, created_at: '2026-10-02T00:00:00Z' },
        { name: OLD_SNAP, created_at: '2026-10-01T00:00:00Z' },
      ], error: null }),
      download: async (path: string) => {
        cdn.loaded.push(path);
        const buf = cdn.payload;
        return { data: buf && { arrayBuffer: async () =>
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null };
      },
      upload: async () => ({ error: null }),
    }) },
    rpc: async () => ({ data: {
      ok_uniqs: [], dl: [], server_now: new Date().toISOString() }, error: null }),
    from: () => ({ delete: () => ({ eq: async () => ({ error: null }) }) }),
  }),
}));

import { beforeAll } from 'vitest';
import * as sc from '../src/greet';
import * as sdb from '../src/sdb';
import * as fc from '../src/fc';

const mkRow = (tid: number, ref: string): sdb.Da =>
  ({ tid, ref, txt: `v${tid}`, type: 'md', rec: {}, dt: new Date('2026-09-30T00:00:00Z') });

/** The stat row every greet round pushes; it is never a user edit. */
const statRow = (): sdb.Da =>
  ({ ...mkRow(-1, 'greet stat-cnt'), type: 'stat-cnt', modAt: new Date() });

beforeAll(async () => { await sc.sessReady; });

beforeEach(async () => {
  await sdb.db.das.clear();
  await sdb.db.tree.clear();
  await sdb.db.bins.clear();
  cdn.loaded.length = 0;
  cdn.payload = null;
  sc.greeter.snap = '';
});

describe('effSnapName', () => {
  it('prefixes a tags snapshot and reports none for an empty name', () => {
    expect(sc.effSnapName(NEW_SNAP)).toBe('up-' + NEW_SNAP);
    expect(sc.effSnapName('')).toBe('');
  });
});

describe('outstandingDirty', () => {
  it('lists unsynced rows and skips the stat row', async () => {
    await sdb.db.das.bulkPut([
      { ...mkRow(1, 'a.md'), modAt: new Date() },
      statRow(),
      mkRow(2, 'clean.md'),
    ]);
    const dirty = await sc.outstandingDirty();
    expect(dirty.map(r => r.tid)).toEqual([1]);
    expect(sc.dirtyLabel(dirty)).toEqual(['a.md (md)']);
  });

  it('caps the confirmation lines', () => {
    const rows = [1, 2, 3].map(i => mkRow(i, `r${i}.md`));
    expect(sc.dirtyLabel(rows, 2)).toEqual(['r1.md (md)', 'r2.md (md)']);
  });
});

describe('applySnapPin', () => {
  it('refuses a pin the listing does not have, leaving the table alone', async () => {
    await sdb.db.das.put({ ...mkRow(1, 'a.md'), modAt: new Date() });
    const res = await sc.applySnapPin('tags.99.cbor.pako');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no such snap');
    expect(await sdb.db.das.count()).toBe(1);
    expect(await sdb.db.bins.count()).toBe(0);
  });

  it('archives the rows, empties the table and loads the pinned snapshot', async () => {
    await sdb.db.das.put({ ...mkRow(1, 'gone.md'), modAt: new Date() });
    cdn.payload = fc.encZip([mkRow(7, 'pinned.md')]);

    const res = await sc.applySnapPin(OLD_SNAP);

    expect(res.ok).toBe(true);
    expect(cdn.loaded).toEqual(['u-test/' + OLD_SNAP]);      // the pin, not the newest
    expect(await sdb.db.das.get(1)).toBeUndefined();         // old working set is gone
    expect((await sdb.db.das.get(7))?.ref).toBe('pinned.md');
    expect(await sdb.db.bins.count()).toBe(1);
    expect((await sdb.db.tree.get('snap_pin'))?.value).toBe(OLD_SNAP);
    expect((await sdb.db.tree.get('snap_name'))?.value).toBe('up-' + OLD_SNAP);
    expect(sc.greeter.snap).toBe('up-' + OLD_SNAP);
  });

  it('clears the pin and follows the newest snapshot again', async () => {
    await sdb.db.tree.put({ key: 'snap_pin', value: OLD_SNAP });
    cdn.payload = fc.encZip([mkRow(5, 'newest.md')]);

    const res = await sc.applySnapPin('');

    expect(res.ok).toBe(true);
    expect(cdn.loaded).toEqual(['u-test/' + NEW_SNAP]);
    expect((await sdb.db.tree.get('snap_pin'))?.value).toBe('');
    expect((await sdb.db.tree.get('snap_name'))?.value).toBe('up-' + NEW_SNAP);
  });
});

describe('dl_merge with a pin', () => {
  it('loads the pinned file even when it is not the newest listing entry', async () => {
    cdn.payload = fc.encZip([mkRow(9, 'old.md')]);

    const res: any = await sc.dl_merge(sdb.db.das, '', false, undefined, OLD_SNAP);

    expect(cdn.loaded).toEqual(['u-test/' + OLD_SNAP]);
    expect(res.upSnapName).toBe('up-' + OLD_SNAP);
  });

  it('skips the download when the pinned snapshot is already loaded', async () => {
    await sdb.db.tree.put({ key: 'snap_pin', value: OLD_SNAP });
    await sdb.db.das.put(mkRow(3, 'pinned.md'));

    const res: any = await sc.dl_merge(sdb.db.das, 'up-' + OLD_SNAP, false, undefined, OLD_SNAP);

    expect(res.upSnapName).toBe('up-' + OLD_SNAP);
    expect(cdn.loaded).toEqual([]);
  });

  it('reports a pinned file the CDN cannot deliver instead of throwing', async () => {
    const res: any = await sc.dl_merge(sdb.db.das, '', false, undefined, OLD_SNAP);

    expect(String(res.error)).toContain('dl snap ' + OLD_SNAP);
  });
});

describe('greet under a pin', () => {
  it('keeps the pinned snapshot loaded instead of moving to the newest', async () => {
    await sdb.db.tree.put({ key: 'snap_pin', value: OLD_SNAP });
    await sdb.db.tree.put({ key: 'snap_name', value: 'up-' + OLD_SNAP });
    await sdb.db.das.put(mkRow(3, 'pinned.md'));

    await sc.greet(sdb.db.das);

    expect(cdn.loaded).toEqual([]);
    expect((await sdb.db.tree.get('snap_name'))?.value).toBe('up-' + OLD_SNAP);
    expect(sc.greeter.snap).toBe('up-' + OLD_SNAP);
  });
});
