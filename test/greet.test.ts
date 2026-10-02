/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as sc from '../src/greet';
import * as sdb from '../src/sdb';
import { setSessSB } from './global-setup';

const SNAP_NAME = 'test_edit_txt';
const SNAP_STALE = 'test_edit_txt_stale';

function mkTag(tid: number, ref: string, txt = 'hello', extra: Partial<sdb.Da> = {}): sdb.Da {
  return {
    tid,
    ref,
    txt,
    type: 'test',
    rec: {},
    dt: new Date('2024-01-01T00:00:00Z'),
    modAt: new Date(),
    ...extra,
  };
}

function makeGreeter(db: sdb.DDB, snap = SNAP_NAME) {
  return new sc.Greeter(
    db.das,
    sc.sessReady,
    sc.sbg,
    snap,
    sdb.deepMerge,
    sdb.uniqsTag,
    (r: sdb.Da) => r.tid,
    sdb.nopkTag,
  );
}

/** Edit `txt` the way the editor does: shelf the pre-edit version, then mark the row dirty. */
async function edit(db: sdb.DDB, tid: number, txt: string) {
  const row = await db.das.get(tid);
  await db.das.update(tid, { txt, modAt: new Date()
    , rec: sdb.shelfVer(row!.rec, sdb.verKey(row!.dt, row!.modAt), sdb.verSnap(row!)) });
}

/** Text of every version shelved in a row's `rec.ver`. */
const shelvedTxts = (row?: sdb.Da) =>
  Object.values((row?.rec?.ver ?? {}) as sdb.VerHist).map(v => v.txt);

/** Empty one snap on the server, so `ins` is not gated on unrelated rows. */
async function clearSnap(snap: string) {
  const { error } = await sc.sbg.from('upsbase').delete().eq('snap', snap);
  if (error) throw new Error(`Failed to clear server snap ${snap}: ${error.message}`);
}

describe('greet two-client text edit', () => {
  beforeAll(async () => {
    await setSessSB(sc.sbg);
    await clearSnap(SNAP_NAME);
  }, 20_000);

  it.concurrent('converges two clients editing the same text row', async () => {
    const dbA = new sdb.DDB('tdb1_edit_txt');
    const dbB = new sdb.DDB('tdb2_edit_txt');
    const fusA = makeGreeter(dbA);
    const fusB = makeGreeter(dbB);

    await Promise.all([dbA.das.clear(), dbB.das.clear()]);

    await dbA.das.put(mkTag(1, 'shared-ref', 'hello'));
    await fusA.pullPush();
    await fusA.pullPush();

    await fusB.pullPush();

    await edit(dbA, 1, 'hello world');
    await edit(dbB, 1, 'hell');

    await fusA.pullPush();
    await fusB.pullPush();
    await Promise.all([fusA.pullPush(), fusB.pullPush()]);

    const rowA = await dbA.das.get(1);
    const rowB = await dbB.das.get(1);

    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
    expect(rowA?.modAt == null).toBe(true);
    expect(rowB?.modAt == null).toBe(true);
    expect(rowA?.txt).toBe(rowB?.txt);
    expect(rowA?.txt).not.toBe('hello');
    // A holds the version it pushed; B's losing edit survives in its own history
    expect(shelvedTxts(rowA)).toContain(rowA!.txt);
    expect(shelvedTxts(rowA)).toContain('hello');
    expect(shelvedTxts(rowB)).toContain('hell');
  }, 25_000);

  it('conflict without an exact dt copy: server wins, local version shelved', async () => {
    const dbA = new sdb.DDB('tdb_stale_a');
    const dbB = new sdb.DDB('tdb_stale_b');
    const fusA = makeGreeter(dbA, SNAP_STALE);
    const fusB = makeGreeter(dbB, SNAP_STALE);
    await clearSnap(SNAP_STALE);
    await Promise.all([dbA.das.clear(), dbB.das.clear()]);

    // Seed one base version, held by both clients
    await dbA.das.put(mkTag(112, 'shared-stale', 'base txt'));
    await fusA.pullPush();
    await fusA.pullPush();
    await fusB.pullPush();

    // A advances the server version
    await edit(dbA, 112, 'bAse txt');
    await fusA.pullPush();

    // B edits from the stale version: ver holds base txt, not A's new dt
    await edit(dbB, 112, 'BBse txt');
    await fusB.pullPush();

    const rowB = await dbB.das.get(112);
    expect(rowB?.txt).toBe('bAse txt');            // server version stands
    expect(rowB?.modAt).toBeUndefined();           // merged, not left dirty
    expect(shelvedTxts(rowB)).toContain('BBse txt'); // B's version kept in rec.ver
    expect(shelvedTxts(rowB)).toContain('base txt');
  }, 25_000);

  if(0) // wrong hypothesis: local tid detection/merging, not server
  it.concurrent('R4: should not create duplicate rows when server tid differs from local tid', async () => {
    const dbA = new sdb.DDB('tdb_r4_a');
    const dbB = new sdb.DDB('tdb_r4_b');
    const fusA = makeGreeter(dbA);
    const fusB = makeGreeter(dbB);
    await Promise.all([dbA.das.clear(), dbB.das.clear()]);

    // Client A: tid=104, ref='shared-r4'
    await dbA.das.put(mkTag(104, 'shared-r4', 'content-A'));
    await fusA.pullPush();

    // Client B: tid=199, ref='shared-r4' (different PK, same uniq)
    await dbB.das.put(mkTag(199, 'shared-r4', 'content-B'));
    
    // B pulls. Server has tid=104. 
    // If merge() is broken, B might keep tid=199 AND add tid=104.
    await fusB.pullPush();

    const allRows = await dbB.das.toArray();
    const matchingUniqs = allRows.filter(r => r.ref === 'shared-r4');
    
    expect(matchingUniqs.length).toBe(1);
  }, 25_000);

  it.concurrent('Rename: updating ref field should delete old ref and keep new one', async () => {
    const dbA = new sdb.DDB('tdb_rename_a');
    const dbB = new sdb.DDB('tdb_rename_b');
    const fusA = makeGreeter(dbA);
    const fusB = makeGreeter(dbB);
    await Promise.all([dbA.das.clear(), dbB.das.clear()]);

    // Initial row
    await dbA.das.put(mkTag(201, 'old-ref', 'some text'));
    await fusA.pullPush();
    await fusB.pullPush();

    // Rename: old-ref -> new-ref
    await dbA.das.update(201, { ref: 'new-ref', modAt: new Date() });
    await fusA.pullPush();
    await fusB.pullPush();

    const rowsB = await dbB.das.toArray();
    expect(rowsB.some(r => r.ref === 'new-ref')).toBe(true);
    expect(rowsB.some(r => r.ref === 'old-ref')).toBe(false);
  }, 25_000);
});
