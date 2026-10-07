/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as sdb from '../src/sdb';
import { greetSettled } from '../src/greet';
import { planPersist } from '../src/ui/reapply';

const HOUR = 3600 * 1000
const DT1 = new Date(Date.now() - HOUR)
const MOD = new Date(Date.now() - 60 * 1000)

/** The row as a round delivers it: clean, at the server's version, which is not the version
 *  the local keystrokes were typed against. */
function srv(extra: Partial<sdb.Da> = {}): sdb.Da {
  return { tid: 7, ref: 'r', txt: 'one\ntwo\nSERVER\n', type: 'test', tags: ['a'], rec: {}
    , dt: DT1, ...extra }
}
const crTxts = (row: sdb.Da) =>
  Object.values((row.rec.cr ?? {}) as sdb.VerHist).map(v => v.txt)

describe('writing the buffer against the version the row carries', () => {
  it('shelves the fetched text, so a later merge patches instead of filing a cr', () => {
    const row = srv()
    const plan = planPersist('one\ntwo\nMINE\n', 'one\ntwo\n', row.txt)
    expect(plan.action).toBe('merged');

    const spec = sdb.daEdit(row, plan.txt);
    expect(spec.txt).toBe(plan.txt);
    expect(spec.txt).toContain('MINE');            // the keystrokes survive
    expect(spec.txt).toContain('SERVER');          // and land on the fetched text
    expect(spec.modAt).toBeInstanceOf(Date);
    expect(sdb.pickVer(spec.rec, DT1)?.txt).toBe(row.txt);   // the ancestor the gate wants
    expect(spec.rec?.cr).toBeUndefined();
  });

  it('keeps the server text and files the edit when a hunk cannot be placed', () => {
    const row = srv({ txt: 'zulu yankee xray whiskey victor uniform' });
    const local: sdb.Da = { ...row, txt: 'alpha BRAVO charlie delta echo foxtrot', modAt: MOD };
    const plan = planPersist(local.txt, 'alpha bravo charlie delta echo foxtrot', row.txt);
    expect(plan.action).toBe('conflict');

    const out = sdb.fileDiscardedCr(row, local);
    expect(out.txt).toBe(row.txt);                 // the server copy stands
    expect(out.modAt == null).toBe(true);          // and is not pushed back
    expect(out.tags).toContain(sdb.CHG_REJ_TAG);
    expect(sdb.pickVer(out.rec, DT1)?.txt).toBe(row.txt);   // applying the entry pushes over it
    expect(crTxts(out)).toEqual([local.txt]);      // the edit survives for the diff tab
  });

  it('announces the filed edit with the reason the round could not merge it', () => {
    sdb.drainCr();
    const row = srv({ txt: 'zulu yankee xray whiskey victor uniform' });
    sdb.fileDiscardedCr(row, { ...row, txt: 'alpha BRAVO charlie delta echo foxtrot', modAt: MOD });
    expect(sdb.drainCr()).toEqual([
      { ref: 'r', stamp: sdb.crStamp(MOD), reason: 'patch-unplaced' }]);
    expect(sdb.drainCr()).toEqual([]);
  });
});

describe('the write barrier', () => {
  it('resolves without starting a round when the caller names no burst', async () => {
    await expect(greetSettled()).resolves.toBeUndefined();
  });

  it('resolves within its bound even when the round it starts fails', async () => {
    const started = Date.now();
    await greetSettled({ idleSince: Date.now(), maxWaitMs: 300 });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
