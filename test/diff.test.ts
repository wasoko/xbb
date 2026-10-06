/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { applyHunk, diffHunks, diffStat, parseAnsi } from '../src/ui/diff';

describe('diffHunks', () => {
  it('is empty for equal texts', () => {
    expect(diffHunks('same', 'same')).toEqual([])
  })

  it('marks the local-only text red and the server-only text green', () => {
    const [hunk] = diffHunks('the quick red fox', 'the quick brown fox')
    expect(hunk.ansi).toContain('\x1b[31mred\x1b[0m')
    expect(hunk.ansi).toContain('\x1b[32mbrown\x1b[0m')
    expect(parseAnsi(hunk.ansi).filter(r => r.color === 'red').map(r => r.text)).toEqual(['red'])
  })

  it('addresses each region inside its own text', () => {
    const local = 'a\nbb\nc'
    const server = 'a\nb\nc'
    const [hunk] = diffHunks(local, server)
    expect(local.slice(hunk.atLocal, hunk.atLocal + hunk.local.length)).toBe(hunk.local)
    expect(server.slice(hunk.atServer, hunk.atServer + hunk.server.length)).toBe(hunk.server)
  })

  it('keeps regions apart when the two texts differ twice', () => {
    expect(diffHunks('one TWO three FOUR', 'one two three four')).toHaveLength(2)
  })

  it('addresses every change inside its own text', () => {
    const local = 'bbccaabcc'
    const server = 'ccaaaccb'
    for (const hunk of diffHunks(local, server))
      for (const change of hunk.changes) {
        expect(local.slice(change.atLocal, change.atLocal + change.local.length))
          .toBe(change.local)
        expect(server.slice(change.atServer, change.atServer + change.server.length))
          .toBe(change.server)
      }
  })

  it('splits a region into the changes a user can take one at a time', () => {
    const [hunk] = diffHunks('bbccaabcc', 'ccaaaccb').slice(1, 2)
    expect(hunk.changes.map(c => [c.local, c.server])).toEqual([['', 'a'], ['b', '']])
  })

  it('carries every change of a region into the region text', () => {
    for (const hunk of diffHunks('the quick red fox', 'the quick brown fox'))
      expect(hunk.changes).toHaveLength(1)
  })
})

describe('diffStat', () => {
  it('is zero for identical texts', () => {
    expect(diffStat('a\nb', 'a\nb')).toEqual({ add: 0, del: 0 })
  })

  it('counts the lines only the version has as added', () => {
    expect(diffStat('a\nb\nc', 'a\nc')).toEqual({ add: 1, del: 0 })
  })

  it('counts the lines only the row has as removed', () => {
    expect(diffStat('a\nc', 'a\nb\nc')).toEqual({ add: 0, del: 1 })
  })

  it('counts a rewritten line on both sides', () => {
    expect(diffStat('a\nB', 'a\nb')).toEqual({ add: 1, del: 1 })
  })
})

describe('applyHunk', () => {
  it('writes one hunk local wording onto the current text', () => {
    const [hunk] = diffHunks('the quick red fox', 'the quick brown fox')
    expect(applyHunk('the quick brown fox', hunk))
      .toEqual({ txt: 'the quick red fox', failed: false })
  })

  it('leaves the other hunks alone', () => {
    const hunks = diffHunks('one TWO three FOUR', 'one two three four')
    expect(applyHunk('one two three four', hunks[0]).txt).toBe('one TWO three four')
  })

  it('reports a region it cannot place instead of guessing', () => {
    const [hunk] = diffHunks('alpha', 'beta')
    expect(applyHunk('nothing like it', hunk)).toEqual({ txt: 'nothing like it', failed: true })
  })
})

describe('parseAnsi', () => {
  it('splits coloured runs and drops other escape codes', () => {
    expect(parseAnsi('a\x1b[31mb\x1b[0mc\x1b[2Jd')).toEqual([
      { text: 'a' }, { text: 'b', color: 'red' }, { text: 'c' }, { text: 'd' },
    ])
  })
})
