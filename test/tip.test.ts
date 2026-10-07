// @vitest-environment happy-dom
/**
 * Hover preview header: the app's tooltip line is `… synced:<age>`, the row id,
 * and its tag chips, with the pin board tag left out. Chips reuse the cs1 tag
 * color, so a tag reads the same here as in the card.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { getColorChar11 } from '../src/fc'
import { TIP_ATTR, tipAnchor, tipFittedLeft, tipHead } from '../src/ui/Tip'
import type { Da } from '../src/sdb'

/** Row shaped like a rest-list markdown row. */
const row = (over: Partial<Da> = {}): Da => ({
  tid: 9018,
  txt: '# Math demo\n',
  ref: 'math-demo.md',
  type: 'md',
  tags: ['pin', 'mathdemo'],
  dt: new Date(),
  rec: { visitTime: Date.now() - 60_000 },
  ...over,
})

describe('tipHead', () => {
  it('carries the sync ages, the row id and the tags', () => {
    const html = renderToStaticMarkup(tipHead(row()))
    expect(html).toMatch(/synced:/)
    expect(html).toContain('tid: 9018')
    expect(html).toContain('#mathdemo')
  })

  it('leaves the pin board tag out of the chips', () => {
    expect(renderToStaticMarkup(tipHead(row()))).not.toContain('#pin')
  })

  it('colors each chip with the cs1 tag color', () => {
    const html = renderToStaticMarkup(tipHead(row({ tags: ['mathdemo'] })))
    expect(html).toContain(getColorChar11('mathdemo'))
  })

  it('omits the id when the row has no tid', () => {
    const html = renderToStaticMarkup(tipHead(row({ tid: undefined })))
    expect(html).not.toContain('tid:')
  })
})

describe('tip marker', () => {
  it('names the attribute rows opt in with', () => {
    expect(TIP_ATTR).toBe('data-tip')
  })
})

describe('tipAnchor', () => {
  it('puts the panel left edge on the list container left edge', () => {
    expect(tipAnchor({ bottom: 100 }, 300, 1000).left).toBe(300)
  })

  it('keeps the panel exactly on a container that starts at the viewport edge', () => {
    expect(tipAnchor({ bottom: 100 }, 0, 1000).left).toBe(0)
  })

  it('keeps a gap when the container reaches the right edge', () => {
    expect(tipAnchor({ bottom: 100 }, 999, 1000).left).toBe(992)
  })

  it('hangs flush under the row', () => {
    expect(tipAnchor({ bottom: 100 }, 300, 1000).top).toBe(99)
  })
})

describe('tipFittedLeft', () => {
  it('leaves an anchor alone when the panel fits', () => {
    expect(tipFittedLeft(300, 700, 1000)).toBe(300)
  })

  it('slides the panel left when it overflows the right edge', () => {
    expect(tipFittedLeft(600, 1100, 1000)).toBe(492)
  })

  it('stops at the viewport edge', () => {
    expect(tipFittedLeft(0, 1400, 1000)).toBe(0)
  })
})
