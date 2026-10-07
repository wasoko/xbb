/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { planPersist, reapplyBuffer } from '../src/ui/reapply';

const BASE = 'one\ntwo\n'

describe('reapplyBuffer', () => {
  it('adopts the fetched text when nothing was typed', () => {
    expect(reapplyBuffer(BASE, BASE, 'one\nSERVER\n')).toMatchObject({ failed: 0, changed: true });
  })

  it('is a no-op when the fetched text is already what the buffer holds', () => {
    const r = reapplyBuffer(BASE, 'older\n', BASE);
    expect(r).toMatchObject({ txt: BASE, failed: 0, changed: false });
  })

  it('reapplies keystrokes typed while the round ran', () => {
    const typed = 'one\ntwo\nthree\n'
    const r = reapplyBuffer(typed, BASE, 'one\ntwo\nSERVER\n');
    expect(r.failed).toBe(0);
    expect(r.txt).toContain('three');   // the local insert survives
    expect(r.txt).toContain('SERVER');  // the fetched text is the base it lands on
  })

  it('keeps the fetched text for a hunk it cannot place', () => {
    const base = 'alpha bravo charlie delta echo foxtrot'
    const fetched = 'zulu yankee xray whiskey victor uniform'
    const r = reapplyBuffer('alpha BRAVO charlie delta echo foxtrot', base, fetched);
    expect(r.failed).toBe(1);
    expect(r.txt).toBe(fetched);
  })

  it('reports the count of dropped hunks, not their text', () => {
    const r = reapplyBuffer('one\nMINE\n', BASE, 'other\nlines\nhere\n');
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(r.txt).toContain('other');
  })
})

describe('planPersist', () => {
  it('skips a buffer the row already carries', () => {
    expect(planPersist(BASE, 'older\n', BASE)).toEqual({ action: 'skip', txt: BASE });
  })

  it('adopts the fetched text when nothing was typed', () => {
    expect(planPersist(BASE, BASE, 'one\nSERVER\n'))
      .toEqual({ action: 'adopt', txt: 'one\nSERVER\n' });
  })

  it('merges keystrokes placed on the fetched text', () => {
    const plan = planPersist('one\ntwo\nthree\n', BASE, 'one\ntwo\nSERVER\n');
    expect(plan.action).toBe('merged');
    expect(plan.txt).toContain('three');
    expect(plan.txt).toContain('SERVER');
  })

  it('reports a conflict for a hunk the fetched text cannot take', () => {
    const plan = planPersist('alpha BRAVO charlie delta echo foxtrot'
      , 'alpha bravo charlie delta echo foxtrot'
      , 'zulu yankee xray whiskey victor uniform');
    expect(plan.action).toBe('conflict');
    expect(plan.txt).toBe('zulu yankee xray whiskey victor uniform');
  })
})
