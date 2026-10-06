// @vitest-environment happy-dom
/**
 * Display rendering: `da.txt` reaches the renderer from another device, so HTML
 * must not execute, and math must survive as a placeholder until `temml` loads.
 */
import { describe, expect, it } from 'vitest'
import { hydrateMath, renderMd } from '../src/md'

describe('renderMd', () => {
  it('escapes raw HTML in a synced row', () => {
    const html = renderMd('<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;img')
  })

  it('renders headings and inline code', () => {
    const html = renderMd('# Title\n\nuse `code` here\n')
    expect(html).toContain('<h1')
    expect(html).toContain('<code>code</code>')
  })

  it('leaves display math as a placeholder holding its TeX', () => {
    const html = renderMd('$$a \\equiv b $$')
    expect(html).toContain('class="md-math"')
    expect(html).toContain('data-display="1"')
    expect(html).toContain('data-tex="a \\equiv b "')
    expect(html).not.toContain('<math')
  })

  it('leaves inline math as a placeholder', () => {
    const html = renderMd('cost is $a+b$ today')
    expect(html).toContain('data-display="0"')
    expect(html).toContain('data-tex="a+b"')
  })

  it('keeps a lone dollar amount as text', () => {
    const html = renderMd('pay $5 now and $6 later')
    expect(html).not.toContain('md-math')
  })
})

describe('hydrateMath', () => {
  it('fills every placeholder with MathML and leaves plain markdown alone', async () => {
    const host = document.createElement('div')
    host.innerHTML = renderMd('$$a \\equiv b $$ and $x^2$')
    const before = host.querySelectorAll('.md-math')
    expect(before).toHaveLength(2)

    await hydrateMath(host)

    for (const el of Array.from(before)) {
      expect(el.getAttribute('data-math-done')).toBe('1')
      expect(el.innerHTML).toContain('<math')
    }
    expect(host.textContent).toContain('and')
  })

  it('skips placeholders it already filled', async () => {
    const host = document.createElement('div')
    host.innerHTML = renderMd('$$x$$')
    await hydrateMath(host)
    const filled = host.querySelector('.md-math')!.innerHTML
    await hydrateMath(host)
    expect(host.querySelector('.md-math')!.innerHTML).toBe(filled)
  })
})
