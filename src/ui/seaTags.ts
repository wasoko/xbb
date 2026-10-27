/**
 * seaTags.ts — the sea's tag data: the generated taxonomy table cached in `db.bins`, the
 * overridable `## Mapping` relations, and the rows a tag was kept by.
 *
 * The table is the durable reading of the seed: one row per tag, with its reach, kind, score,
 * weight, lexical share and channel. It is read without touching the row table, so the world
 * opens on the last reading while `loadPinGraph` re-reads the newest rows. The mapping is the
 * part a reader edits in `star.tagger.md`; `starTaggerRun` writes it once and only `reset`
 * rebuilds it.
 *
 * The rows themselves stay in `db.das`; `seaRowsByTag` folds the seed's reports into the same
 * canonical tag names the table uses. A row is a link when its ref is an address and an editor
 * jump otherwise, which is the split the app's own row boxes make.
 */

import { daStamp, type Da } from '../sdb';
import { isProvenanceTag } from '../rstag';
import { pinHeadingRows } from '../srctag';
import type { PinGraphSeed } from './seaPinGraph';
import { recentStamp } from './seaTrend';
import {
  GRAPH_NODE_KIND, GRAPH_REACH, headingTags, pinReach, type AnyNodeKind, type GraphNodeKind,
  type GraphReach, type TagGraph,
} from './restGraph';

/** One tag of the taxonomy table. */
export interface SeaTag {
  tag: string;
  reach: GraphReach;
  kind: GraphNodeKind;
  score: number;
  /** Distinct scored rows that kept the tag. */
  weight: number;
  /** Raw occurrences in headings and report entries. */
  freq: number;
  lambda?: number;
  burst?: number;
  top?: string;
  /** Rows in the trend pass's recent head that kept it. */
  recent?: number;
  /** Rows in the trend pass's older tail that kept it. */
  base?: number;
  /** Recent rate over older rate. */
  lift?: number;
  /** Non-zero when the tag emerged from the recent head. */
  trend?: number;
}

/** Where a row's click goes. */
export type SeaAction = 'link' | 'editor';

/** One row a tag was kept by, cropped for a block. */
export interface SeaRow {
  /** Identity of the row's text and ref, for the atlas and for React keys. */
  key: string;
  ref: string;
  /** The row's whole text, one line; the hover card shows it in a tooltip. */
  text: string;
  label: string;
  action: SeaAction;
  type: string;
  /** Newest visit time, or the later of `dt` and `modAt`, in epoch ms. */
  stamp?: number;
}

/** One pin card as the wall's band reads it: its top level heading columns and its date. */
export interface SeaPin {
  /** The card's row ref, which keeps two cards' columns apart. */
  ref: string;
  /** Tags each top level heading names, in card order; one heading is one column. */
  columns: string[][];
  /**
   * Tags named by the next heading level under each column, aligned with `columns`.
   * Absent when the card has no lower heading level; an empty list means that column
   * has no children.
   */
  children?: string[][];
  /** The card's effective update time, the later of its `dt` and `modAt`, in epoch ms. */
  stamp: number;
}

/** Characters a row's title keeps in a block; the hover card holds the whole text. */
export const ROW_CROP = 44;

/** Characters a tag's own name keeps in a block. */
export const TAG_CROP = 32;

/** Row types that open in the editor rather than as a link. */
const EDITOR_TYPES = new Set(['md', 'src']);

/**
 * A row's text with its line breaks folded and its tail cut.
 *
 * @param text the row's text, or its ref
 * @param max characters to keep
 * @returns one line, with an ellipsis when the tail was cut
 */
export function cropText(text: string, max: number): string {
  const one = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * The action a row's click takes.
 *
 * @param da the row
 * @returns `editor` for a document row and for any ref that is not an address, `link`
 *          otherwise
 */
export function rowAction(da: Da): SeaAction {
  return EDITOR_TYPES.has(da.type) || !/^https?:\/\//i.test(da.ref) ? 'editor' : 'link';
}

/**
 * A row as a block shows it.
 *
 * @param da the row
 * @returns the row's cropped label, its ref, and where its click goes
 */
export function seaRowOf(da: Da): SeaRow {
  return {
    key: `${da.ref}\u0000${da.txt}`,
    ref: da.ref,
    text: cropText(da.txt || da.ref, 400),
    label: cropText(da.txt || da.ref, ROW_CROP),
    action: rowAction(da),
    type: da.type,
    stamp: recentStamp(da),
  };
}

/** A number cell of the table; `-` and an empty cell are absent. */
function num(cell: string | undefined): number | undefined {
  if (cell === undefined || cell === '' || cell === '-') return undefined;
  const n = Number.parseFloat(cell);
  return Number.isFinite(n) ? n : undefined;
}

/** The cells of one Markdown table line, honoring `\|` escapes. */
function cells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (body[i] === '|') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += body[i];
  }
  out.push(cur.trim());
  return out;
}

/** A cell read as one of the taxonomy's reach names. */
const reachOf = (cell: string | undefined): GraphReach =>
  (cell !== undefined && cell in GRAPH_REACH ? cell as GraphReach : 'own');

/** A cell read as one of the taxonomy's kind names. */
const kindOf = (cell: string | undefined): GraphNodeKind =>
  (cell !== undefined && cell in GRAPH_NODE_KIND ? cell as GraphNodeKind : 'own');

/**
 * Read the generated `## Taxonomy` table.
 *
 * The table is written by `starTaggerTrace.buildStarTaxonomy`; its header names the columns,
 * so a table written by an older build with a column fewer still parses by position. A row
 * that names no tag is skipped rather than invented.
 *
 * @param text the `## Taxonomy` section body, heading excluded
 * @returns the tags in the table's own order
 */
export function parseTaxonomy(text: string): SeaTag[] {
  const out: SeaTag[] = [];
  for (const line of text.split('\n')) {
    const raw = line.trim();
    if (!raw.startsWith('|')) continue;
    const parts = cells(raw);
    const tag = parts[0];
    if (tag === undefined || tag === '' || tag === 'tag') continue;
    if (/^:?-{2,}:?$/.test(tag)) continue;
    const lambda = num(parts[6]);
    const burst = num(parts[7]);
    const top = parts[8];
    const recent = num(parts[9]);
    const base = num(parts[10]);
    const lift = num(parts[11]);
    const trend = num(parts[12]);
    out.push({
      tag,
      reach: reachOf(parts[1]),
      kind: kindOf(parts[2]),
      score: num(parts[3]) ?? 0,
      weight: num(parts[4]) ?? num(parts[5]) ?? 0,
      freq: num(parts[5]) ?? 0,
      ...(lambda === undefined ? {} : { lambda }),
      ...(burst === undefined ? {} : { burst }),
      ...(top === undefined || top === '' || top === '-' ? {} : { top }),
      ...(recent === undefined ? {} : { recent }),
      ...(base === undefined ? {} : { base }),
      ...(lift === undefined ? {} : { lift }),
      ...(trend === undefined ? {} : { trend }),
    });
  }
  return out;
}

/** How far each node is from the pins, as the graph's own reading has it. */
const REACH_ORDER: Record<GraphReach, number> = {
  pinned: 0, alias: 1, related: 2, remote: 3, own: 4,
};

/**
 * The taxonomy a seed implies, for a `star.tagger.md` whose generated table is still empty.
 *
 * @param seed the pin reading
 * @returns the graph's tags, nearest the pins first and then widest
 */
export function seaTagsFromSeed(seed: PinGraphSeed): SeaTag[] {
  const reach = pinReach(seed.graph);
  const out: SeaTag[] = [];
  for (const [tag, weight] of seed.graph.weight) {
    const lambda = seed.graph.lambda.get(tag);
    const reading = seed.trend?.get(tag);
    out.push({
      tag,
      reach: reach.get(tag) ?? (seed.graph.roots.has(tag) ? 'pinned' : 'own'),
      kind: seed.graph.kind.get(tag) ?? 'own',
      score: 0,
      weight,
      freq: weight,
      ...(lambda === undefined ? {} : { lambda }),
      ...(reading === undefined ? {} : {
        recent: reading.recent, base: reading.base, lift: reading.lift,
        ...(reading.emerging ? { trend: reading.score } : {}),
      }),
    });
  }
  out.sort((a, b) => REACH_ORDER[a.reach] - REACH_ORDER[b.reach]
    || b.weight - a.weight || a.tag.localeCompare(b.tag));
  return out;
}

/**
 * The tags the world draws: the generated table when it has rows, the seed's graph otherwise.
 *
 * A provenance or maintenance tag (`dev_`, `suffix_`, `ref_`, `FIXME…`) is skipped whichever
 * source it came from, so a table written before the filter existed cannot draw one.
 *
 * @param taxonomy the parsed `## Taxonomy` table
 * @param seed the last pin reading, if one has landed
 * @returns the tags to draw
 */
export function seaTagPool(taxonomy: readonly SeaTag[], seed: PinGraphSeed | null): SeaTag[] {
  const held = taxonomy.length > 0 ? taxonomy as SeaTag[] : (seed === null ? [] : seaTagsFromSeed(seed));
  return held.filter((tag) => !isProvenanceTag(tag.tag));
}

/**
 * The pin cards as the wall's columns, newest first.
 *
 * A card's top level is the smallest heading level it uses — `#` when it has first level
 * headings, `##` when it starts at the second — because that is the level the card's own
 * structure reads at. Every heading line at that level is one column, and the tags it names
 * stack down that column, so a card that writes two tags in one heading keeps them together.
 * The next heading level below the top is the column's treemap: those tags are read as the
 * top heading's second level, and only that level is kept. Names are folded to the graph's
 * node names the way the roots were, and a tag an earlier line already named keeps that
 * line's column.
 *
 * @param pins the pin cards the seed read, in any order
 * @param graph the graph over that seed, for each heading's node name
 * @returns one entry per card that heads a rooted tag, newest first
 */
export function seaPinsOf(pins: readonly Da[], graph: TagGraph): SeaPin[] {
  const out: SeaPin[] = [];
  const topSeen = new Set<string>();
  const childSeen = new Set<string>();
  for (const pin of pins) {
    const rows = pinHeadingRows(pin.txt ?? '');
    if (rows.length === 0) continue;
    const top = Math.min(...rows.map((row) => row.level));
    const childLevel = rows.reduce((level, row) => (
      row.level > top ? Math.min(level, row.level) : level), Number.POSITIVE_INFINITY);
    const columns: string[][] = [];
    const children: string[][] = [];
    let current = -1;
    for (const row of rows) {
      if (row.level === top) {
        const tags: string[] = [];
        for (const raw of row.tags) {
          const name = graph.name(raw);
          if (!graph.roots.has(name) || topSeen.has(name)) continue;
          topSeen.add(name);
          tags.push(name);
        }
        if (tags.length === 0) {
          current = -1;
          continue;
        }
        columns.push(tags);
        children.push([]);
        current = columns.length - 1;
        continue;
      }
      if (row.level !== childLevel || current < 0) continue;
      for (const raw of row.tags) {
        const name = graph.name(raw);
        if (topSeen.has(name) || childSeen.has(name)) continue;
        childSeen.add(name);
        children[current].push(name);
      }
    }
    if (columns.length === 0) continue;
    /* A tag that heads a later column is not also that column's sibling; drop it from the
       child lists after every top heading has been read. */
    const topAll = new Set(columns.flat());
    const kids = children.map((list) => list.filter((tag) => !topAll.has(tag)));
    out.push({
      ref: pin.ref, columns, stamp: daStamp(pin),
      ...(Number.isFinite(childLevel) ? { children: kids } : {}),
    });
  }
  /* A tag that heads any column anywhere is not a child of another card's column either. */
  const allTop = new Set(out.flatMap((card) => card.columns.flat()));
  for (const card of out) {
    if (card.children === undefined) continue;
    card.children = card.children.map((list) => list.filter((tag) => !allTop.has(tag)));
  }
  return out.sort((a, b) => b.stamp - a.stamp);
}

/**
 * The rows each tag was kept by, keyed by canonical tag name.
 *
 * Pin cards come first for the tags their headings name, so a pinned tag opens on the card
 * that curates it. Evidence rows follow in the seed's own newest-first order, and a row kept
 * by several tags appears under each of them.
 *
 * @param seed the pin reading
 * @returns one row list per tag; a tag no row kept is absent
 */
export function seaRowsByTag(seed: PinGraphSeed): Map<string, SeaRow[]> {
  const out = new Map<string, SeaRow[]>();
  const seen = new Set<string>();
  const add = (raw: string, da: Da): void => {
    const tag = seed.graph.name(raw);
    const row = seaRowOf(da);
    const key = `${tag}\u0000${row.key}`;
    if (seen.has(key)) return;
    seen.add(key);
    const held = out.get(tag);
    if (held !== undefined) held.push(row);
    else out.set(tag, [row]);
  };

  for (const pin of seed.pins) for (const tag of headingTags(pin)) add(tag, pin);
  for (const row of seed.rows) {
    const report = row.tid === undefined ? undefined : seed.reports.get(row.tid);
    /* A row is evidence twice over: by the tags it was filed under, and by the tags the
       pass read into it. The filing is what every row has, so a profile whose pass kept
       nothing still hangs its tab titles on the tags those tabs carry. */
    const readable = new Set(headingTags(row));
    for (const kept of report?.tags ?? []) readable.add(kept.tag);
    for (const tag of readable) add(tag, row);
  }
  return out;
}

/**
 * The marker and name of a tag's taxonomy entry, for the hover card.
 *
 * @param kind the tag's kind or reach
 * @returns its marker and label, or the bare name for a kind the taxonomy does not name
 */
export function kindLabel(kind: AnyNodeKind): { mark: string; label: string } {
  if (kind in GRAPH_REACH) return GRAPH_REACH[kind as GraphReach];
  if (kind in GRAPH_NODE_KIND) return GRAPH_NODE_KIND[kind as GraphNodeKind];
  return { mark: '·', label: kind };
}

/* ── the taxonomy's relation sections ─────────────────────────────────────── */

/** One undirected pair the generated `### Web` section lists. */
export interface WebEdge {
  a: string;
  b: string;
  w: number;
}

/** One `theme → anchor · count×` line of `### Themes`. */
export interface ThemeEdge {
  theme: string;
  anchor: string;
  count: number;
}

/** One `### Bursts` cluster and the tags its rows scored highest. */
export interface BurstRow {
  id: number;
  rows: number;
  tags: { tag: string; score: number }[];
}

/** The relation sections of the generated `## Taxonomy` body. */
export interface SeaRelations {
  web: WebEdge[];
  themes: ThemeEdge[];
  bursts: BurstRow[];
  aliases: { from: string; to: string }[];
  synonyms: { from: string; to: string; count: number }[];
}

/** An empty relation set, for a document that has not been generated yet. */
export const NO_RELATIONS: SeaRelations = {
  web: [], themes: [], bursts: [], aliases: [], synonyms: [],
};

/** The `-` lines under one `###` section of the taxonomy body. */
function sectionLines(text: string, name: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('### ')) {
      inside = trimmed.slice(4).trim().toLowerCase() === name;
      continue;
    }
    if (trimmed.startsWith('## ')) {
      inside = false;
      continue;
    }
    if (inside && trimmed.startsWith('- ')) {
      const item = trimmed.slice(2).trim();
      if (item !== '' && item !== 'none') out.push(item);
    }
  }
  return out;
}

/** A tag and the score after the last space of a burst item. */
function scoredTag(item: string): { tag: string; score: number } | null {
  const at = item.lastIndexOf(' ');
  if (at <= 0) return null;
  const tag = item.slice(0, at).trim();
  const score = Number.parseFloat(item.slice(at + 1));
  if (tag === '' || !Number.isFinite(score)) return null;
  return { tag, score };
}

/**
 * Read the relation sections the trace writes beside the taxonomy table.
 *
 * These are the table's own reading of itself — the pairs its rows held together, the themes
 * the bucket stage minted, and the clusters its bursts found — so a hover can show what the
 * table says about a tag rather than a second guess at it.
 *
 * @param text the `## Taxonomy` section body
 * @returns the web, themes, bursts, aliases and synonyms it lists
 */
export function parseRelations(text: string): SeaRelations {
  const web: WebEdge[] = [];
  for (const line of sectionLines(text, 'web')) {
    const m = /^(.*?) ↔ (.*?) ×(\d+)$/.exec(line);
    if (m) web.push({ a: m[1].trim(), b: m[2].trim(), w: Number(m[3]) });
  }

  const themes: ThemeEdge[] = [];
  for (const line of sectionLines(text, 'themes')) {
    const m = /^(.*?) → (.*?) · (\d+)×$/.exec(line);
    if (m) themes.push({ theme: m[1].trim(), anchor: m[2].trim(), count: Number(m[3]) });
  }

  const bursts: BurstRow[] = [];
  for (const line of sectionLines(text, 'bursts')) {
    const m = /^#(\d+) · (\d+) rows: (.*)$/.exec(line);
    if (!m) continue;
    const tags = m[3].split(' · ').map(scoredTag).filter((t): t is { tag: string; score: number } => t !== null);
    bursts.push({ id: Number(m[1]), rows: Number(m[2]), tags });
  }

  const aliases: { from: string; to: string }[] = [];
  for (const line of sectionLines(text, 'aliases')) {
    const m = /^(.*?) → (.*)$/.exec(line);
    if (m) aliases.push({ from: m[1].trim(), to: m[2].trim() });
  }

  const synonyms: { from: string; to: string; count: number }[] = [];
  for (const line of sectionLines(text, 'synonyms')) {
    const m = /^(.*?) → (.*?) · (\d+)×$/.exec(line);
    if (m) synonyms.push({ from: m[1].trim(), to: m[2].trim(), count: Number(m[3]) });
  }

  return { web, themes, bursts, aliases, synonyms };
}

/**
 * The taxonomy body read once, table and relations together.
 *
 * @param text the `## Taxonomy` section body
 * @returns the tags and the relation sections
 */
export function parseTaxonomyDoc(text: string): { tags: SeaTag[]; relations: SeaRelations } {
  return { tags: parseTaxonomy(text), relations: parseRelations(text) };
}

/**
 * A tag graph made from the taxonomy alone, so the wall can open before the seed lands.
 *
 * Themes are the table's own parent links: `ai/前沿 → ai` says the theme hangs under its
 * anchor, and a tag whose name continues an anchor's name hangs under it too. Nothing else
 * is invented; the graph is a view over the same rows the table lists.
 *
 * @param tags the parsed taxonomy table
 * @param relations the parsed relation sections
 * @returns a graph the packing can read
 */
export function graphFromTags(tags: readonly SeaTag[], relations: SeaRelations): TagGraph {
  const roots = new Set<string>();
  const weight = new Map<string, number>();
  const kind = new Map<string, GraphNodeKind>();
  const lambda = new Map<string, number>();
  const edges = new Map<string, Map<string, number>>();
  const alias = new Map<string, string>();

  for (const tag of tags) {
    if (tag.reach === 'pinned') roots.add(tag.tag);
    weight.set(tag.tag, Math.max(1, tag.weight));
    kind.set(tag.tag, tag.kind);
    if (tag.lambda !== undefined) lambda.set(tag.tag, tag.lambda);
  }

  const link = (a: string, b: string, w: number): void => {
    if (a === b || !weight.has(a) || !weight.has(b)) return;
    const near = edges.get(a) ?? new Map<string, number>();
    near.set(b, Math.max(near.get(b) ?? 0, w));
    edges.set(a, near);
    const back = edges.get(b) ?? new Map<string, number>();
    back.set(a, Math.max(back.get(a) ?? 0, w));
    edges.set(b, back);
  };

  for (const edge of relations.web) link(edge.a, edge.b, edge.w);
  for (const theme of relations.themes) {
    link(theme.theme, theme.anchor, theme.count);
    if (!roots.has(theme.anchor) && weight.has(theme.anchor)) kind.set(theme.anchor, kind.get(theme.anchor) ?? 'head');
  }
  for (const synonym of relations.synonyms) link(synonym.from, synonym.to, synonym.count);
  for (const entry of relations.aliases) {
    if (weight.has(entry.to)) alias.set(entry.from, entry.to);
  }
  for (const tag of tags) {
    const slash = tag.tag.lastIndexOf('/');
    if (slash > 0) link(tag.tag, tag.tag.slice(0, slash), Math.max(1, tag.weight));
  }

  return {
    roots,
    edges,
    weight,
    kind,
    anchor: new Map(),
    alias,
    lambda,
    name: (tag: string) => (weight.has(tag) || roots.has(tag) ? tag : tag),
  };
}

/** What a relation means, for the hover card and the colour of its line. */
export type RelationKind = 'pin' | 'alias' | 'theme' | 'burst' | 'web';

/** One tag the hovered tag is related to. */
export interface TagRelation {
  kind: RelationKind;
  tag: string;
  weight: number;
}

/** What a caller knows about the tag whose relations are asked for. */
export interface RelationInput {
  relations: SeaRelations;
  graph: TagGraph;
  /** The pinned heading the tag's cluster answers for, when it has one. */
  pin?: string;
  /** The burst cluster the tag's highest-scoring row landed in. */
  burst?: number;
  /** Relations returned at most; defaults to 12. */
  limit?: number;
}

/** The order relations are shown in: the curated half first, then the table's own readings. */
const RELATION_ORDER: Record<RelationKind, number> = {
  pin: 0, alias: 1, theme: 2, burst: 3, web: 4,
};

/**
 * Everything the table says the tag is related to.
 *
 * @param tag the tag
 * @param input the parsed relations, the graph, and the tag's cluster readings
 * @returns the related tags, nearest relation first
 */
export function relationsOf(tag: string, input: RelationInput): TagRelation[] {
  const found = new Map<string, TagRelation>();
  const add = (kind: RelationKind, other: string, weight: number): void => {
    if (other === '' || other === tag) return;
    const held = found.get(other);
    if (held === undefined || RELATION_ORDER[kind] < RELATION_ORDER[held.kind]
      || (RELATION_ORDER[kind] === RELATION_ORDER[held.kind] && weight > held.weight)) {
      found.set(other, { kind, tag: other, weight });
    }
  };

  if (input.pin !== undefined) add('pin', input.pin, Number.MAX_SAFE_INTEGER);
  for (const edge of input.relations.web) {
    if (edge.a === tag) add('web', edge.b, edge.w);
    else if (edge.b === tag) add('web', edge.a, edge.w);
  }
  for (const [other, weight] of input.graph.edges.get(tag) ?? []) add('web', other, weight);
  for (const theme of input.relations.themes) {
    if (theme.theme === tag) add('theme', theme.anchor, theme.count);
    if (theme.anchor === tag) add('theme', theme.theme, theme.count);
  }
  if (input.burst !== undefined) {
    const burst = input.relations.bursts.find((entry) => entry.id === input.burst);
    for (const kept of burst?.tags ?? []) add('burst', kept.tag, kept.score);
  }
  const alias = input.graph.alias.get(tag);
  if (alias !== undefined) add('alias', alias, Number.MAX_SAFE_INTEGER);

  return [...found.values()]
    .sort((a, b) => RELATION_ORDER[a.kind] - RELATION_ORDER[b.kind] || b.weight - a.weight)
    .slice(0, input.limit ?? 12);
}
