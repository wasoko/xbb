// @vitest-environment happy-dom
/**
 * Row building over the markdown-it tree: the slices a pin card's markdown is
 * split into, and that joining them back reproduces the source. The expected
 * values were captured from the mdast-based implementation this replaced, so a
 * change in offsets or node order fails here rather than in the card view.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { reconstruct, remark2tagged } from '../src/ui/remark-list'
import { md2tag } from '../src/fc'

/** Fixture covering every leaf kind the row builders branch on. */
const MD = `# h1 alpha #tag1

para one with [a link](https://e.com/x) and \`inline code\`.

## h2 beta #tag2

> quoted line

\`\`\`ts
const a = 1
\`\`\`

- item one
  - nested item
- item two

---

| a | b |
| - | - |
| 1 | 2 |

<div>raw html</div>

Last para.
`

describe('remark2tagged', () => {
  it('slices the source into one row per leaf', () => {
    const rows = remark2tagged(MD, ['extra'], Infinity, 'pin|x')
    expect(rows.map((r) => [r.txt, r.type, r.ref])).toEqual([
      ['# h1 alpha #tag1\n', 'heading', 'heading_2'],
      ['\npara one with [a link](https://e.com/x) and `inline code`.\n', 'paragraph', 'paragraph_4'],
      ['\n## h2 beta #tag2\n', 'heading', 'heading_11'],
      ['\n> quoted line\n', 'blockquote', 'blockquote_13'],
      ['\n```ts\nconst a = 1\n```\n', 'code', 'code_16_const-a-1'],
      ['\n- item one\n', 'paragraph', 'paragraph_19'],
      ['  - nested item\n', 'paragraph', 'paragraph_23'],
      ['- item two\n', 'paragraph', 'paragraph_26'],
      ['\n---\n', 'thematicBreak', 'thematicBreak_28'],
      ['\n| a | b |\n| - | - |\n| 1 | 2 |\n', 'paragraph', 'paragraph_29'],
      ['\n<div>raw html</div>\n', 'html', 'html_31_div-raw-html-div'],
      ['\nLast para.\n', 'paragraph', 'paragraph_32'],
    ])
  })

  it('records the offsets a reconstruction and a locate both need', () => {
    const rows = remark2tagged(MD, ['extra'], Infinity, 'pin|x')
    expect(rows.map((r) => [r.rec.seq, r.rec.start, r.rec.serial])).toEqual([
      [0, 2, 2], [17, 0, 4], [77, 3, 11], [95, 2, 13], [110, 0, 16], [133, 2, 19],
      [145, 4, 23], [161, 2, 26], [172, 0, 28], [177, 0, 29], [208, 0, 31], [229, 0, 32],
    ])
    expect(rows[4].rec.lang).toBe('ts')
    expect(rows[4].rec.value).toBe('const a = 1')
    expect(rows[0].rec.depth).toBe(1)
    expect(rows[2].rec.depth).toBe(2)
  })

  it('tags rows with the block that owns them', () => {
    const rows = remark2tagged(MD, ['extra'])
    // The builder emits `das`, not `Da.tags`; `tap.tsx` stores these rows as-is, so
    // the mismatch is asserted here rather than silently corrected.
    expect(rows.map((r) => (r as unknown as { das: string[] }).das)).toEqual([
      ['heading', 'root_1', 'extra'],
      ['paragraph', 'root_1', 'extra'],
      ['heading', 'root_1', 'extra'],
      ['blockquote', 'root_1', 'extra'],
      ['code', 'ts', 'root_1', 'extra'],
      ['paragraph', 'listItem_18', 'extra'],
      ['paragraph', 'listItem_22', 'extra'],
      ['paragraph', 'listItem_25', 'extra'],
      ['thematicBreak', 'root_1', 'extra'],
      ['paragraph', 'root_1', 'extra'],
      ['html', 'root_1', 'extra'],
      ['paragraph', 'root_1', 'extra'],
    ])
  })

  it('joins the rows back into the source', () => {
    const rows = remark2tagged(MD, [])
    expect(reconstruct(rows)).toBe(MD)
  })

  it('stops at maxDepth and marks the cut container', () => {
    const rows = remark2tagged(MD, [], 2, 'pin|y')
    expect(rows.map((r) => [r.txt, r.type])).toEqual([
      ['# h1 alpha #tag1\n', 'heading'],
      ['\npara one with [a link](https://e.com/x) and `inline code`.\n', 'paragraph'],
      ['\n## h2 beta #tag2\n', 'heading'],
      ['\n> quoted line\n', 'blockquote'],
      ['\n```ts\nconst a = 1\n```\n', 'code'],
      ['\n- item one\n  - nested item\n', 'md'],
      ['- item two\n', 'md'],
      ['\n---\n', 'thematicBreak'],
      ['\n| a | b |\n| - | - |\n| 1 | 2 |\n', 'paragraph'],
      ['\n<div>raw html</div>\n', 'html'],
      ['\nLast para.\n', 'paragraph'],
    ])
  })

  it('returns the whole text as one row at maxDepth 0', () => {
    const rows = remark2tagged(MD, ['extra'], 0, 'pin|z')
    expect(rows).toHaveLength(1)
    expect(rows[0].ref).toBe('pin|z')
    expect(rows[0].txt).toBe(MD)
  })
})

describe('md2tag', () => {
  it('keeps one row per slice it always produced', () => {
    const rows = md2tag(MD)
    expect(rows).toHaveLength(12)
    expect(rows.map((r) => r.txt)).toEqual([
      '# h1 alpha #tag1',
      '\n\npara one with ',
      '[a link](https://e.com/x) and `inline code`.',
      '\n\n## h2 beta #tag2',
      '\n\n> quoted line',
      '\n\n```ts\nconst a = 1\n```',
      '\n\n- item one',
      '\n  - nested item',
      '\n- item two',
      '\n\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |',
      '\n\n<div>raw html</div>',
      '\n\nLast para.',
    ])
  })
})
