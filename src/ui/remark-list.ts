import { markdownTree, type MdNode } from '../mdTree'
import { Da } from '../sdb'

export const reconstruct = (rows: Da[]) =>
  rows.sort((a, b) => a.rec.seq - b.rec.seq).map(r => r.txt).join('')

/** node array with rec.seq for **reconstruct** back to markdown
 * ignore/grouped type=text leaves into meaningful parents
 * node extracted till maxDepth, lump anything beyond as type:md node
 * recursive further extraction consistent/joinable to existing tree
 */
export function remark2tagged(mdText: string, sts2add: string[] = []
  , maxDepth = Infinity, pathRef=''): Da[] {
  const tree = markdownTree(mdText) as unknown as MdNode
  let serial = 0

  // 1. Assign metadata (uid, serial, parent pointer) recursively
  const assignMeta = (node: any, currentDepth: number, parentNode: any = null) => {
    const rawContent = node.value || node.title || node.alt || '';
    const slug = rawContent.toLowerCase().match(
      /[\p{L}\p{N}]+/gu)?.join('-').slice(0, 22);
    node.uid = `${node.type}_${++serial}${slug ? '_' + slug : ''}`;
    node.serial = serial;
    node.treeDepth = currentDepth;
    node.parent = parentNode; // Retain parent for robust upward climbing

    if (node.children) {
      node.children.forEach((child: any) => assignMeta(child, currentDepth + 1, node));
    }
  }
  // Remove parent pointers from nodes to avoid circularity during serialization
  const stripParents = (node: any) => {
    if (node.parent) {
      node.parent_uid = node.parent.uid;
    }
    delete node.parent;
    if (node.children) {
      node.children.forEach((child: any) => stripParents(child));
    }
  };
  assignMeta(tree, 0, null);
  stripParents(tree);


  if (maxDepth === 0) {
    return [{
      txt: mdText,
      type: 'md',
      ref: pathRef,
      tags: ['md', ...sts2add],
      rec: { seq: 0, start: 0, serial: 0, node: tree }
    }];
  }

  // 2. Identify leaves / terminal blocks while respecting maxDepth boundaries
  const leaves: { node: any; parent: any }[] = []
  
  const collectLeaves = (node: any, parent: any) => {
    // SIMPLIFIED HERE: Added 'paragraph' to stop internal text node slicing
    const isTerminalBlock = ['paragraph', 'heading', 'link', 'blockquote', 'html', 'inlineCode'].includes(node.type);
    const reachedMaxDepth = node.treeDepth >= maxDepth;

    // Stop flattening if it's an inherent terminal block, has no children, OR maxDepth is reached
    if ((isTerminalBlock || reachedMaxDepth || !node.children?.length) && node.position) {
      if (reachedMaxDepth && !isTerminalBlock && node.children?.length) {
        node.isForcedMd = true; // Flag container nodes cut short by maxDepth
      }
      leaves.push({ node, parent });
      return;
    }

    if (node.children) {
      node.children.forEach((child: any) => collectLeaves(child, node));
    }
  }
  
  // Start collection from root's children to maintain top-level element structuring
  if (tree.children) {
    tree.children.forEach((child: any) => collectLeaves(child, tree));
  }

  // 3. Flat mapping using clean cursor logic
  let cursor = 0; 
  return leaves.map(({ node, parent }, i) => {
    const start = cursor
    const next = leaves[i + 1]
    const eol = mdText.indexOf('\n', node.position.end.offset);
    const end = eol >= 0 ? eol + 1 : mdText.length;
    cursor = end 

    const url = node.url || parent?.url;
    const lang = node.lang || parent?.lang;
    const depth = node.depth ?? parent?.depth;

    const nodeType = node.isForcedMd ? 'md' : node.type;

    const fallbackRef = ['html', 'link', 'blockquote', 'inlineCode'].includes(node.type)
      ? node.type
      : (parent?.type === 'paragraph' && parent?.parent ? parent.parent.type : parent?.type);

// Compute the exact 0-indexed offset from the start of the line to the content node start
    const contentOffset = (node.children?.[0] ?? node).position.start.offset;
    const lineStart = mdText.lastIndexOf('\n', contentOffset - 1) + 1;
    const recStart = contentOffset - lineStart;

    return { 
      txt: mdText.slice(start, end), 
      type: nodeType,
      ref: node.uid,
      das: [nodeType, lang, parent?.uid].filter(Boolean).concat(sts2add), 
      rec: { 
        seq: start, 
        start: recStart, // Added as requested
        fallbackRef, url, lang, depth,
        serial: node.serial, value: node.value, node 
      } 
    }
  })
}

/**
 * Expands a special 'md' type Tag into an array of child das up to an arbitrary relative depth.
 */
export function mdExpand(inputDa: Da, sts2add: string[] = [], maxDepth = Infinity): Da[] {
  // Guard clause: Only expand da explicitly marked as special 'md' content blocks
  if (inputDa.type !== 'md') {
    return [inputDa];
  }

  // Combine the parent's statuses with any newly provided target statuses
  const combinedSts = Array.from(new Set([...(inputDa.tags || []), ...sts2add]));

  // Parse and segment the internal markdown fragment up to the designated maxDepth boundary
  const baseSeq = inputDa.rec.seq as number;
  return remark2tagged(inputDa.txt, combinedSts, maxDepth).map(t => ({
    ...t,
    rec: { ...t.rec, seq: (t.rec.seq as number) + baseSeq }
  }));
}
export function mdCollapse(das: Da[]): Da[] {
  const depthCache = new Map<any, number>();
  const getDepth = (node: any): number => {
    if (!node) return 0;
    if (!depthCache.has(node)) depthCache.set(node, 1 + getDepth(node.parent));
    return depthCache.get(node)!;
  };

  let current = [...das];
  const maxDepth = Math.max(...current.map(t => getDepth((t.rec.node as any)?.parent)), 0);

  for (let d = maxDepth; d > 0; d--) {
    const next: Da[] = [];
    
    for (let i = 0; i < current.length; ) {
      const parent = (current[i].rec.node as any)?.parent;

      if (!parent || getDepth(parent) !== d) {
        next.push(current[i++]);
        continue;
      }

      // Group consecutive siblings at the target depth
      const group: Da[] = [];
      while (i < current.length && (current[i].rec.node as any)?.parent?.uid === parent.uid) {
        group.push(current[i++]);
      }

      // Collapse child group into parent
      next.push({
        txt: reconstruct(group),
        type: 'md',
        ref: parent.uid,
        tags: ['md'],
        rec: { seq: group[0].rec.seq, start: group[0].rec.start, node: parent }
      });
    }
    current = next;
  }

  return current;
}



export function shiftHierarchy(das: Da[], range: [number, number], options: { 
  deltaIndent?: number, 
  deltaHeader?: number, 
  deltaQuote?: number 
}): Da[] {
  return das.map((tag, i) => {
    if (i < range[0] || i >= range[1]) return tag;
    
    let txt = tag.txt;
    const lines = txt.split('\n');

    if (options.deltaIndent !== undefined) {
      const delta = options.deltaIndent;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '') continue;
        if (delta > 0) {
          lines[i] = ' '.repeat(delta) + lines[i];
        } else if (delta < 0) {
          const lead = lines[i].length - lines[i].trimStart().length;
          const strip = Math.min(Math.abs(delta), lead);
          lines[i] = ' '.repeat(lead - strip) + lines[i].trimStart();
        }
      }
    }

    if (options.deltaHeader !== undefined && tag.type === 'heading') {
      const firstLine = lines[0];
      const match = firstLine.match(/^(#+)\s+/);
      if (match) {
        const newLevel = Math.max(1, Math.min(6, match[1].length + options.deltaHeader));
        lines[0] = '#'.repeat(newLevel) + ' ' + firstLine.slice(match[0].length);
      }
    }

    if (options.deltaQuote !== undefined) {
      lines.forEach(line => {
        if (options.deltaQuote > 0) {
          line = '>' + line;
        } else if (options.deltaQuote < 0) {
          if (line.startsWith('>')) line = line.slice(1);
        }
      });
    }

    return { ...tag, txt: lines.join('\n') };
  });
}