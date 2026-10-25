/**
 * seaTrend.ts — which tags are emerging from the newest part of the sea's seed.
 *
 * The qarf pass already reads the newest `base` tab/tag rows and scores each one, but a
 * fused score is not a trend: it says how specific a row's evidence is, not whether a tag
 * is being used more now than in the older part of the same window. This module reads the
 * reports the pass already produced and compares two slices of the window:
 *
 * - the recent head, ordered by `rec.visitTime` when the row carries one and by
 *   `daStamp` otherwise, because a browser visit is the evidence of use while a sync
 *   stamp only says when the row reached the table;
 * - the older tail, which is the rest of the seed.
 *
 * A tag emerges when the recent head keeps it often enough and its rate there is a
 * multiple of its rate in the tail. The score combines the two so a tag with a handful of
 * recent rows and no older history can outrank a common tag whose rate barely moved.
 *
 * Nothing here touches Dexie or the DOM: the pass is a pure function of rows, reports and
 * a graph, so the thresholds in `star.tagger.md` are testable without a browser.
 */

import { daStamp, type Da } from '../sdb';
import { rowStamp, type RowTagReport } from '../srctag';
import { headingTags, type TagGraph } from './restGraph';

/** Thresholds one trend pass reads. */
export interface TrendConfig {
  /** Newest rows that make the recent head. */
  recent: number;
  /** Recent rows that must keep a tag before it can emerge. */
  minRecent: number;
  /** Recent rate over older rate a tag must reach, unless the older rate is zero. */
  minLift: number;
}

/** One tag's recent-versus-tail reading. */
export interface TagTrend {
  /** Canonical tag name. */
  tag: string;
  /** Rows in the recent head that kept it. */
  recent: number;
  /** Rows in the older tail that kept it. */
  base: number;
  /** Recent rate divided by older rate, with a zero-rate tail read as unbounded. */
  lift: number;
  /** Recent support weighted by how far its rate rose. */
  score: number;
  /** Newest stamp among the rows that kept it, for a stable secondary order. */
  last: number;
  /** Whether the thresholds held for this tag. */
  emerging: boolean;
}

/** The trend thresholds' own fallbacks, mirrored by `starTagger`'s Setup defaults. */
const EPS = 1e-9;

/**
 * A row's recency stamp: its browser visit time when it has one, otherwise its durable
 * `dt`/`modAt` stamp.
 *
 * `rowStamp` covers `rec.visitTime`, the historical typo, and the `access2discard` map, so
 * a row visited through any of the paths the rest list reads is ordered the same way here.
 *
 * @param row a seed row
 * @returns epoch milliseconds, or the row's `tid` when neither clock says anything
 */
export function recentStamp(row: Da): number {
  const visit = rowStamp(row, 'visitTime');
  if (visit > 0) return visit;
  const stamp = daStamp(row);
  if (Number.isFinite(stamp) && stamp > 0) return stamp;
  return row.tid ?? 0;
}

/** Canonical tags one row supports, deduplicated by node name. */
function rowTags(row: Da, report: RowTagReport | undefined, graph: TagGraph): string[] {
  const out = new Set<string>();
  for (const tag of headingTags(row)) out.add(graph.name(tag));
  for (const tag of report?.tags ?? []) out.add(graph.name(tag.tag));
  return [...out];
}

/**
 * Compare the recent head of a seed with its older tail.
 *
 * Rows are taken newest first by {@link recentStamp}, so the head is the part of the seed
 * a reader has used most recently rather than the part that synced last. A tag's support
 * counts rows, not occurrences, so a row repeating a tag cannot inflate a trend.
 *
 * @param rows the seed's evidence rows, in any order
 * @param reports the pass's reports, keyed by `tid`
 * @param graph the graph over the same rows, for canonical names
 * @param cfg the recent-head size and the two thresholds
 * @returns one reading per tag the window kept
 */
export function tagTrends(
  rows: readonly Da[],
  reports: Map<number, RowTagReport>,
  graph: TagGraph,
  cfg: TrendConfig,
): Map<string, TagTrend> {
  const ordered = [...rows].sort((a, b) => recentStamp(b) - recentStamp(a));
  const headSize = Math.max(0, Math.min(ordered.length, Math.round(cfg.recent)));
  const head = ordered.slice(0, headSize);
  const tail = ordered.slice(headSize);
  const headRows = Math.max(1, head.length);
  const tailRows = Math.max(1, tail.length);

  const recent = new Map<string, number>();
  const base = new Map<string, number>();
  const last = new Map<string, number>();
  const count = (into: Map<string, number>, slice: readonly Da[]): void => {
    for (const row of slice) {
      const report = row.tid === undefined ? undefined : reports.get(row.tid);
      const stamp = recentStamp(row);
      for (const tag of rowTags(row, report, graph)) {
        into.set(tag, (into.get(tag) ?? 0) + 1);
        const held = last.get(tag);
        if (held === undefined || stamp > held) last.set(tag, stamp);
      }
    }
  };
  count(recent, head);
  count(base, tail);

  const out = new Map<string, TagTrend>();
  const tags = new Set([...recent.keys(), ...base.keys()]);
  for (const tag of tags) {
    const r = recent.get(tag) ?? 0;
    const b = base.get(tag) ?? 0;
    const recentRate = r / headRows;
    const baseRate = b / tailRows;
    const lift = (recentRate + EPS) / (baseRate + EPS);
    const score = r * Math.log1p(lift);
    out.set(tag, {
      tag, recent: r, base: b, lift, score, last: last.get(tag) ?? 0,
      emerging: r >= cfg.minRecent && (b === 0 || lift >= cfg.minLift),
    });
  }
  return out;
}

/** One top-level tag the recent band draws, with the neighbours under it. */
export interface EmergingTag {
  /** Canonical tag name. */
  tag: string;
  /** The trend score that selected it. */
  score: number;
  /** One-hop neighbours drawn as its treemap, strongest first. */
  children: string[];
}

/** How many recent columns to draw and how many neighbours each may hold. */
export interface EmergingOptions {
  /** Top-level recent tags drawn at most. */
  maxEmerging: number;
  /** Neighbours drawn under one recent tag at most. */
  maxChildren: number;
}

/** Recent-band columns a wall draws when the caller names none. */
export const EMERGING_COLUMNS = 8;

/** Neighbours one recent column holds when the caller names none. */
export const EMERGING_CHILDREN = 8;

/**
 * Pick the recent band's top-level tags and their one-hop treemaps.
 *
 * The band is the other side of the star from the pin cards, so a curated root never
 * appears in it. A child is a direct graph neighbour, not a second hop: the wall shows the
 * evidence one row made, not a path through the graph.
 *
 * @param graph the graph over the seed
 * @param trend the trend reading for every tag
 * @param opts how many columns and children to keep
 * @returns the emerging columns, strongest first
 */
export function emergingTags(
  graph: TagGraph, trend: Map<string, TagTrend>, opts: EmergingOptions,
): EmergingTag[] {
  const ranked = [...trend.values()]
    .filter((t) => t.emerging && !graph.roots.has(t.tag) && graph.alias.get(t.tag) === undefined)
    .sort((a, b) => b.score - a.score || b.recent - a.recent || a.tag.localeCompare(b.tag))
    .slice(0, Math.max(0, Math.round(opts.maxEmerging)));

  const out: EmergingTag[] = [];
  for (const t of ranked) {
    const children = [...(graph.edges.get(t.tag) ?? [])]
      .filter(([tag]) => tag !== t.tag && !graph.roots.has(tag) && graph.weight.has(tag))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, Math.max(0, Math.round(opts.maxChildren)))
      .map(([tag]) => tag);
    out.push({ tag: t.tag, score: t.score, children });
  }
  return out;
}
