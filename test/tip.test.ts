// @vitest-environment happy-dom
/**
 * Hover preview header: the app's tooltip line is `… synced:<age>`, the row id,
 * and its tag chips, with the pin board tag left out. Chips reuse the cs1 tag
 * color, so a tag reads the same here as in the card.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { getColorChar11 } from '../src/fc'
import { TIP_ATTR, tipHead } from '../src/ui/Tip'
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
