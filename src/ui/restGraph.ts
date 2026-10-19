/**
 * restGraph.ts — the tag graph the rest list reads itself with.
 *
 * The rest list is a set of rows plus the tags a pass kept for them; the graph is
 * the same evidence read as one object. Nodes are tags, an edge joins two tags one
 * row's chip list holds together, and a node's radius is how many scored rows kept
 * it. The pin cards' `#tag` headings root the arrangement.
 *
 * A node's kind says which part of the pass it came from: a `pinned` tag, a `head`
 * (the tag a row was filed under, so the block it appears in), a promoted `theme`
 * (`head/term`, minted by the bucket stage) or an `own` chip that heads nothing and
 * refines nothing.
 *
 * What makes this the `qarf` reading rather than any pass's is the share a node
 * carries: the mean lexical split of the rows that kept it. `qarf` fuses each row
 * with a channel split that follows its own specificity, so a node the rare-token
 * rows kept was carried by the exact lexical lists (`bm25`, the trie) and one the
 * paraphrastic rows kept by the neighbour walks. A fixed-weighting pass leaves every
 * share unset and the reading is the structure alone.
 *
 * Nothing here touches the DOM: the geometry is a pure function of the graph, so it
 * is testable on its own and a second renderer costs no new reasoning.
 */

import { TAG_DEL, pinPriorityTags, type RowTagReport } from '../srctag';
import { isProvenanceTag, termSimilarity } from '../rstag';
import type { Da } from '../sdb';

/** Rows a pass scored, keyed by `tid`, as `restProfileMap` returns them. */
export type GraphReports = Map<number, RowTagReport>;

/** Nodes kept, widest first; the roots and a root's neighbours always survive. */
export const GRAPH_MAX_NODES = 220;

/** The graph's own default, kept as the local name the layout reads. */
const MAX_NODES = GRAPH_MAX_NODES;

/** Neighbours one node keeps, strongest first. */
const MAX_NEIGHBORS = 24;

/** Tags one row contributes; a markdown card can carry hundreds. */
const MAX_ROW_TAGS = 24;

/** Two tags at or above this bigram similarity are one node. */
const MERGE_SIM = 0.92;

/**
 * What part of the pass a node came from: the curated half, the tag a row was
 * filed under, a sub-tag the bucket stage minted, or a chip that is neither.
 */
export type GraphNodeKind = 'pinned' | 'head' | 'theme' | 'own';

/**
 * How far a node is from the curated half: a pin's own heading, a spelling of one,
 * one co-occurrence step out, two steps, or nothing a pin reaches.
 *
 * This is the other reading of the same graph. `GraphNodeKind` asks what the pass
 * *did* with a tag; this asks what a reader sees when the pins are the axes — which
 * is what a table with several tags per row is read by.
 */
export type GraphReach = 'pinned' | 'alias' | 'related' | 'remote' | 'own';

/** Either taxonomy a graph can be read in. */
export type AnyNodeKind = GraphNodeKind | GraphReach;

/** The marker, name and one-line explanation of each kind, for a legend and a hover. */
export const GRAPH_NODE_KIND: Record<GraphNodeKind, { mark: string; label: string; help: string }> = {
  pinned: {
    mark: '✓', label: 'pinned tag',
    help: 'a tag a pin card heads: the curated half the graph is rooted at',
  },
  head: {
    mark: '◉', label: 'cluster head',
    help: 'a tag a scored row ranks first: the block that row is filed under',
  },
  theme: {
    mark: '◇', label: 'promoted theme',
    help: 'a sub-tag the bucket stage minted, `head/term`, for a term a burst shares',
  },
  own: {
    mark: '○', label: 'kept chip',
    help: 'a tag a row kept that heads no row and refines none',
  },
};

/** The marker, name and one-line explanation of each reach, for a legend and a hover. */
export const GRAPH_REACH: Record<GraphReach, { mark: string; label: string; help: string }> = {
  pinned: {
    mark: '✓', label: 'pinned tag',
    help: 'a tag a pin card heads: the curated half the reading is rooted at',
  },
  alias: {
    mark: '≈', label: 'pin alias',
    help: 'a spelling or synonym of a pinned tag, kept as its own node so the table spelling the same tag two ways is visible rather than folded away',
  },
  related: {
    mark: '◉', label: 'related tag',
    help: 'a tag the seed rows hold beside a pinned one, so it is one step from a pin',
  },
  remote: {
    mark: '◌', label: 'remote tag',
    help: 'a tag two steps from a pin, through a tag that is itself related',
  },
  own: {
    mark: '○', label: 'own cluster',
    help: 'a tag no pin reaches: its own cluster over the seed rows',
  },
};

/** Rings the pin reading places each reach on: the curated half at the centre. */
export const REACH_RING: Record<GraphReach, number> = {
  pinned: 0, alias: 0.3, related: 0.62, remote: 0.86, own: 1,
};

/** A tag graph: symmetric weighted edges, the pinned roots, and what each node is. */
export interface TagGraph {
  /** Pinned `#tag` headings the layout is arranged around. */
  roots: Set<string>;
  /** Node → the weight of every tag it was seen beside. */
  edges: Map<string, Map<string, number>>;
  /** Node → scored rows that kept it. */
  weight: Map<string, number>;
  /** Canonical node of a tag, so a heading in any case or spacing finds its node. */
  name: (tag: string) => string;
  /** What each node came from. */
  kind: Map<string, GraphNodeKind>;
  /** A promoted theme's anchor, so the layout can nest it under its head. */
  anchor: Map<string, string>;
  /** Node → the tag it is a spelling of, when it was kept apart as an alias. */
  alias: Map<string, string>;
  /** Node → mean lexical share of the rows that kept it; empty on a fixed pass. */
  lambda: Map<string, number>;
  /** Nodes that survived the cap, when the caller asked for a trace. */
  kept?: Set<string>;
  /** Explicit alias -> canonical tag, when the caller supplied a resolver. */
  folded?: Map<string, string>;
  /** Natural spelling variants merged by {@link nodeNamer}, for a trace. */
  merged?: Map<string, string>;
}

/**
 * A tag's comparison form: lowercased with separators and punctuation dropped, so
 * `DeepSeek-V3`, `deepseek v3` and `deepseek_v3` are one node. The raw text is kept
 * when nothing is left, so a tag that is entirely punctuation still names itself.
 *
 * @param tag any tag
 * @returns the form two tags are compared in
 */
const normTag = (tag: string): string =>
  tag.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') || tag.toLowerCase();

/** One node's display text and comparison form. */
interface NodeName {
  display: string;
  norm: string;
}

/**
 * Canonical names for the tags a graph is built over: a variant at or above
 * `MERGE_SIM` of a node already held joins that node, so `deepseek` and `DeepSeek`
 * are one node rather than two. Candidates are filtered by first character and
 * length before the bigram comparison, which is what keeps the merge linear.
 *
 * With `keepAliases` a variant that names a *pinned* tag keeps its own node and is
 * reported through `alias` instead of being folded in, because a table that spells
 * one curated tag two ways is saying something about itself that a single node
 * hides. Every other variant still merges.
 *
 * @param roots pinned tags, whose display text wins a merge against a later variant
 * @param keepAliases whether a pin's variants become nodes of their own
 * @param fold an explicit alias resolver, applied before the spelling comparison
 * @returns a function naming a tag, and the alias/merge relations it recorded
 */
function nodeNamer(roots: string[], keepAliases = false, fold?: (tag: string) => string): {
  name: (tag: string) => string;
  alias: Map<string, string>;
  folded: Map<string, string>;
  merged: Map<string, string>;
} {
  const byHead = new Map<string, NodeName[]>();
  const canon = new Map<string, string>();
  const alias = new Map<string, string>();
  const folded = new Map<string, string>();
  const merged = new Map<string, string>();
  const add = (display: string, norm: string) => {
    const head = norm.slice(0, 1);
    const list = byHead.get(head);
    if (list) list.push({ display, norm });
    else byHead.set(head, [{ display, norm }]);
  };
  const foldTag = (tag: string): string => {
    const display = fold?.(tag) ?? tag;
    if (display !== tag) folded.set(tag, display);
    return display;
  };
  const rootNames = roots.map(foldTag);
  for (const display of rootNames) {
    canon.set(normTag(display), display);
    add(display, normTag(display));
  }

  return {
    alias, folded, merged,
    name: (tag: string): string => {
      const display = foldTag(tag);
      const norm = normTag(display);
      const held = canon.get(norm);
      if (held) {
        if (!keepAliases || held === display) {
          if (display !== held) merged.set(display, held);
          return held;
        }
        alias.set(display, held);
        add(display, norm);
        return display;
      }
      const near = (byHead.get(norm.slice(0, 1)) ?? [])
        .filter((n) => Math.abs(n.norm.length - norm.length) <= 2);
      for (const n of near) {
        if (termSimilarity(n.norm, norm) < MERGE_SIM) continue;
        if (keepAliases && rootNames.includes(n.display)) {
          canon.set(norm, display);
          alias.set(display, n.display);
          add(display, norm);
          return display;
        }
        canon.set(norm, n.display);
        merged.set(display, n.display);
        return n.display;
      }
      canon.set(norm, display);
      add(display, norm);
      return display;
    },
  };
}

/** Which kind wins when one tag is several of them on different rows. */
const KIND_RANK: Record<GraphNodeKind, number> = { pinned: 3, head: 2, theme: 1, own: 0 };

/**
 * A row's own heading tags: what the row is filed under, minus the board marker,
 * the tombstone and the capture provenance — none of which is a topic.
 *
 * @param row any row
 * @returns the heading tags, deduped, in row order
 */
export function headingTags(row: Da): string[] {
  const out: string[] = [];
  for (const t of row.tags ?? []) {
    if (t === 'pin' || t === TAG_DEL || isProvenanceTag(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Build the tag graph over the rows a pass scored.
 *
 * A row contributes its own heading tags and the tags the pass kept for it, so the
 * graph holds both what the rows are filed under and what the pass read into them.
 * Two tags one row holds are adjacent by that co-occurrence, which is what lets a
 * node the pins never named still be read next to the ones they did.
 *
 * The graph is capped by node weight and by neighbours per node, so a deep window
 * cannot make the layout quadratic. Pins and their direct neighbours survive the
 * default cap whatever their weight; an explicit `maxNodes` trims the set
 * roots-first, which is what makes `maxGraph` a hard build bound.
 *
 * @param pins the pin cards, whose `#tag` headings are the roots
 * @param rows the rows the pass scored
 * @param reports the pass's reports over those rows, keyed by `tid`
 * @param opts `keepAliases` keeps a pin's variant spellings as their own nodes;
 *   `alias` folds explicit aliases before naming; `maxNodes` and `maxNeighbors`
 *   bound the build (the defaults are {@link GRAPH_MAX_NODES} and 24)
 * @returns the graph, ready for {@link tagGraphLayout}
 */
export function buildTagGraph(
  pins: Da[], rows: Da[], reports: GraphReports,
  opts: {
    keepAliases?: boolean;
    alias?: (tag: string) => string;
    maxNodes?: number;
    maxNeighbors?: number;
  } = {},
): TagGraph {
  const rawRoots = pinPriorityTags(pins);
  const roots = [...new Set(rawRoots.map((tag) => opts.alias?.(tag) ?? tag))];
  const { name, alias, folded, merged } = nodeNamer(rawRoots, opts.keepAliases === true, opts.alias);
  const maxNodes = Math.max(1, Math.round(opts.maxNodes ?? GRAPH_MAX_NODES));
  const maxNeighbors = Math.max(0, Math.round(opts.maxNeighbors ?? MAX_NEIGHBORS));
  const weight = new Map<string, number>();
  const edges = new Map<string, Map<string, number>>();
  const kind = new Map<string, GraphNodeKind>();
  const anchor = new Map<string, string>();
  const share = new Map<string, { sum: number; n: number }>();

  const mark = (tag: string, what: GraphNodeKind) => {
    /* A pin is the strongest statement about a tag, so it outranks what the pass read
       into it; a head outranks a theme, which is a refinement of one. */
    const held = kind.get(tag);
    if (held === undefined || KIND_RANK[what] > KIND_RANK[held]) kind.set(tag, what);
  };
  const link = (a: string, b: string) => {
    let out = edges.get(a);
    if (!out) {
      out = new Map();
      edges.set(a, out);
    }
    out.set(b, (out.get(b) ?? 0) + 1);
  };

  for (const row of rows) {
    const report = row.tid === undefined ? undefined : reports.get(row.tid);
    const tags = new Set<string>();
    for (const t of headingTags(row)) tags.add(name(t));
    /* The head is the tag the row is filed under and a theme is a refinement of the
       head it was minted under, so both are read off the report rather than guessed
       from the tag's shape. */
    const head = report?.tags[0];
    for (const t of report?.tags ?? []) {
      const node = name(t.tag);
      tags.add(node);
      if (t.tag === head?.tag) mark(node, 'head');
      else if (t.origin === 'sub') {
        mark(node, 'theme');
        const parent = t.tag.slice(0, t.tag.indexOf('/'));
        if (parent) anchor.set(node, name(parent));
      } else mark(node, 'own');
    }
    for (const t of roots) if (row.tags?.includes(t) === true) tags.add(name(t));

    const list = [...tags].slice(0, MAX_ROW_TAGS);
    for (const t of list) weight.set(t, (weight.get(t) ?? 0) + 1);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        link(list[i], list[j]);
        link(list[j], list[i]);
      }
    }
    /* The adaptive share is the row's, so a node reads the mean of the rows that
       kept it rather than the pass's own split. */
    if (report?.qarf !== undefined) {
      for (const t of list) {
        const held = share.get(t) ?? { sum: 0, n: 0 };
        share.set(t, { sum: held.sum + report.qarf, n: held.n + 1 });
      }
    }
  }
  for (const t of roots) {
    kind.set(name(t), 'pinned');
    weight.set(name(t), weight.get(name(t)) ?? 0);
  }

  const keep = new Set(roots);
  for (const r of roots) for (const n of edges.get(r)?.keys() ?? []) keep.add(n);
  const widest = [...weight.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  for (const t of widest) {
    if (keep.size >= maxNodes) break;
    keep.add(t);
  }
  /* A root's direct neighbours are added before the weighted tail, so a table
     with many pins can pass the cap through that door. An explicit bound trims
     the set to the roots first and the widest nodes after them. */
  if (opts.maxNodes !== undefined && keep.size > maxNodes) {
    const rootSet = new Set(roots);
    const ordered = [...keep].sort((a, b) =>
      (Number(rootSet.has(b)) - Number(rootSet.has(a)))
      || ((weight.get(b) ?? 0) - (weight.get(a) ?? 0))
      || a.localeCompare(b));
    keep.clear();
    for (const tag of ordered.slice(0, maxNodes)) keep.add(tag);
  }

  const trimmed = new Map<string, Map<string, number>>();
  for (const node of keep) {
    const near = [...(edges.get(node) ?? [])]
      .filter(([n]) => keep.has(n))
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxNeighbors);
    trimmed.set(node, new Map(near));
  }

  const lambda = new Map<string, number>();
  for (const [t, s] of share) if (s.n > 0) lambda.set(t, s.sum / s.n);

  return {
    roots: new Set(roots), edges: trimmed, weight, name, kind, anchor, alias, lambda,
    kept: keep, folded, merged,
  };
}

/**
 * How far each node is from the curated half: a pin's own heading, a spelling of
 * one, one co-occurrence step out, two steps, or nothing a pin reaches.
 *
 * A hop is counted through the same evidence the pass read, so a tag is `related`
 * when a seed row held it beside a pinned one and `remote` when the row between
 * them held a related tag rather than a pin. A node that reaches a pin *at all*
 * keeps the shortest route, which is what makes the reading a partition: every node
 * lands in exactly one band.
 *
 * @param graph a {@link TagGraph}
 * @returns one reach per node the graph holds
 */
export function pinReach(graph: TagGraph): Map<string, GraphReach> {
  const home = (tag: string): boolean => graph.roots.has(tag) || graph.alias.has(tag);
  const out = new Map<string, GraphReach>();
  for (const tag of graph.weight.keys()) {
    if (graph.roots.has(tag)) {
      out.set(tag, 'pinned');
      continue;
    }
    if (graph.alias.has(tag)) {
      out.set(tag, 'alias');
      continue;
    }
    const near = graph.edges.get(tag);
    if (!near) {
      out.set(tag, 'own');
      continue;
    }
    let best: GraphReach = 'own';
    for (const n of near.keys()) if (home(n)) { best = 'related'; break; }
    if (best === 'own') {
      for (const m of near.keys()) {
        for (const r of graph.edges.get(m)?.keys() ?? []) if (home(r)) { best = 'remote'; break; }
        if (best === 'remote') break;
      }
    }
    out.set(tag, best);
  }
  return out;
}

/** One node of the layout. */
export interface GraphNode {
  tag: string;
  kind: AnyNodeKind;
  /** Position in a [-1, 1] box, the pinned tags at the centre. */
  x: number;
  y: number;
  /** Radius in the same box, from the rows that kept the tag. */
  r: number;
  /** Scored rows that kept the tag. */
  rows: number;
  /** Mean lexical share of those rows; absent on a fixed-weighting pass. */
  lambda?: number;
}

/** One edge of the layout. */
export interface GraphEdge {
  a: string;
  b: string;
  w: number;
}

/** The layout: nodes in a unit box, the edges among them, and the weight scale. */
export interface TagGraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Heaviest edge kept, for a renderer's own scaling. */
  maxEdge: number;
  /** Heaviest node, for a renderer's own scaling. */
  maxRows: number;
}

/** Rings the layout places nodes on: pins innermost, a chip no head claims outermost. */
const RING: Record<GraphNodeKind, number> = { pinned: 0, head: 0.52, theme: 0.76, own: 1 };

/** The golden angle, so nodes with no head above them spread without landing on one ray. */
const SPREAD = 2.39996;

/**
 * Which taxonomy a layout is read in, and the knobs that go with it.
 *
 * The default is the pass's own kinds — what the pass did with a tag. The pin reading
 * passes {@link pinReach} with {@link REACH_RING}, which asks instead how far a tag is
 * from the curated half.
 */
export interface GraphLayoutOptions {
  /** What each node is. Defaults to the pass's own kinds. */
  kind?: (tag: string) => AnyNodeKind;
  /** Ring each kind sits on, pins innermost. Defaults to the pass's own rings. */
  ring?: Record<string, number>;
  /** Nodes to keep, widest first. */
  maxNodes?: number;
}

/**
 * Lay the tag graph out in a unit box.
 *
 * The reading is radial and rooted: a pinned tag sits at the centre, the tags a row
 * was filed under share a ring around it, promoted themes sit between their head and
 * the outer ring, and a chip no head claims takes the outermost one. Each pin owns
 * an angular sector, so a pin's neighbourhood reads as one wedge however the ring
 * fills up, and a promoted theme inherits its anchor's angle so it reads as that
 * anchor's refinement rather than as a tag beside it.
 *
 * @param graph a {@link TagGraph}
 * @param opts the taxonomy to read it in, and the ring each kind sits on
 * @returns the nodes and the edges among them
 */
export function tagGraphLayout(graph: TagGraph, opts: GraphLayoutOptions = {}): TagGraphLayout {
  const maxNodes = opts.maxNodes ?? MAX_NODES;
  const ring = opts.ring ?? RING;
  const kindOf = opts.kind
    ?? ((tag: string): AnyNodeKind => graph.kind.get(tag) ?? (graph.roots.has(tag) ? 'pinned' : 'own'));
  const keep = [...graph.weight.keys()]
    .sort((a, b) => (Number(graph.roots.has(b)) - Number(graph.roots.has(a)))
      || ((graph.weight.get(b) ?? 0) - (graph.weight.get(a) ?? 0))
      || a.localeCompare(b))
    .slice(0, maxNodes);
  const held = new Set(keep);
  const maxRows = Math.max(1, ...keep.map((t) => graph.weight.get(t) ?? 0));

  const roots = keep.filter((t) => graph.roots.has(t));
  const sector = new Map<string, { from: number; to: number }>();
  roots.forEach((r, i) => sector.set(r, {
    from: (i / Math.max(1, roots.length)) * Math.PI * 2,
    to: ((i + 1) / Math.max(1, roots.length)) * Math.PI * 2,
  }));

  /* The pin a node reads under: the root it is adjacent to by the heaviest edge, so
     a node two pins both reach lands in the wedge of the stronger claim. */
  const pinOf = (tag: string): string | undefined => {
    let best: string | undefined;
    let bestScore = -1;
    for (const [n, w] of graph.edges.get(tag) ?? []) {
      if (graph.roots.has(n) && held.has(n) && w > bestScore) {
        best = n;
        bestScore = w;
      }
    }
    return best;
  };
  const headOf = (tag: string): string | undefined => {
    const a = graph.anchor.get(tag);
    return a === undefined ? undefined : graph.name(a);
  };

  const used = new Map<string, number>();
  const angleFor = (tag: string, parent: string | undefined): number => {
    const n = used.get(parent ?? '') ?? 0;
    used.set(parent ?? '', n + 1);
    const sec = parent === undefined ? undefined : sector.get(parent);
    if (sec) {
      const siblings = keep.filter((t) => pinOf(t) === parent).length;
      const share = (sec.to - sec.from) / Math.max(1, siblings);
      return sec.from + share * (n + 0.5);
    }
    return n * SPREAD;
  };

  /* Two passes, because an anchored node is placed from its anchor's angle rather than
     from a slot of its own — which is what makes a refinement read as one with the chip
     it refines instead of as another tag beside it. Anchoring is a property of the
     graph, not of the taxonomy it is read in. */
  const placed = keep.filter((t) => !graph.anchor.has(t));
  const angle = new Map<string, number>();
  for (const tag of placed) {
    angle.set(tag, angleFor(tag, graph.roots.has(tag) ? undefined : pinOf(tag)));
  }
  const anchoredOff = new Map<string, number>();
  for (const tag of keep) {
    if (!graph.anchor.has(tag)) continue;
    const head = headOf(tag) ?? pinOf(tag);
    const n = anchoredOff.get(head ?? '') ?? 0;
    anchoredOff.set(head ?? '', n + 1);
    const base = (head === undefined ? undefined : angle.get(head)) ?? angleFor(tag, head);
    angle.set(tag, base + 0.16 * (n + 1));
  }

  const nodes: GraphNode[] = [];
  for (const tag of keep) {
    const kind = kindOf(tag);
    const rows = graph.weight.get(tag) ?? 0;
    const a = angle.get(tag) ?? 0;
    const radius = ring[kind] ?? 1;
    const lambda = graph.lambda.get(tag);
    nodes.push({
      tag, kind, rows,
      x: Math.cos(a) * radius,
      y: Math.sin(a) * radius,
      r: 0.02 + 0.06 * Math.sqrt(rows / maxRows),
      ...(lambda === undefined ? {} : { lambda }),
    });
  }

  const edges: GraphEdge[] = [];
  let maxEdge = 1;
  for (const [a, near] of graph.edges) {
    if (!held.has(a)) continue;
    for (const [b, w] of near) {
      if (!held.has(b) || a.localeCompare(b) > 0) continue;
      edges.push({ a, b, w });
      if (w > maxEdge) maxEdge = w;
    }
  }
  return { nodes, edges, maxEdge, maxRows };
}
