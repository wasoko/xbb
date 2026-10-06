/**
 * `mdTree.ts` — builds an mdast-shaped tree from markdown-it tokens.
 *
 * The row builders in `ui/remark-list.ts` and `conv_md_yaml.ts` slice markdown by
 * character offset and climb `children`/`parent` links, which markdown-it's flat
 * token stream does not expose. This module supplies that view: block ranges come
 * from `token.map` translated through a line-offset table, and inline children get
 * offsets from a scan of the text between the block's markers.
 *
 * Node field names and `position.start/end.offset` follow mdast so the row
 * builders keep working unchanged.
 */
import type { Token } from 'markdown-it'
import { mdParse } from './md'

/** One node of the generated tree; fields mirror the mdast node the builder expects. */
export interface MdNode {
  type: string
  value?: string
  url?: string
  alt?: string
  title?: string
  lang?: string
  depth?: number
  children?: MdNode[]
  parent?: MdNode
  position: { start: { offset: number }; end: { offset: number } }
}

/** Block token type to mdast node type. */
const BLOCK_TYPE: Record<string, string> = {
  paragraph_open: 'paragraph',
  blockquote_open: 'blockquote',
  bullet_list_open: 'list',
  ordered_list_open: 'list',
  list_item_open: 'listItem',
  table_open: 'table',
  table_row_open: 'tableRow',
  table_cell_open: 'tableCell',
}

/** Offsets of every line start, plus the end of each line without its terminator. */
function lineIndex(src: string): { starts: number[]; ends: number[] } {
  const starts = [0]
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') starts.push(i + 1)
  const ends = starts.map((start, i) => {
    const stop = i + 1 < starts.length ? starts[i + 1] - 1 : src.length
    return stop > start && src[stop - 1] === '\r' ? stop - 1 : stop
  })
  return { starts, ends }
}

/**
 * Offsets of a block's first content character, past any blockquote or list
 * marker. This is where mdast puts a container's own `start`, so `rec.start` and
 * a paragraph's first-child offset stay comparable with the previous parse.
 *
 * @param src - Full markdown source.
 * @param from - Offset of the line's first character.
 * @param to - Offset of the line's end.
 * @param heading - Whether the block is a heading, whose `#` markers are skipped too.
 * @returns Offset of the first character after the block markers.
 */
function contentStart(src: string, from: number, to: number, heading = false): number {
  let at = from
  if (heading) {
    while (at < to && src[at] === '#') at += 1
    while (at < to && (src[at] === ' ' || src[at] === '\t')) at += 1
    return at
  }
  for (;;) {
    while (at < to && (src[at] === ' ' || src[at] === '\t')) at += 1
    if (at < to && src[at] === '>') {
      at += 1
      continue
    }
    const marker = /^([-*+]|\d{1,9}[.)])([ \t]|$)/.exec(src.slice(at, to))
    if (marker) {
      at += marker[0].length
      continue
    }
    return at
  }
}

/**
 * Reads one token attribute as a string.
 *
 * @param token - Token holding the attribute.
 * @param name - Attribute name, e.g. `href`.
 * @returns The attribute text, or `undefined` when absent.
 */
function attrText(token: Token, name: string): string | undefined {
  const value = token.attrGet(name)
  return value === null || value === undefined ? undefined : String(value)
}

/** Length of `](url)` including the closing paren, or `undefined` when unbalanced. */
function linkTail(src: string, from: number): number | undefined {
  const open = src.indexOf('](', from)
  if (open === -1) return undefined
  let depth = 0
  for (let at = open + 1; at < src.length; at += 1) {
    if (src[at] === '(') depth += 1
    else if (src[at] === ')') {
      depth -= 1
      if (depth === 0) return at + 1 - from
    }
  }
  return undefined
}

/**
 * Expands one block's inline token into mdast-shaped children.
 *
 * @param token - The block's `inline` token.
 * @param src - Full markdown source.
 * @param cursor - Offset the block's inline content starts at.
 * @returns Child nodes with `position.start/end.offset` filled in.
 */
function inlineChildren(token: Token, src: string, cursor: number): MdNode[] {
  const nodes: MdNode[] = []
  const open: MdNode[] = []
  let at = cursor
  const attach = (node: MdNode): void => {
    const parent = open[open.length - 1]
    const siblings = parent ? parent.children! : nodes
    const last = siblings[siblings.length - 1]
    // mdast has no node per line break and no adjacent text nodes: a paragraph's
    // text arrives as one node whose value holds the literal newlines.
    if (node.type === 'text' && last?.type === 'text') {
      last.value = `${last.value ?? ''}${node.value ?? ''}`
      last.position.end = { offset: node.position.end.offset }
      return
    }
    if (parent) {
      node.parent = parent
      siblings.push(node)
    } else nodes.push(node)
  }
  const span = (start: number, end: number) => ({ start: { offset: start }, end: { offset: end } })

  for (const child of token.children ?? []) {
    switch (child.type) {
      case 'text':
        attach({ type: 'text', value: child.content, position: span(at, at + child.content.length) })
        at += child.content.length
        break
      case 'code_inline': {
        const raw = child.content.length + child.markup.length * 2
        attach({ type: 'inlineCode', value: child.content, position: span(at, at + raw) })
        at += raw
        break
      }
      case 'html_inline':
        attach({ type: 'html', value: child.content, position: span(at, at + child.content.length) })
        at += child.content.length
        break
      case 'softbreak': {
        // mdast keeps a soft break inside the surrounding text node's value.
        const last = (open[open.length - 1]?.children ?? nodes).at(-1)
        if (last?.type === 'text') {
          last.value = `${last.value ?? ''}\n`
          last.position.end = { offset: at + 1 }
        } else attach({ type: 'text', value: '\n', position: span(at, at + 1) })
        at += 1
        break
      }
      case 'hardbreak': {
        const end = src.indexOf('\n', at)
        attach({ type: 'break', position: span(at, end === -1 ? at + 1 : end + 1) })
        at = end === -1 ? at + 1 : end + 1
        break
      }
      case 'image': {
        const alt = (child.children ?? []).map((c) => c.content).join('')
        const raw = linkTail(src, at + 2) ?? alt.length + 2
        attach({
          type: 'image',
          url: attrText(child, 'src'),
          alt,
          title: attrText(child, 'title'),
          position: span(at, at + raw + 2),
        })
        at += raw + 2
        break
      }
      case 'link_open':
      case 'strong_open':
      case 'em_open': {
        const node: MdNode = {
          type: child.type === 'link_open' ? 'link' : child.type === 'strong_open' ? 'strong' : 'emphasis',
          url: child.type === 'link_open' ? attrText(child, 'href') : undefined,
          title: child.type === 'link_open' ? attrText(child, 'title') : undefined,
          children: [],
          position: span(at, at + child.markup.length),
        }
        attach(node)
        open.push(node)
        at += child.markup.length
        break
      }
      case 'link_close':
      case 'strong_close':
      case 'em_close': {
        const node = open.pop()
        if (node) {
          const raw = child.type === 'link_close' ? linkTail(src, node.position.start.offset) : child.markup.length
          const end = node.position.start.offset + (raw ?? at + child.markup.length - node.position.start.offset)
          node.position.end = { offset: Math.max(end, node.position.start.offset + child.markup.length) }
          at = Math.max(at, node.position.end.offset)
        } else at += child.markup.length
        break
      }
      default:
        // Unknown inline kinds keep their source width so later offsets stay aligned.
        at += child.content.length
        break
    }
  }
  return nodes
}

/**
 * Depth-first walk over every node, root first, in document order.
 *
 * @param tree - Root returned by {@link markdownTree}.
 * @param visit - Called with the node, its index among its siblings, and its parent.
 */
export function visitTree(
  tree: MdNode,
  visit: (node: MdNode, index: number, parent: MdNode) => void,
): void {
  const walk = (node: MdNode, parent: MdNode): void => {
    visit(node, node.parent?.children?.indexOf(node) ?? 0, parent)
    for (const child of node.children ?? []) walk(child, node)
  }
  walk(tree, tree)
}

/**
 * Parses markdown into an mdast-shaped tree.
 *
 * @param mdText - Markdown source to parse.
 * @returns Root node; every node carries `position.start/end.offset` and, except
 *   the root, a `parent` link the caller may strip.
 */
export function markdownTree(mdText: string): MdNode {
  const src = mdText
  const { starts, ends } = lineIndex(src)
  const tokens = mdParse.parse(src, {})
  const root: MdNode = { type: 'root', children: [], position: { start: { offset: 0 }, end: { offset: src.length } } }
  const stack: MdNode[] = [root]

  const top = () => stack[stack.length - 1]
  const lineSpan = (map: [number, number] | null): { start: number; end: number } | undefined =>
    map ? { start: starts[map[0]] ?? 0, end: ends[Math.min(map[1] - 1, ends.length - 1)] ?? src.length } : undefined

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    const span = lineSpan(token.map)

    if (token.nesting === -1) {
      const node = stack.length > 1 ? stack.pop() : undefined
      // A container ends where its content ends: its line map can include the
      // blank line that separates it from the next block.
      if (node?.children?.length) {
        const last = node.children[node.children.length - 1]
        node.position.end = { offset: last.position.end.offset }
      }
      continue
    }
    if (token.nesting === 1) {
      const type = token.type === 'heading_open' ? 'heading' : BLOCK_TYPE[token.type]
      if (!type) continue
      const node: MdNode = {
        type,
        value: undefined,
        children: [],
        position: { start: { offset: span?.start ?? 0 }, end: { offset: span?.end ?? src.length } },
      }
      if (token.type === 'heading_open') node.depth = Number(token.tag.slice(1))
      // A paragraph starts at its content, not at the blockquote or list marker
      // that precedes it, so `rec.start` measures the indent the row keeps.
      if (type === 'paragraph' && token.map && span) {
        node.position.start = { offset: contentStart(src, span.start, ends[token.map[0]] ?? src.length) }
      }
      node.parent = top()
      top().children!.push(node)
      stack.push(node)
      continue
    }

    switch (token.type) {
      case 'inline': {
        const inline = tokens[i - 1]
        const head = contentStart(src, span?.start ?? 0, ends[token.map?.[0] ?? 0] ?? src.length, inline?.type === 'heading_open')
        for (const node of inlineChildren(token, src, head)) {
          node.parent = top()
          top().children!.push(node)
        }
        break
      }
      case 'fence':
      case 'code_block': {
        const end = ends[(token.map ?? [0, 1])[1] - 1] ?? src.length
        const node: MdNode = {
          type: 'code',
          value: token.content.replace(/\n$/, ''),
          lang: token.info ? token.info.trim().split(/\s+/)[0] : undefined,
          position: { start: { offset: span?.start ?? 0 }, end: { offset: end } },
        }
        node.parent = top()
        top().children!.push(node)
        break
      }
      case 'html_block': {
        const end = ends[(token.map ?? [0, 1])[1] - 1] ?? src.length
        const node: MdNode = {
          type: 'html',
          value: token.content.replace(/\n$/, ''),
          position: { start: { offset: span?.start ?? 0 }, end: { offset: end } },
        }
        node.parent = top()
        top().children!.push(node)
        break
      }
      case 'hr': {
        const node: MdNode = {
          type: 'thematicBreak',
          position: { start: { offset: span?.start ?? 0 }, end: { offset: span?.end ?? src.length } },
        }
        node.parent = top()
        top().children!.push(node)
        break
      }
      default:
        break
    }
  }
  return root
}
