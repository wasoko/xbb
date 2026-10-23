/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/sdb';
import { pinRowsFor } from '../src/ui/cardTab';

const put = (ref: string, tags: string[], type = 'md') =>
  db.das.put({ ref, type, txt: ref, tags, rec: {} });

const refs = (rows: { ref: string }[]) => rows.map((row) => row.ref).sort();

beforeEach(async () => {
  await db.das.clear();
});

describe('pinRowsFor', () => {
  it('reads pins through the tag index and keeps the current filters', async () => {
    await put('pin1', ['pin', 'react']);
    await put('pin2', ['pin', 'vue']);
    await put('pin3', ['pin', 'react', '[del]']);
    await put('pin4', ['react']);
    await put('pin5', ['pin', 'react'], 'tab');

    expect(refs(await pinRowsFor([]))).toEqual(['pin1', 'pin2']);
    expect(refs(await pinRowsFor(['react']))).toEqual(['pin1']);
    expect(refs(await pinRowsFor(['pin', 'react']))).toEqual(['pin1']);
    expect(refs(await pinRowsFor(['vue']))).toEqual(['pin2']);
  });
});
