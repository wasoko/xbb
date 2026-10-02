/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as sdb from '../src/sdb';

const DAY = 24 * 3600 * 1000
const HOUR = 3600 * 1000
// recent stamps: older ones fall outside the VER_KEEP_MS shelf life
const DT0 = new Date(Date.now() - 2 * HOUR)
const DT1 = new Date(Date.now() - HOUR)

function mk(extra: Partial<sdb.Da> = {}): sdb.Da {
  return { tid: 7, ref: 'r', txt: 'orig', type: 'test', tags: ['a'], rec: {}, dt: DT0, ...extra }
}
const verOf = (row: sdb.Da) => (row.rec.ver ?? {}) as sdb.VerHist
const txtsOf = (row: sdb.Da) => Object.values(verOf(row)).map(v => v.txt)

describe('rec.ver history', () => {
  it('verKey names a version by the later of dt and modAt', () => {
    expect(sdb.verKey(DT0, null)).toBe(DT0.toISOString())
    expect(sdb.verKey(DT0, DT1)).toBe(DT1.toISOString())
    expect(sdb.verKey(DT1, DT0)).toBe(DT1.toISOString())
  })

  it('verKey is undefined when the row carries no version stamp', () => {
    expect(sdb.verKey()).toBeUndefined()
    expect(sdb.verKey(null, null)).toBeUndefined()
    expect(sdb.verKey(undefined, undefined)).toBeUndefined()
    expect(sdb.verKey(DT0)).toBe(DT0.toISOString())
  })

  it('verSnap drops rec so a stored version cannot nest history', () => {
    const snap = sdb.verSnap(mk({ rec: { deep: { a: 1 } } }))
    expect('rec' in snap).toBe(false)
    expect(snap).toMatchObject({ tid: 7, txt: 'orig', tags: ['a'] })
  })

  it('shelfVer keeps the two versions it was given and drops expired entries', () => {
    const key = new Date().toISOString()
    const expired = new Date(Date.now() - sdb.VER_KEEP_MS - DAY).toISOString()
    const rec = sdb.shelfVer({ ver: { [expired]: sdb.verSnap(mk({ txt: 'gone' })) } }
      , key, sdb.verSnap(mk({ txt: 'now' })))
    expect(Object.keys(rec.ver as sdb.VerHist)).toEqual([key])
    expect((rec.ver as sdb.VerHist)[key].txt).toBe('now')
  })

  it('shelfVer without a key leaves rec untouched', () => {
    expect(sdb.shelfVer(undefined, undefined, sdb.verSnap(mk()))).toEqual({})
  })

  it('pickVer matches the exact server dt only', () => {
    const rec = sdb.shelfVer({}, DT0.toISOString(), sdb.verSnap(mk()))
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

  it('lets the server row win and shelves both versions when that copy is absent', () => {
    const rl = mk({ txt: 'local-edit', tags: ['loc'], modAt: new Date() })
    const rin = mk({ tid: 99, txt: 'server-edit', tags: ['srv'], dt: DT1 })
    const merged = sdb.deepMerge(rl, rin)
    expect(merged.txt).toBe('server-edit')
    expect(merged.tags).toEqual(['srv'])
    expect(merged.tid).toBe(99)
    expect(merged.modAt).toBeUndefined()           // clean → not re-pushed
    expect(txtsOf(merged)).toEqual(expect.arrayContaining(['local-edit', 'server-edit']))
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
