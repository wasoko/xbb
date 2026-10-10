/**
 * vecCache.test.ts — the content-keyed vector store over `db.embs`.
 *
 * `fake-indexeddb` gives the real Dexie schema, so the cases cover what the app
 * does: prime one model's namespace, serve hits synchronously, write misses back,
 * and keep two models' vectors apart.
 */

import 'fake-indexeddb/auto';
import { Dexie } from 'dexie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DDB, db } from '../src/sdb';
import { modelVecCache } from '../src/vecCache';
import { embedWithCache, mapVectorCache, textHash } from '../src/srctag';

describe('textHash', () => {
  it('is stable, 64 bits wide, and content-keyed', () => {
    expect(textHash('react hooks')).toBe(textHash('react hooks'));
    expect(textHash('react hooks')).toHaveLength(16);
    expect(textHash('react hooks')).not.toBe(textHash('react hook'));
  });

  it('hashes the compatibility form of the content, keeping its case', () => {
    expect(textHash('Ｒｅａｃｔ')).toBe(textHash('React'));
    // a capitalization is a different text, and so a different key
    expect(textHash('React')).not.toBe(textHash('react'));
  });

  it('separates texts that differ by one character', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(textHash(`title ${i}`));
    expect(seen.size).toBe(500);
  });
});

describe('mapVectorCache', () => {
  it('keys by model and content, and answers synchronously', () => {
    const cache = mapVectorCache();
    cache.set('m', 'a', [1, 2]);
    expect(Array.from(cache.get('m', 'a')!)).toEqual([1, 2]);
    expect(cache.get('m', 'b')).toBeUndefined();
    expect(cache.get('other', 'a')).toBeUndefined();
  });

  it('seeds the store an embedder fills', async () => {
    const cache = mapVectorCache();
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [7]));
    expect(await embedWithCache(embed, 'm', ['a', 'a', 'b'], cache)).toEqual([[7], [7], [7]]);
    expect(Array.from(cache.get('m', 'a')!)).toEqual([7]);
    // the second call needs no request at all
    expect(await embedWithCache(embed, 'm', ['a', 'b'], cache)).toEqual([[7], [7]]);
    expect(embed).toHaveBeenCalledTimes(1);
  });
});

describe('modelVecCache', () => {
  beforeEach(async () => {
    await db.embs.clear();
  });

  it('primes a model namespace and writes its misses back', async () => {
    const cache = await modelVecCache('m1');
    expect(cache.primed).toBe(0);
    expect(cache.written()).toBe(0);
    expect(cache.get('m1', 'a')).toBeUndefined();
    // a lookup under another model is this cache's miss, not its business
    expect(cache.get('m2', 'a')).toBeUndefined();

    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 2]));
    expect(await embedWithCache(embed, 'm1', ['a', 'a'], cache)).toEqual([[1, 2], [1, 2]]);
    expect(cache.written()).toBe(2);

    const rows = await db.embs.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hash: textHash('a'), mdl: 'm1' });
    expect(Array.from(rows[0].vec)).toEqual([1, 2]);

    const again = await modelVecCache('m1');
    expect(again.primed).toBe(1);
    expect(Array.from(again.get('m1', 'a')!)).toEqual([1, 2]);
    expect(again.get('m2', 'a')).toBeUndefined();

    // a model of its own primes nothing from the other namespace
    expect((await modelVecCache('m2')).primed).toBe(0);
  });

  it('keys by content, so an edited title is a miss rather than a stale hit', async () => {
    const cache = await modelVecCache('m1');
    cache.set('m1', 'react hooks', [3]);
    expect(cache.get('m1', 'react hooks')).toBeDefined();
    expect(cache.get('m1', 'react hooks guide')).toBeUndefined();
  });
});

describe('the schema upgrade', () => {
  /** The store the app had before the content-keyed table, at its own version. */
  const OLD_STORES = {
    tree: 'key',
    das: '++tid, dt, type, *tags, [ref+type], modAt',
    vecs: '[tid+mdl]',
    stat: '[tid+key]',
    bins: 'key, [key+addAt], [key+modAt]',
    refs: '++id, title, href, dt, type',
  };

  it('drops the row-keyed vecs table and opens the content-keyed one', async () => {
    const name = 'upgradeTest';
    const old = new Dexie(name);
    old.version(12).stores(OLD_STORES);
    await old.open();
    await old.table('vecs').put({ tid: 1, mdl: 'm', vec: new Float32Array([1, 2]) });
    await old.table('das').put({ txt: 'react hooks', ref: 'https://e.com/1', type: 'tab', rec: {} });
    old.close();

    /* A primary key cannot be changed in place: Dexie aborts the upgrade with
       `UpgradeError`, so the content-keyed table is a new name and the old one is
       deleted in the same version. */
    const upgraded = new DDB(name);
    await upgraded.open();
    const names = upgraded.tables.map((t) => t.name);
    expect(names).toContain('embs');
    expect(names).not.toContain('vecs');
    expect(upgraded.table('embs').schema.primKey.src).toBe('[hash+mdl]');
    expect(await upgraded.table('embs').count()).toBe(0);
    // the rows the app is about are untouched
    expect(await upgraded.table('das').count()).toBe(1);
    await upgraded.delete();
  });
});
