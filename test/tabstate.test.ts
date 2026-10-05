/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { tabSyncState, tabVisual } from '../src/ui/tabState';
import type { Da } from '../src/sdb';
import type { GreetStat } from '../src/greet';

const HOUR = 3600 * 1000
const DT0 = new Date(Date.now() - 2 * HOUR)
const DT1 = new Date(Date.now() - HOUR)
const MOD = new Date(Date.now() - 60 * 1000)
const ACT: GreetStat = { inflight: 0, phase: 'idle', frac: 0, steps: [], lastDirtyLeft: 0 }
const FAILED: GreetStat = { ...ACT, lastError: 'greet rpc: offline' }

function mk(extra: Partial<Da> = {}): Da {
  return { tid: 1, ref: 'a.md', txt: 'server', type: 'md', rec: {}, dt: DT0, ...extra }
}
const state = (rows: Da[] | undefined, buffer: string | undefined, greet = ACT) =>
  tabSyncState({ rows, buffer, greet })

describe('tabSyncState', () => {
  it('is undefined until the live query resolves', () => {
    expect(state(undefined, 'x')).toBeUndefined()
  })

  it('reports a draft while no live row exists', () => {
    expect(state([], undefined)).toMatchObject({ row: 'draft', bufferUnsaved: false })
  })

  it('reports clean when no row is dirty and the buffer matches the shown row', () => {
    expect(state([mk()], 'server')).toMatchObject({ row: 'clean', bufferUnsaved: false })
  })

  it('marks an unsaved buffer without changing the row state', () => {
    const s = state([mk()], 'typed but not blurred')
    expect(s).toMatchObject({ row: 'clean', bufferUnsaved: true })
    expect(s?.detail).toContain('unsaved buffer')
  })

  it('reports pending for a local edit whose dt is also the newest', () => {
    const s = state([mk({ txt: 'local', modAt: MOD })], 'local')
    expect(s).toMatchObject({ row: 'pending', bufferUnsaved: false })
    expect(s?.detail).toContain('pending push')
  })

  it('reports diverged when the dirty row is not the newest server row', () => {
    const rows = [mk({ tid: 1, txt: 'local', modAt: MOD }), mk({ tid: 2, txt: 'server2', dt: DT1 })]
    // the editor paints the winner: the local edit, not the newest server copy
    const s = state(rows, 'local')
    expect(s).toMatchObject({ row: 'diverged', bufferUnsaved: false, shown: { tid: 1, txt: 'local' } })
    expect(s?.detail).toContain('row #1')
  })

  it('reports stale while the row carries a discarded local edit', () => {
    const cr = { [`thisBrowser_${MOD.toISOString()}`]: { tid: 1, ref: 'a.md', txt: 'mine', type: 'md' } }
    const s = state([mk({ txt: 'local', modAt: MOD, rec: { cr } })], 'local')
    expect(s).toMatchObject({ row: 'stale', bufferUnsaved: false, conflicts: 1 })
    expect(s?.detail).toContain('not reapplied')
  })

  it('carries patchFail hunks as a warning on a dirty row', () => {
    const rows = [mk({ txt: 'local', modAt: MOD, rec: { patchFail: { at: 'now', hunks: 2 } } })]
    const s = state(rows, 'local')
    expect(s).toMatchObject({ row: 'pending', warn: expect.stringContaining('2 hunk') })
    expect(tabVisual(s).glyph).toBe('⚠')
  })

  it('counts the discarded local edits the shown row still carries', () => {
    const cr = { [MOD.toISOString()]: { tid: 1, ref: 'a.md', txt: 'mine', type: 'md' } }
    const s = state([mk({ rec: { cr } })], 'server')
    expect(s).toMatchObject({ row: 'stale', conflicts: 1 })
    expect(s?.detail).toContain('1 discarded local edit')
    expect(tabVisual(s).badge).toBe('1')
    expect(tabVisual(s).glyph).toBe('⚠')
  })

  it('treats a tombstoned ref as a draft', () => {
    expect(state([mk({ tags: ['[del]'], modAt: MOD })], 'local')).toMatchObject({ row: 'draft' })
  })

  it('reports failed for a dirty row after a failed greet round', () => {
    expect(state([mk({ modAt: MOD })], 'local', FAILED))
      .toMatchObject({ row: 'failed', detail: expect.stringContaining('offline') })
  })

  it('reports diverged over failed and still names the failed round', () => {
    const rows = [mk({ tid: 1, modAt: MOD }), mk({ tid: 2, dt: DT1 })]
    const s = state(rows, 'local', FAILED)
    expect(s).toMatchObject({ row: 'diverged' })
    expect(s?.detail).toContain('offline')
  })

  it('keeps a clean tab clean after an unrelated failed greet round', () => {
    expect(state([mk()], 'server', FAILED)).toMatchObject({ row: 'clean' })
  })

  it('treats the md and src rows of one ref as separate units', () => {
    const rows = [mk({ tid: 1, type: 'md', txt: 'local', modAt: MOD }), mk({ tid: 2, type: 'src', dt: DT1 })]
    expect(state(rows, 'server')).toMatchObject({ row: 'pending' })
  })
})

describe('tabVisual', () => {
  it('renders nothing before the state resolves', () => {
    expect(tabVisual(undefined)).toEqual({ glyph: '' })
  })

  it('keeps pending ambient: label tint, no glyph, no tab tint', () => {
    const v = tabVisual(state([mk({ txt: 'local', modAt: MOD })], 'local'))
    expect(v.glyph).toBe('')
    expect(v.tabStyle).toBeUndefined()
    expect(v.labelStyle?.background).toContain('245, 158, 11')
  })

  it('underlines and italicizes an unsaved buffer', () => {
    const v = tabVisual(state([mk()], 'typed'))
    expect(v.labelStyle).toMatchObject({ fontStyle: 'italic' })
    expect(v.labelStyle?.borderBottom).toContain('dashed')
  })

  it('tints the whole tab and shows a glyph for attention states', () => {
    const rows = [mk({ tid: 1, modAt: MOD }), mk({ tid: 2, dt: DT1 })]
    const v = tabVisual(state(rows, 'local'))
    expect(v.glyph).toBe('⚠')
    expect(v.tabStyle?.background).toContain('239, 68, 68')
    expect(v.title).toContain('newer version')
  })
})
