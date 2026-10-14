/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import * as sdb from '../src/sdb';
import { bulk2put } from '../src/greet';

const HOUR = 3600 * 1000
const DT0 = new Date(Date.now() - 2 * HOUR)
const DT1 = new Date(Date.now() - HOUR)
const MOD = new Date(Date.now() - 60 * 1000)

function mk(extra: Partial<sdb.Da> = {}): sdb.Da {
  return { tid: 7, ref: 'r', txt: 'orig', type: 'test', tags: ['a'], rec: {}, dt: DT0, ...extra }
}
const verOf = (row: sdb.Da) => (row.rec.ver ?? {}) as sdb.VerHist
const crOf = (row: sdb.Da) => (row.rec.cr ?? {}) as sdb.VerHist
const crTxts = (row: sdb.Da) => Object.values(crOf(row)).map(v => v.txt)

describe('rec.ver / rec.cr history', () => {
  it('stamp is the ISO form of the dt, or undefined without one', () => {
    expect(sdb.stamp(DT0)).toBe(DT0.toISOString())
    expect(sdb.stamp('2024-01-01T00:00:00Z')).toBe('2024-01-01T00:00:00.000Z')
    expect(sdb.stamp()).toBeUndefined()
    expect(sdb.stamp(null)).toBeUndefined()
  })

  it('verSnap drops rec so a stored version cannot nest history', () => {
    const snap = sdb.verSnap(mk({ rec: { deep: { a: 1 } } }))
    expect('rec' in snap).toBe(false)
    expect(snap).toMatchObject({ tid: 7, txt: 'orig', tags: ['a'] })
  })

  it('putVer keys the entry by the server dt', () => {
    const rec = sdb.putVer({}, DT0, mk({ txt: 'v0' }))
    expect(Object.keys(verOf({ rec } as sdb.Da))).toEqual([DT0.toISOString()])
    expect(sdb.pickVer(rec, DT0)?.txt).toBe('v0')
  })

  it('putVer and putCr are no-ops without their stamp', () => {
    expect(sdb.putVer(undefined, undefined, mk())).toEqual({})
    expect(sdb.putCr(undefined, null, mk())).toEqual({})
  })

  it('putCr files the discarded edit under its devAgent-prefixed modAt key', () => {
    const rec = sdb.putCr({}, MOD, mk({ txt: 'mine' }))
    expect(crOf({ rec } as sdb.Da)[sdb.crStamp(MOD)!].txt).toBe('mine')
  })

  it('crStamp names the discarding client, and stampTime reads the time back', () => {
    expect(sdb.crStamp(MOD)).toBe(`${sdb.treeCac['devAgent']}_${MOD.toISOString()}`)
    expect(sdb.stampTime(sdb.crStamp(MOD)!)).toBe(MOD.getTime())
    expect(sdb.crStamp()).toBeUndefined()
  })

  it('a rewrite shelves the row under its own dt and marks it dirty', () => {
    const spec = sdb.daEdit(mk({ txt: 'before' }), 'after') as { rec: Record<string, unknown> }
    expect(spec).toMatchObject({ txt: 'after', modAt: expect.any(Date) })
    expect(verOf({ rec: spec.rec } as sdb.Da)[DT0.toISOString()].txt).toBe('before')
  })

  it('shelves nothing without a base dt, on a dirty row, or for a held version', () => {
    expect(sdb.daEdit(mk({ dt: undefined }), 'x')).not.toHaveProperty('rec')
    // a dirty row holds post-edit text, which is not the version its dt names
    expect(sdb.daEdit(mk({ txt: 'edited', modAt: MOD }), 'again')).not.toHaveProperty('rec')
    expect(sdb.daEdit(mk({ rec: sdb.putVer({}, DT0, mk({ txt: 'base' })) }), 'x'))
      .not.toHaveProperty('rec')
  })

  it('pickVer matches the exact server dt only', () => {
    const rec = sdb.putVer({}, DT0, mk())
    expect(sdb.pickVer(rec, DT0)?.txt).toBe('orig')
    expect(sdb.pickVer(rec, DT1)).toBeUndefined()
    expect(sdb.pickVer(rec, null)).toBeUndefined()
    expect(sdb.pickVer(undefined, DT0)).toBeUndefined()
  })

  it('mergeVer unions both histories with local entries winning', () => {
    const merged = sdb.mergeVer({ [DT0.toISOString()]: sdb.verSnap(mk({ txt: 'local' })) }
      , { [DT0.toISOString()]: sdb.verSnap(mk({ txt: 'srv' }))
        , [DT1.toISOString()]: sdb.verSnap(mk({ txt: 'only-srv' })) })
    expect(merged[DT0.toISOString()].txt).toBe('local')
    expect(merged[DT1.toISOString()].txt).toBe('only-srv')
  })

  it('withoutVer strips the held history from the snapshot row', () => {
    const row = mk({ rec: { ver: { [DT0.toISOString()]: sdb.verSnap(mk()) }, keep: 1 } })
    expect(sdb.withoutVer(row).rec).toEqual({ keep: 1 })
    expect(sdb.withoutVer(mk())).toMatchObject({ rec: {} })
  })

  it('withCr carries a discarded-edit log onto the replacing row and marks it', () => {
    const key = sdb.crStamp(MOD)!
    const local = mk({ rec: { cr: { [key]: sdb.verSnap(mk({ txt: 'mine' })) } } })
    const merged = sdb.withCr(mk({ tid: 9, txt: 'srv', tags: ['a'] }), local)
    expect(crOf(merged)[key].txt).toBe('mine')
    expect(merged.tags).toEqual(['a', sdb.CHG_REJ_TAG])
    // no log on either side: the incoming row comes back unmarked
    expect(sdb.withCr(mk({ tags: [sdb.CHG_REJ_TAG] })).tags).toEqual([])
  })

  it('dropCrEntry retires one entry and, with the last, the marker tag', () => {
    const key = sdb.crStamp(MOD)!
    const other = sdb.crStamp(DT1)!
    const cr = { [key]: sdb.verSnap(mk()), [other]: sdb.verSnap(mk()) }
    const row = mk({ tags: ['a', sdb.CHG_REJ_TAG], rec: { cr } })
    const one = sdb.dropCrEntry(row, key)
    expect(Object.keys(crOf({ rec: one.rec } as sdb.Da))).toEqual([other])
    expect(one.tags).toBeUndefined()              // the tag stays while an entry remains
    const last = sdb.dropCrEntry({ ...row, rec: { cr: { [other]: sdb.verSnap(mk()) } } }, other)
    expect(last.rec).toEqual({})
    expect(last.tags).toEqual(['a'])
  })

  it('dropHistEntry trashes one ver entry, and the history with the last', () => {
    const row = mk({ rec: { ver: { [DT0.toISOString()]: sdb.verSnap(mk({ txt: 'v0' }))
      , [DT1.toISOString()]: sdb.verSnap(mk({ txt: 'v1' })) } } })
    const keep = sdb.dropHistEntry(row, 'ver', DT0.toISOString())
    expect(Object.keys(verOf({ rec: keep.rec } as sdb.Da))).toEqual([DT1.toISOString()])
    expect(keep).not.toHaveProperty('modAt')     // ver is local bookkeeping, no push
    const last = sdb.dropHistEntry({ ...row
      , rec: { ver: { [DT0.toISOString()]: sdb.verSnap(mk()) } } }, 'ver', DT0.toISOString())
    expect(last.rec).toEqual({})
  })

  it('dropHistEntry trashes a cr entry and dirties the row, so the reduced log is pushed', () => {
    const key = sdb.crStamp(MOD)!
    const row = mk({ tags: ['a', sdb.CHG_REJ_TAG]
      , rec: { cr: { [key]: sdb.verSnap(mk({ txt: 'mine' })) } } })
    const spec = sdb.dropHistEntry(row, 'cr', key) as {
      rec: Record<string, unknown>; tags?: string[]; modAt?: Date }
    expect(spec.modAt).toBeInstanceOf(Date)
    expect(spec.rec).toEqual({})
    expect(spec.tags).toEqual(['a'])             // the marker goes with the last entry
  })
})

describe('deepMerge ver gate', () => {
  it('patches the local diff onto the server row when ver holds its exact dt', () => {
    // the copy under rin.dt can differ from rin: histories merge across clients
    const rl = mk({ txt: 'the quick red fox', modAt: new Date()
      , rec: { ver: { [DT1.toISOString()]: sdb.verSnap(mk({ txt: 'the quick brown fox', dt: DT1 })) } } })
    const rin = mk({ tid: 99, txt: 'THE quick brown fox', dt: DT1 })
    const merged = sdb.deepMerge(rl, rin)
    expect(merged.txt).toBe('THE quick red fox')   // both edits survive
    expect(merged.tid).toBe(99)                    // server pk
    expect(merged.modAt).toBeInstanceOf(Date)      // dirty → re-push
  })

  it('lets the server row win, adopts its version, and files the local edit under cr', () => {
    const rl = mk({ txt: 'local-edit', tags: ['loc'], modAt: MOD })
    const rin = mk({ tid: 99, txt: 'server-edit', tags: ['srv'], dt: DT1 })
    const merged = sdb.deepMerge(rl, rin)
    expect(merged.txt).toBe('server-edit')
    expect(merged.tags).toEqual(['srv', sdb.CHG_REJ_TAG])
    expect(merged.tid).toBe(99)
    expect(merged.modAt).toBeUndefined()           // clean → not re-pushed
    expect(verOf(merged)[DT1.toISOString()].txt).toBe('server-edit')
    expect(crOf(merged)[sdb.crStamp(MOD)!].txt).toBe('local-edit')
    expect(sdb.daStale(merged)).toBe(true)         // the discarded edit is the row's obligation
  })

  it('unions the discarded-edit logs of both sides', () => {
    const srvKey = `otherBrowser_${DT1.toISOString()}`
    const rl = mk({ txt: 'mine', modAt: MOD
      , rec: { cr: { [sdb.crStamp(MOD)!]: sdb.verSnap(mk({ txt: 'mine' })) } } })
    const rin = mk({ tid: 99, txt: 'srv', dt: DT1
      , rec: { cr: { [srvKey]: sdb.verSnap(mk({ txt: 'theirs' })) } } })
    const merged = sdb.deepMerge(rl, rin)
    expect(crTxts(merged).sort()).toEqual(['mine', 'theirs'])
    expect(merged.tags).toContain(sdb.CHG_REJ_TAG)
  })

  it('announces the discarded edit for the greet round to drain', () => {
    sdb.drainCr()
    sdb.deepMerge(mk({ txt: 'local', modAt: MOD }), mk({ tid: 99, txt: 'srv', dt: DT1 }))
    expect(sdb.drainCr()).toEqual([{ ref: 'r', stamp: sdb.crStamp(MOD), reason: 'server-ahead' }])
    expect(sdb.drainCr()).toEqual([])
  })

  it('names a missing base dt when the local row carried none', () => {
    sdb.drainCr()
    sdb.deepMerge(mk({ txt: 'local', modAt: MOD, dt: undefined })
      , mk({ tid: 99, txt: 'srv', dt: DT1 }))
    expect(sdb.drainCr()).toEqual([{ ref: 'r', stamp: sdb.crStamp(MOD), reason: 'no-base-dt' }])
  })

  it('keeps the fixed tid -1 stat row local', () => {
    const merged = sdb.deepMerge(mk({ tid: -1, txt: 'local' })
      , mk({ tid: 99, txt: 'server', dt: DT1 }))
    expect(merged.tid).toBe(-1)
  })

  it('merges stored versions without recMerge, which concatenates arrays', () => {
    const older = new Date(Date.now() - 3 * HOUR)
    const hist = { [older.toISOString()]: sdb.verSnap(mk({ tags: ['a', 'b'] })) }
    const merged = sdb.deepMerge(mk({ rec: { ver: hist } })
      , mk({ dt: DT1, rec: { ver: hist } }))
    expect(verOf(merged)[older.toISOString()].tags).toEqual(['a', 'b'])
  })
})

describe('dl path (bulk2put) ver gate', () => {
  const put = (rl: sdb.Da, dl: sdb.Da[]) => bulk2put([rl], [rl], dl
    , (r: sdb.Da) => r.tid, sdb.daUniq, sdb.tags2str, sdb.deepMerge, sdb.daNoPk)

  it('patches when the re-delivered version is one this client holds', () => {
    const dt = DT1
    const held = mk({ txt: 'edit1', dt })            // a version this client pushed
    const rl = mk({ txt: 'edit2', dt, modAt: MOD
      , rec: { ver: { [dt.toISOString()]: sdb.verSnap(held) } } })
    const { upsPK } = put(rl, [mk({ txt: 'edit1', dt })])

    expect(upsPK[0].txt).toBe('edit2')               // the local wording survives
    expect(upsPK[0].rec.cr).toBeUndefined()          // nothing was discarded
    expect(upsPK[0].modAt).toBeInstanceOf(Date)      // and the row re-pushes
  })

  it('discards to cr when the re-delivered version is not held', () => {
    const rl = mk({ txt: 'edit2', dt: DT1, modAt: MOD }) // no ver entry at all
    const { upsPK } = put(rl, [mk({ txt: 'edit1', dt: DT1 })])

    expect(upsPK[0].txt).toBe('edit1')               // the server copy stands
    expect(upsPK[0].rec.cr).toBeDefined()            // the edit moved to cr
    expect(upsPK[0].tags).toContain(sdb.CHG_REJ_TAG) // and the row is marked for cleanup
    expect(upsPK[0].modAt).toBeUndefined()           // clean, so it stops pushing
  })

  it('carries a clean local log through a snap merge with no dirty row', () => {
    const key = sdb.crStamp(MOD)!
    const local = mk({ txt: 'old', dt: DT0, tags: ['a']
      , rec: { cr: { [key]: sdb.verSnap(mk({ txt: 'mine' })) } } })
    const { newPK, upsPK } = bulk2put([local], [], [mk({ tid: 9, txt: 'srv', dt: DT1, tags: ['a'] })]
      , (r: sdb.Da) => r.tid, sdb.daUniq, sdb.tags2str, sdb.deepMerge, sdb.daNoPk)
    const out = [...newPK, ...upsPK]
    expect(out).toHaveLength(1)
    expect(Object.keys(crOf(out[0]))).toEqual([key])
    expect(out[0].tags).toContain(sdb.CHG_REJ_TAG)
  })
})

describe('patchMod', () => {
  it('applies disjoint local edits onto the server text', () => {
    const merged = sdb.patchMod(mk({ txt: 'the quick brown fox', tags: ['a'] })
      , mk({ txt: 'the quick brown fox', tags: ['a'] })
      , mk({ txt: 'the quick red fox', tags: ['a', 'b'] }))
    expect(merged.txt).toBe('the quick red fox')
    expect(merged.tags).toEqual(['a', 'b'])
  })

  it('returns the base when there is no ancestor copy', () => {
    const base = mk({ txt: 'server' })
    expect(sdb.patchMod(base, undefined, mk({ txt: 'local' }))).toBe(base)
  })
})

describe('clean() duplicate merge', () => {
  // newer than DT1, so a row can outrank the fixed fixture stamps
  const FUT = new Date(Date.now() + HOUR)
  const put = (rows: sdb.Da[]) => sdb.db.das.bulkPut(rows)
  beforeEach(async () => {
    await sdb.db.das.clear()
    await sdb.db.bins.clear()
  })

  it('keeps the newest dt of a daUniq key and files the older row under cr', async () => {
    await put([mk({ tid: 1, txt: 'older', dt: DT0, tags: ['a'] })
      , mk({ tid: 2, txt: 'newer', dt: DT1, tags: ['b'] })])
    const sum = await sdb.clean()
    const left = await sdb.db.das.toArray()
    expect(left).toHaveLength(1)
    expect(left[0]).toMatchObject({ tid: 2, txt: 'newer' })
    expect(left[0].tags).toEqual(['b', 'a', sdb.DUP_REF_TAG])
    // a clean sibling carries no modAt, so its server dt names the entry
    expect(crOf(left[0])[sdb.crStamp(DT0)!].txt).toBe('older')
    expect(left[0].modAt).toBeUndefined()          // the keeper is not re-pushed
    expect(await sdb.db.bins.count()).toBe(1)      // the dropped row is archived first
    expect(sum).toMatchObject({ keys: 1, filed: 1, dropped: 1, sameTxt: 0, clash: 0 })
  })

  it('folds rows of one txt into one row, tags and rec merged, with no cr entry', async () => {
    await put([mk({ tid: 1, txt: 'same', dt: DT0, tags: ['a'], rec: { visitTime: { 1: 10 } } })
      , mk({ tid: 2, txt: 'same', dt: DT1, tags: ['b'], rec: { access2discard: { 2: 20 } } })])
    const sum = await sdb.clean()
    const left = await sdb.db.das.toArray()
    expect(left).toHaveLength(1)
    expect(left[0].tags).toEqual(['b', 'a', sdb.DUP_MERGED_TAG])
    expect(left[0].rec).toMatchObject({ visitTime: { 1: 10 }, access2discard: { 2: 20 } })
    expect(left[0].rec.cr).toBeUndefined()         // identical text leaves nothing to recover
    expect(sum).toMatchObject({ keys: 1, sameTxt: 2, filed: 0, dropped: 1 })
  })

  it('files a duplicate that still holds a local edit and leaves the keeper clean', async () => {
    await put([mk({ tid: 1, txt: 'mine', dt: DT0, modAt: MOD, tags: ['a'] })
      , mk({ tid: 2, txt: 'server', dt: FUT, tags: ['b'] })])
    const sum = await sdb.clean()
    const [row] = await sdb.db.das.toArray()
    expect(row).toMatchObject({ tid: 2, txt: 'server' })
    expect(crOf(row)[sdb.crStamp(MOD)!].txt).toBe('mine')   // the edit is recoverable, not lost
    expect(row.modAt).toBeUndefined()
    expect(row.tags).toContain(sdb.DUP_REF_TAG)
    expect(sum).toMatchObject({ filed: 1, dropped: 1 })
  })

  it('keeps rows of one ref under different types apart', async () => {
    await put([mk({ tid: 1, ref: 'u', type: 'tab', txt: 'T' })
      , mk({ tid: 2, ref: 'u', type: 'bookmark', txt: 'T' })])
    const sum = await sdb.clean()
    expect(await sdb.db.das.count()).toBe(2)
    expect(sum.keys).toBe(0)
  })

  it('collapses onto a newest [del] row instead of resurrecting the ref', async () => {
    await put([mk({ tid: 1, txt: 'gone', dt: DT1, tags: [sdb.DEL_TAG] })
      , mk({ tid: 2, txt: 'live', dt: DT0, tags: ['a'] })])
    await sdb.clean()
    const left = await sdb.db.das.toArray()
    expect(left).toHaveLength(1)
    expect(left[0]).toMatchObject({ tid: 1, tags: [sdb.DEL_TAG] })
    expect(left[0].rec.cr).toBeUndefined()
  })

  it('stamps a row with no dt and merges the duplicates in the same pass', async () => {
    await put([mk({ tid: 1, dt: undefined, txt: 'undated' })
      , mk({ tid: 2, dt: DT0, txt: 'dated' })])
    const sum = await sdb.clean()
    expect(sum).toMatchObject({ filled: 1, keys: 1, dropped: 1 })
    const left = await sdb.db.das.toArray()
    expect(left).toHaveLength(1)
    expect(left[0].tid).toBe(1)                    // the pass stamp outranks DT0
    expect(left[0].dt).toBeInstanceOf(Date)
  })

  it('leaves a table with one row per key alone', async () => {
    await put([mk({ tid: 1 })])
    expect(await sdb.clean()).toMatchObject({ filled: 0, keys: 0, dropped: 0 })
    expect(await sdb.db.das.count()).toBe(1)
  })

  it('retires FIXME_dup_ref with the last cr entry', () => {
    const key = sdb.crStamp(DT0)!
    const row = mk({ tags: ['a', sdb.DUP_REF_TAG], rec: { cr: { [key]: sdb.verSnap(mk()) } } })
    expect(sdb.dropCrEntry(row, key).tags).toEqual(['a'])
  })
})
