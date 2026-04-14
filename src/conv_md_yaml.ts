import { remark } from 'remark'
import { visit } from 'unist-util-visit'
import type { Node, Parent } from 'unist'
import YAML from 'yaml'

/** Convert YAML to markdown list format */
export function yaml2md(yamlText: string): string {
  const obj = YAML.parse(yamlText)
  const toMd = (v: any, indent = 0): string => {
    const pad = '  '.repeat(indent)
    if (Array.isArray(v)) return v.map(i => toMd(i, indent)).join('\n')
    if (typeof v === 'object' && v) return Object.entries(v).map(([k, val]) => 
      typeof val === 'object' && val ? `${pad}- **${k}**: \n` + toMd(val, indent + 1) : `${pad}- **${k}**: ${val}`
    ).join('\n')
    return `${pad}- ${v}`
  }
  return toMd(obj)
}

export function md2row(mdText: string) {
  // Detect YAML and convert to markdown list format
  // const isYaml = !mdText.trim().startsWith('#') && 
  //                !mdText.trim().startsWith('<') &&
  //                !mdText.includes('===') &&
  //                mdText.split('\n').some(l => l.match(/^\s*-\s+/) || l.match(/^\s*[\w-]+:\s*/))
  const text = mdText // isYaml ? yaml2md(mdText) : mdText
  
  const tree = remark().parse(text)
  const leaves: any[] = []
  let serial = 0
  const uid = (type: string) => `${type}_${(++serial).toString(36)}`

  let prevEnd = 0
  visit(tree, (node: any, _index, parent: any) => {
    // console.debug(node)
    const inlineNode = node.type==='link'
    if (prevEnd < node.position?.end.offset 
      && (node.value || inlineNode) )
      leaves.push({ node, parent, start: prevEnd, end:(prevEnd = 
        parent.position?.end.offset + inlineNode ?  0
        : (parent.type=='strong'? 2 :0))
        , ref: ['html','link','blockquote','inlineCode'].includes(node.type)? node.type
        : parent.type==='paragraph' && parent.parent ? parent.parent.type: parent.type
        })

    // if (!node.children?.length && node.position)
    //   leaves.push({ node, parent })
  })

  return leaves.map(({ node, parent, start, end, ref }, i) => {
    // console.debug('node:',node,'parent.parent:',parent.parent)
    const id = uid(node.type)
    const tags = [
      `#${node.type};${id}`,
      `#ref=${ref}`,
      `#seq=${start}`,
      `#parent=${parent?.type ?? 'root'}`,
    ]
    if (node.value)      tags.push(`#val=${node.value}`)
    if (node.url)        tags.push(`#meta=url:${node.url}`)
    if (node.lang)       tags.push(`#meta=lang:${node.lang}`)
    if ('depth' in node) tags.push(`#meta=level:${node.depth}`)

    return { ref, tags, seg: text.slice(start, end), start, type:'md' }
  })
}

// ── Reconstruction ────────────────────────────────────────────
// Sort by start offset, join segs.  That's it.

export const row2md = (rows: any[]) =>
  rows.sort((a, b) => a.start - b.start).map(r => r.seg).join('')
// export function row2md(rows: FlatNode[]): string {
//   return rows
//     .slice()
//     .sort((a, b) => a.start - b.start)
//     .map(n => n.seg)
//     .join('')
// }

// ── Helpers ───────────────────────────────────────────────────
function getDepth(node: any, parent: any): number {
  let d = 0, p = parent
  while (p) { d++; p = p.parent }
  return d
}
