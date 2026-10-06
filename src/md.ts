/**
 * `md.ts` — one markdown-it configuration for the whole app.
 *
 * Two instances exist because parsing and display want opposite `html` settings:
 * `mdParse` keeps raw HTML as a node so a synced row slices back to its source
 * byte-for-byte, while `mdRender` escapes it because `da.txt` arrives from
 * another device through Postgres and is not trusted.
 *
 * Math is delimited by `$..$` (inline) and `$$..$$` (display). Rendering runs in
 * two steps: the parser emits an empty `.md-math` element carrying the TeX, and
 * {@link hydrateMath} fills in MathML after `temml` loads. The placeholder keeps
 * a 174 KB parser out of the initial bundle and keeps the first paint immediate.
 */
import MarkdownIt, { type MarkdownIt as MarkdownItInstance, type Token } from 'markdown-it'

/**
 * Registers the `$..$`/`$$..$$` rules on one instance.
 *
 * @param md - Instance to extend.
 */
function useMath(md: MarkdownItInstance): void {
  md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
    const src = state.src
    if (src[state.pos] !== '$') return false
    const display = src.startsWith('$$', state.pos)
    const open = display ? 2 : 1
    const start = state.pos + open
    if (!display && (src[start] === '$' || /\s/.test(src[start] ?? ' '))) return false
    for (let end = src.indexOf('$', start); end !== -1; end = src.indexOf('$', end + 1)) {
      const close = display ? 2 : 1
      if (display && !src.startsWith('$$', end)) continue
      const tex = src.slice(start, end)
      if (!tex.trim()) return false
      if (!display && (/[\s\\]$/.test(tex) || src[end + 1] === '$')) continue
      if (!silent) {
        const token = state.push('math_inline', 'math', 0)
        token.content = tex
        token.markup = display ? '$$' : '$'
      }
      state.pos = end + close
      return true
    }
    return false
  })

  md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine]
    const first = state.src.slice(start, state.eMarks[startLine])
    if (!first.startsWith('$$')) return false
    let line = startLine
    let closeFrom = start + 2
    let body = first.slice(2)
    if (!body.trim().endsWith('$$')) {
      for (line += 1; line < endLine; line += 1) {
        const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line])
        const at = text.indexOf('$$')
        if (at !== -1) { body += `\n${text.slice(0, at)}`; closeFrom = at; break }
        body += `\n${text}`
      }
      if (line >= endLine) return false
    } else {
      closeFrom = body.lastIndexOf('$$')
      body = body.slice(0, closeFrom)
    }
    if (!body.trim()) return false
    if (!silent) {
      state.line = line + 1
      const token = state.push('math_block', 'math', 0)
      token.block = true
      token.content = body
      token.markup = '$$'
      token.map = [startLine, state.line]
    }
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })

  const renderMath = (tokens: Token[], idx: number): string => {
    const tex = tokens[idx].content
    const display = tokens[idx].markup === '$$'
    const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    const text = tex.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const tag = display ? 'div' : 'span'
    return `<${tag} class="md-math" data-display="${display ? 1 : 0}" data-tex="${attr(tex)}">${text}</${tag}>\n`
  }
  md.renderer.rules.math_inline = renderMath
  md.renderer.rules.math_block = renderMath
}

/**
 * Instance used to parse rows back into their source: raw HTML stays a token so
 * a slice reproduces the original bytes. Tables and strikethrough are disabled
 * to match the CommonMark-only parse the rows were captured against.
 */
export const mdParse = new MarkdownIt({ html: true, linkify: false, typographer: false })
mdParse.disable(['table', 'strikethrough'])
useMath(mdParse)

/** Instance used for display; raw HTML in `da.txt` is escaped. */
export const mdRender: MarkdownItInstance = new MarkdownIt({ html: false, linkify: true, typographer: false })
mdRender.disable(['table', 'strikethrough'])
useMath(mdRender)

/**
 * Renders markdown to HTML for display, leaving `.md-math` elements as text
 * placeholders until {@link hydrateMath} runs.
 *
 * @param text - Markdown source, typically a synced `da.txt`.
 * @returns HTML string safe to inject, with math still unresolved.
 */
export const renderMd = (text: string): string => mdRender.render(text ?? '')

/** Loaded `temml` module, shared by every hydration call. */
let temmlModule: Promise<typeof import('temml').default> | undefined

/**
 * Replaces each pending `.md-math` element with its rendered MathML. Safe to
 * call repeatedly: elements already holding MathML are skipped, so a re-render
 * of the surrounding list costs nothing.
 *
 * @param root - Subtree to scan for unresolved math.
 * @returns Resolves once every placeholder in `root` has been filled or failed.
 */
export async function hydrateMath(root: ParentNode): Promise<void> {
  const pending = root.querySelectorAll<HTMLElement>('.md-math[data-tex]:not([data-math-done])')
  if (pending.length === 0) return
  temmlModule ??= import('temml').then((mod) => mod.default)
  const temml = await temmlModule
  for (const el of Array.from(pending)) {
    el.dataset.mathDone = '1'
    try {
      el.innerHTML = temml.renderToString(el.dataset.tex ?? '', {
        displayMode: el.dataset.display === '1',
        throwOnError: false,
      })
    } catch (err) {
      // A malformed formula keeps its TeX placeholder; the rest still renders.
      console.warn('[md] temml failed:', err)
    }
  }
}
