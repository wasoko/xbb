/**
 * seaPinGraph.ts — the sea's seed: the table read by how far each tag is from the pins.
 *
 * The rest list asks what its pass *did* with each tag. The sea asks the other question a
 * table with several tags per row is read by: how far is a tag from the curated half. The
 * seed is the pin cards plus up to `base` newest `type='tab'`/`type='tag'` rows, scored with
 * `qarf` so the fused lists are the adaptive ones, and the graph is built with its aliases
 * kept — a table that spells one curated tag two ways is saying something about itself, and
 * folding the spelling away hides it. The same reports feed a recent-versus-tail trend pass,
 * so the wall's right band can name what the newest rows are using without a second scan.
 *
 * It is not the pass the rest list draws. That pass walks the rows a reader is looking at
 * and publishes to `restTagStore`; this one reads the sea's own window, because a hop is a
 * statement about the whole seed rather than about the rows on screen. The sea is the only
 * reader, and the seed is re-read when `star.tagger.md`'s Setup block changes.
 */

import { db, treeCacReady, type Da } from '../sdb';
import { TAG_DEL, pinPriorityTags, type RowTagReport } from '../srctag';
import { QARF_TAG_SCORE, qarfAdaptive, qarfTagReports } from '../qarf';
import { runRestPass } from '../rstag';
import { isPinCardRow } from './cardTab';
import { buildTagGraph, headingTags, pinReach, type GraphReach, type TagGraph } from './restGraph';
import { tagTrends, type TagTrend } from './seaTrend';
import {
  DEFAULT_STAR_SETUP, STAR_BASE_DEFAULT, foldAlias, isTaggerRef, resolveAliases,
  starLimits, type StarTaggerSetup,
} from '../starTagger';

/**
 * Rows the pin reading seeds from when no `base:` override is written.
 *
 * The taxonomies are read off `type='tab'` and `type='tag'` rows; a pin card is
 * read separately because it supplies the roots rather than the qarf input.
 */
export const PIN_SEED_ROWS = STAR_BASE_DEFAULT;

/** Wall-clock milliseconds one seed spent in each stage. */
export interface StarTiming {
  /** Parsing and resolving the tagger row; the caller measures it. */
  config: number;
  /** Reading pins and tab/tag rows from `db.das`. */
  scan: number;
  /** The qarf pass over those rows. */
  score: number;
  /** Building the tag graph. */
  graph: number;
  /** Everything above. */
  total: number;
}

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
  /** Each tag's recent-versus-tail reading, from the same scored window. */
  trend: Map<string, TagTrend>;
  /** The overrides the seed ran with. */
  setup: StarTaggerSetup;
  /** Pin headings after aliases were folded, as the qarf pass saw them. */
  priorityTags: string[];
  /** Time each stage took. */
  timings: StarTiming;
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

/** Newest `tid` first, the order the sea's vertical axis reads. */
const byNewest = (a: Da, b: Da): number => (b.tid ?? 0) - (a.tid ?? 0);

/** The pin cards the table holds, newest first. */
async function loadPins(): Promise<Da[]> {
  const cards = await db.das.where('type').equals('md').toArray();
  return cards
    .filter((row) => isPinCardRow(row) && !(row.tags ?? []).includes(TAG_DEL))
    .sort(byNewest);
}

/**
 * The newest `base` rows whose text feeds qarf.
 *
 * Only `type='tab'` and `type='tag'` rows are the taxonomy's evidence; a pin
 * card supplies roots, and the tagger document itself is never an input.
 *
 * @param base ceiling on rows read
 * @returns the rows, newest first
 */
async function loadSeedRows(base: number): Promise<Da[]> {
  const rows = await db.das.orderBy(':id').reverse()
    .filter((row) => row.type === 'tab' || row.type === 'tag')
    .limit(base)
    .toArray();
  return rows.filter((row) => !(row.tags ?? []).includes(TAG_DEL) && !isTaggerRef(row.ref));
}

/**
 * Read pins and the newest tab/tag rows, score them with `qarf`, and read the
 * result by pin reach.
 *
 * Nothing is written back: the caller owns the seed and decides whether the
 * pass's reports become the store's own. Aliases are folded before the priority
 * tags and the graph, and the synonyms map keeps the acronyms reachable by the
 * trie.
 *
 * @param setup the tagger row's overrides; omitted leaves every default
 * @param clock millisecond clock, injectable for a timing test
 * @returns the pins, rows, reports, graph, reach, recency, trend, and stage timings
 */
export async function loadPinGraph(
  setup: StarTaggerSetup = DEFAULT_STAR_SETUP,
  clock: () => number = () => performance.now(),
): Promise<PinGraphSeed> {
  /* The settings cache is filled a tick after boot, and the priority tags come from it. */
  await treeCacReady;
  const started = clock();
  const limits = starLimits(setup);
  const pins = await loadPins();
  const rows = await loadSeedRows(limits.base);
  const scanned = clock();

  const resolved = resolveAliases(setup.alias);
  const fold = (tag: string): string => foldAlias(tag, resolved.map);
  const priorityTags = [...new Set(pinPriorityTags(pins).map(fold))];
  const synonyms: Record<string, string[]> = {};
  for (const alias of Object.keys(setup.alias)) {
    const canonical = fold(alias);
    if (canonical !== alias) (synonyms[canonical] ??= []).push(alias);
  }

  const qarf = {
    ...(setup.alpha === undefined ? {} : { alpha: setup.alpha }),
    ...(setup.floor === undefined ? {} : { floor: setup.floor }),
    ...(setup.ceil === undefined ? {} : { ceil: setup.ceil }),
  };
  const scored = clock();
  /* The seed is the qarf reading over the whole window: every row is scored, the curated
     half is rooted at the pin cards, and each row's own share decides its weights. The URL
     is left out of the channels the way a list of one site's pages needs it. */
  const reports = await runRestPass(rows, {
    dim: 'visitTime', bucket: 'domain',
    score: QARF_TAG_SCORE,
    limit: Number.POSITIVE_INFINITY,
    pinsPriority: true,
    aim: {},
    pipeline: 'qarf',
    qarf: { ...qarfAdaptive(qarf), tag: qarfTagReports },
    bm25: { fields: { url: 0 } },
  }, { pins, priorityTags, tag: { synonyms, urls: false } });
  const scoreDone = clock();

  const graph = buildTagGraph(pins, rows, reports, {
    keepAliases: true,
    alias: fold,
    maxNodes: limits.maxGraph,
  });
  const trend = tagTrends(rows, reports, graph, {
    recent: limits.recent, minRecent: limits.minRecent, minLift: limits.minLift,
  });
  const graphDone = clock();
  const window = [...pins, ...rows].sort(byNewest);
  return {
    pins, rows, reports, graph,
    reach: pinReach(graph),
    recency: tagRecency(graph, window, reports),
    trend,
    setup: { ...setup, notes: [...setup.notes, ...resolved.notes] },
    priorityTags,
    timings: {
      config: 0,
      scan: scanned - started,
      score: scoreDone - scored,
      graph: graphDone - scoreDone,
      total: graphDone - started,
    },
  };
}
