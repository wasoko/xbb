/**
 * seaPinGraph.ts — the sea's seed: the table read by how far each tag is from the pins.
 *
 * The rest list asks what its pass *did* with each tag. The sea asks the other question a
 * table with several tags per row is read by: how far is a tag from the curated half. The
 * seed is the pin cards plus the newest rows, scored with `qarf` so the fused lists are the
 * adaptive ones, and the graph is built with its aliases kept — a table that spells one
 * curated tag two ways is saying something about itself, and folding the spelling away
 * hides it.
 *
 * It is not the pass the rest list draws. That pass walks the rows a reader is looking at
 * and publishes to `restTagStore`; this one reads a window four times that size, because a
 * hop is a statement about the whole seed rather than about the rows on screen. The sea is
 * the only reader, and it is read once per mount.
 */

import { iq, treeCacReady, type Da } from '../sdb';
import type { RowTagReport } from '../srctag';
import { QARF_GROUPER, restProfileMap } from './restGrouper';
import { isPinCardRow } from './cardTab';
import { buildTagGraph, headingTags, pinReach, type GraphReach, type TagGraph } from './restGraph';

/**
 * Rows the pin reading seeds from.
 *
 * Four times the rest list's own page (555): a hop is a statement about the whole seed, so
 * a window a reader happens to be scrolled to would make the related and remote bands
 * depend on where they were.
 */
export const PIN_SEED_ROWS = 2222;

/** What one pin reading produced. */
export interface PinGraphSeed {
  /** The pin cards the window held; the graph is rooted at their `#tag` headings. */
  pins: Da[];
  /** The rows below them. */
  rows: Da[];
  /** One report per scored row, keyed by `tid`. */
  reports: Map<number, RowTagReport>;
  /** The graph over that seed, with a pin's variant spellings kept apart. */
  graph: TagGraph;
  /** How far each node is from the curated half. */
  reach: Map<string, GraphReach>;
  /** How new each node's evidence is, `1` for a tag only the newest rows kept. */
  recency: Map<string, number>;
}

/**
 * How new each node's evidence is, from where its newest row sits in the window.
 *
 * The window is read newest first, so a row's place in it is the recency the sky's vertical
 * axis is laid out by: a tag only the newest row kept sits at `1`, and a tag whose newest row
 * is the last of the window sits at `0`. A pin card counts by its own row, so the newest pin
 * heads the spine.
 *
 * @param graph the graph over the same window, for the canonical name of a tag
 * @param window the rows and cards the graph was built from, newest first
 * @param reports the pass's reports, keyed by `tid`
 * @returns the newest share per node, `1` for the newest evidence
 */
export function tagRecency(
  graph: TagGraph, window: Da[], reports: Map<number, RowTagReport>,
): Map<string, number> {
  const out = new Map<string, number>();
  const last = Math.max(1, window.length - 1);
  window.forEach((row, i) => {
    const share = 1 - i / last;
    /* A card is read by the headings it names; a row by what the pass kept for it, which a
       row the pass never scored has none of. */
    const tags = isPinCardRow(row)
      ? headingTags(row)
      : (row.tid === undefined ? [] : reports.get(row.tid)?.tags ?? []).map((t) => t.tag);
    for (const tag of tags) {
      const name = graph.name(tag);
      const held = out.get(name);
      if (held === undefined || share > held) out.set(name, share);
    }
  });
  return out;
}

/**
 * Read the newest rows of the table, score them with `qarf`, and read the result by pin
 * reach.
 *
 * Nothing is written back: the caller owns the seed and decides whether the pass's reports
 * become the store's own.
 *
 * @param limit rows to read, newest first
 * @returns the pins, the rows, the reports, the graph and each node's reach
 */
export async function loadPinGraph(limit = PIN_SEED_ROWS): Promise<PinGraphSeed> {
  /* The settings cache is filled a tick after boot, and the priority tags come from it. */
  await treeCacReady;

  const newest = (await iq([], undefined, undefined, limit)).slice(0, limit);
  const pins: Da[] = [];
  const rows: Da[] = [];
  for (const da of newest) (isPinCardRow(da) ? pins : rows).push(da);

  const reports = await restProfileMap(rows, QARF_GROUPER, undefined, { pins });
  const graph = buildTagGraph(pins, rows, reports, { keepAliases: true });
  return {
    pins, rows, reports, graph,
    reach: pinReach(graph),
    recency: tagRecency(graph, newest, reports),
  };
}
