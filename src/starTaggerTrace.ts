/**
 * starTaggerTrace.ts — the generated taxonomy table, the burst reading, and the
 * overridable relation mapping.
 *
 * The build is pure: it reads a sea seed and the stage timings, and writes text. The
 * table and bursts change on every seed, so they are cached in `db.bins`; the mapping
 * (aliases, synonyms, themes, web) is written into `star.tagger.md` once and left
 * editable. The row and the store live in `starTaggerRun.ts`, so this module can be
 * read and tested without a store or a DOM.
 */

import { DEFAULT_QARF } from './qarf';
import { isProvenanceTag } from './rstag';
import type { RowTagReport, TagExplanation } from './srctag';
import { headingTags, type GraphNodeKind, type GraphReach } from './ui/restGraph';
import type { PinGraphSeed, StarTiming } from './ui/seaPinGraph';
import { starLimits, type StarTaggerSetup } from './starTagger';

/** One table row in `## Taxonomy`. */
export interface StarTaxonomyRow {
  tag: string;
  reach: GraphReach;
  kind: GraphNodeKind;
  /** Best per-row suggestion score. */
  score: number;
  /** Distinct scored rows that kept the tag. */
  weight: number;
  /** Raw occurrences in headings and report tag entries. */
  freq: number;
  /** Mean lexical share of the rows that kept it. */
  lambda?: number;
  /** Cluster of the highest-scoring row. */
  burst?: number;
  /** Channel that carried the highest-scoring row. */
  top?: string;
  /** Rows in the trend pass's recent head that kept it. */
  recent?: number;
  /** Rows in the trend pass's older tail that kept it. */
  base?: number;
  /** Recent rate over older rate; absent when neither slice kept it. */
  lift?: number;
  /** Trend score when the tag emerged; absent otherwise. */
  trend?: number;
}

/** The generated table body and the mapping that is written into the row. */
export interface StarTaxonomy {
  /** The dynamic body: header, timing, the table and `### Bursts`. Cached in `db.bins`. */
  text: string;
  /** The overridable body: `### Aliases`, `### Synonyms`, `### Themes` and `### Web`. */
  mapping: string;
  /** Rows written, after the `trace` cap. */
  nodes: number;
  /** Every row the table considered, before the cap. */
  table: StarTaxonomyRow[];
}

/** One tag's evidence while the seed is walked. */
interface TagStat {
  score: number;
  freq: number;
  burst?: number;
  top?: string;
}

/** A cluster's rows and the tags they scored. */
interface BurstStat {
  rows: number;
  tags: Map<string, number>;
}

/** Count occurrences of one raw tag, for an alias or merge relation. */
const bumpCount = (counts: Map<string, number>, raw: string): void => {
  counts.set(raw, (counts.get(raw) ?? 0) + 1);
};

/** `0.123`/`-` for a table cell. */
const fixed = (n: number | undefined, digits = 2): string =>
  n === undefined ? '-' : n.toFixed(digits);

/** A tag as a Markdown table cell: no newline may split one node into two rows. */
const cell = (text: string): string =>
  text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');

/** Milliseconds as an integer, with a sub-millisecond value still visible. */
const ms = (n: number): string => (n > 0 && n < 1 ? '<1ms' : `${Math.round(n)}ms`);

/** The unique undirected edges, heaviest first. */
function topEdges(seed: PinGraphSeed, limit = 40): { a: string; b: string; w: number }[] {
  const seen = new Set<string>();
  const out: { a: string; b: string; w: number }[] = [];
  for (const [a, near] of seed.graph.edges) {
    for (const [b, w] of near) {
      if (a >= b) continue;
      const key = `${a}\0${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ a, b, w });
    }
  }
  return out.sort((x, y) => y.w - x.w || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
    .slice(0, limit);
}

/**
 * Build the generated table and the overridable mapping from one seed.
 *
 * The table is cut to `trace` nodes; the relation sections are not cut by that
 * setting, so the alias/synonym/theme/web mapping stays complete even when the
 * table is short. Bursts travel with the table because they are read from the same
 * seed and change with it; the mapping is the part a reader edits.
 *
 * @param seed the sea's seed
 * @param setup its overrides
 * @param timings stage timings from {@link PinGraphSeed.timings}
 * @param now seed stamp, injectable for a deterministic test
 * @returns the generated body, the mapping, and the rows the table lists
 */
export function buildStarTaxonomy(
  seed: PinGraphSeed, setup: StarTaggerSetup, timings: StarTiming, now: Date = new Date(),
): StarTaxonomy {
  const limits = starLimits(setup);
  const graph = seed.graph;
  const stats = new Map<string, TagStat>();
  const foldCount = new Map<string, number>();
  const mergeCount = new Map<string, number>();
  const bursts = new Map<number, BurstStat>();

  const add = (raw: string, score = 0, report?: RowTagReport, explanation?: TagExplanation): void => {
    /* A maintenance or capture tag is not a topic: the row's `FIXME…`, `dev_` and
       `suffix_` families describe how it was stored, not what it is about. */
    if (isProvenanceTag(raw)) return;
    if (graph.folded?.has(raw) === true) bumpCount(foldCount, raw);
    if (graph.merged?.has(raw) === true) bumpCount(mergeCount, raw);
    const tag = graph.name(raw);
    const held = stats.get(tag) ?? { score: 0, freq: 0 };
    held.freq++;
    if (score > held.score) {
      held.score = score;
      if (report !== undefined) held.burst = report.cluster;
      if (explanation?.top !== undefined) held.top = explanation.top;
    }
    stats.set(tag, held);
  };

  for (const row of seed.rows) {
    for (const tag of headingTags(row)) add(tag);
    const report = row.tid === undefined ? undefined : seed.reports.get(row.tid);
    if (report === undefined) continue;
    const burst = bursts.get(report.cluster) ?? { rows: 0, tags: new Map<string, number>() };
    burst.rows++;
    for (const tag of report.tags) {
      if (isProvenanceTag(tag.tag)) continue;
      add(tag.tag, tag.score, report, tag);
      const node = graph.name(tag.tag);
      burst.tags.set(node, Math.max(burst.tags.get(node) ?? 0, tag.score));
    }
    bursts.set(report.cluster, burst);
  }
  for (const pin of seed.pins) for (const tag of headingTags(pin)) add(tag);

  const kept = graph.kept ?? new Set(graph.weight.keys());
  const table: StarTaxonomyRow[] = [...kept].map((tag) => {
    const stat = stats.get(tag);
    const lambda = graph.lambda.get(tag);
    const reading = seed.trend?.get(tag);
    return {
      tag,
      reach: seed.reach.get(tag) ?? 'own',
      kind: graph.kind.get(tag) ?? 'own',
      score: stat?.score ?? 0,
      weight: graph.weight.get(tag) ?? 0,
      freq: stat?.freq ?? 0,
      ...(lambda === undefined ? {} : { lambda }),
      ...(stat?.burst === undefined ? {} : { burst: stat.burst }),
      ...(stat?.top === undefined ? {} : { top: stat.top }),
      ...(reading === undefined ? {} : {
        recent: reading.recent, base: reading.base, lift: reading.lift,
      }),
      ...(reading?.emerging === true ? { trend: reading.score } : {}),
    };
  }).sort((a, b) => b.weight - a.weight || b.score - a.score || a.tag.localeCompare(b.tag));

  const allEdges = topEdges(seed, Number.MAX_SAFE_INTEGER);
  const edges = allEdges.slice(0, 40);
  const lambdas = table.flatMap((row) => (row.lambda === undefined ? [] : [row.lambda]));
  const lambdaMean = lambdas.length === 0
    ? undefined
    : lambdas.reduce((sum, n) => sum + n, 0) / lambdas.length;
  const alpha = setup.alpha ?? DEFAULT_QARF.alpha;
  const floor = setup.floor ?? DEFAULT_QARF.floor;
  const ceil = setup.ceil ?? DEFAULT_QARF.ceil;
  const header = [
    `seeded ${now.toISOString()} · rows ${limits.base}/${seed.rows.length} · pins ${seed.pins.length}`
      + ` · nodes ${kept.size}/${limits.maxGraph} · trace ${Math.min(limits.trace, kept.size)}`
      + ` · edges ${allEdges.length} · λ̄ ${fixed(lambdaMean, 3)}`
      + ` · α ${alpha.toFixed(2)} · floor ${floor.toFixed(2)} · ceil ${ceil.toFixed(2)}`,
    `time: config ${ms(timings.config)} · scan ${ms(timings.scan)}`
      + ` · score ${ms(timings.score)} · graph ${ms(timings.graph)} · total ${ms(timings.total)}`,
  ];
  for (const note of setup.notes) header.push(`note: ${note}`);

  const rows: string[] = [
    '| tag | reach | kind | score | weight | freq | λ | burst | top | recent | base | lift | trend |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const row of table.slice(0, limits.trace)) {
    rows.push(`| ${cell(row.tag)} | ${row.reach} | ${row.kind} | ${fixed(row.score, 3)}`
      + ` | ${row.weight} | ${row.freq} | ${fixed(row.lambda)}`
      + ` | ${row.burst === undefined ? '-' : row.burst} | ${row.top ?? '-'}`
      + ` | ${row.recent ?? '-'} | ${row.base ?? '-'} | ${fixed(row.lift)}`
      + ` | ${fixed(row.trend)} |`);
  }
  if (table.length > limits.trace) {
    rows.push(`\ntrace cut at ${limits.trace} of ${table.length} nodes.`);
  }

  const list = (title: string, items: string[]): string[] =>
    [`### ${title}`, ...(items.length === 0 ? ['- none'] : items)];
  const aliases = [...(graph.folded ?? new Map<string, string>())]
    .map(([alias, tag]) => ({ alias, tag, n: foldCount.get(alias) ?? 0 }))
    .sort((a, b) => b.n - a.n || a.alias.localeCompare(b.alias))
    .slice(0, 40)
    .map((r) => `- ${r.alias} → ${r.tag} · ${r.n}×`);
  const synonyms = [...(graph.merged ?? new Map<string, string>())]
    .map(([variant, tag]) => ({ variant, tag, n: mergeCount.get(variant) ?? 0 }))
    .sort((a, b) => b.n - a.n || a.variant.localeCompare(b.variant))
    .slice(0, 40)
    .map((r) => `- ${r.variant} → ${r.tag} · ${r.n}×`);
  const themes = [...graph.anchor]
    .map(([tag, anchor]) => ({ tag, anchor, n: graph.weight.get(tag) ?? 0 }))
    .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag))
    .slice(0, 40)
    .map((r) => `- ${r.tag} → ${r.anchor} · ${r.n}×`);
  const burstLines = [...bursts]
    .sort(([a], [b]) => a - b)
    .slice(0, 40)
    .map(([cluster, burst]) => {
      const top = [...burst.tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 6)
        .map(([tag, score]) => `${tag} ${fixed(score, 2)}`)
        .join(' · ');
      return `- #${cluster} · ${burst.rows} rows: ${top}`;
    });
  const web = edges.map((e) => `- ${e.a} ↔ ${e.b} ×${e.w}`);

  const text = [
    ...header,
    '',
    ...rows,
    '',
    ...list('Bursts', burstLines),
  ].join('\n');
  const mapping = [
    ...list('Aliases', aliases),
    '',
    ...list('Synonyms', synonyms),
    '',
    ...list('Themes', themes),
    '',
    ...list('Web', web),
  ].join('\n');
  return { text, mapping, nodes: Math.min(limits.trace, table.length), table };
}
