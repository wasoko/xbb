/**
 * restVizData.ts — the readings `restViz.tsx` draws above the rest blocks.
 *
 * Every function here is pure and takes the same two things: the rows the list
 * is showing, and the `Map<tid, RowTagReport>` a rest pass returned. That is
 * enough because a report already carries everything a reading needs — the kept
 * tags with their channel shares, the burst each row sits in, and the trie hits
 * the keyword channel read.
 *
 * Two of the readings are partitions rather than summaries: `priority` splits
 * the rows by whether they kept a curated tag, and `themes` by burst and anchor
 * tag. {@link vizBlocks} turns those into the blocks that replace the `rsdt`
 * ones, so every row lands in exactly one block and nothing is listed twice.
 *
 * A row the pass's cap left unscored is reported like that rather than dropped:
 * the cap is 200 rows, and a table is usually longer.
 */

import type { Da } from '../sdb';
import { DEFAULT_TAG_AIM, TAG_CHANNEL_LABEL, normalizeText } from '../srctag';
import type { RowTagReport, TagExplanation, TagParts } from '../srctag';
import type { RestGroup, RestVizMode } from './restGrouper';

/** One report per scored row, keyed by `tid`; the pass's own return type. */
export type VizReports = Map<number, RowTagReport>;

/** One labelled bar: the reading's own number, and its share of the whole. */
export interface VizBar {
  label: string;
  /** Rows, tags, or a score sum, depending on the reading. */
  value: number;
  share: number;
}

/** A kept tag's bar, plus whether the priority half carried it. */
export interface VizTagBar extends VizBar {
  priority: boolean;
}

/** Heading of the trailing block holding rows the pass's cap left unscored. */
export const VIZ_UNSCORED_LABEL = 'unscored';

/** Thousandths keep a printed share stable. */
const share = (n: number, total: number): number =>
  total > 0 ? Math.round((n / total) * 1000) / 1000 : 0;

/** Whether the priority half carried a tag: the channel the focus rule reads. */
const isPriorityTag = (t: TagExplanation): boolean =>
  t.channels.some((c) => c.channel === 'priority');

/**
 * Report of one row, or undefined when the pass did not score it.
 *
 * @param reports one report per scored row
 * @param row row to look up
 * @returns the row's report, if the pass scored it
 */
export const reportOf = (reports: VizReports, row: Da): RowTagReport | undefined =>
  row.tid === undefined ? undefined : reports.get(row.tid);

/** What every mode's header carries: the pass's reach, and how many tags a row keeps. */
export interface VizTitleHistogram {
  rows: number;
  /** Rows that kept at least one tag. */
  scored: number;
  untagged: number;
  /** One bar per kept-tag count, ascending; the untagged bucket is included. */
  buckets: VizBar[];
}

/**
 * Tags kept per row, the header's histogram.
 *
 * @param rows rows the list is showing
 * @param reports one report per scored row
 * @returns the counts and the histogram
 */
export function tagsPerTitle(rows: Da[], reports: VizReports): VizTitleHistogram {
  const buckets = new Map<number, number>();
  let scored = 0;
  for (const row of rows) {
    const kept = reportOf(reports, row)?.tags.length ?? 0;
    buckets.set(kept, (buckets.get(kept) ?? 0) + 1);
    if (kept > 0) scored++;
  }
  return {
    rows: rows.length,
    scored,
    untagged: rows.length - scored,
    buckets: [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([tags, count]) => ({ label: String(tags), value: count, share: share(count, rows.length) })),
  };
}

/** The priority reading: which rows the curated tags reach, and which tags carry them. */
export interface VizPriority {
  /** Rows keeping at least one tag the priority half carried. */
  tagged: Da[];
  /** Rows the pass scored that kept nothing. */
  untagged: Da[];
  /** Rows the pass's cap left unscored. */
  unscored: Da[];
  /** Kept tags by rows keeping them, most widespread first. */
  bars: VizTagBar[];
}

/**
 * Split the rows by whether they kept a tag the priority half carried, and count
 * the tags that did.
 *
 * A tag is priority-backed when its explanation carries a `priority` channel —
 * the same test the focus rule applies — so the bars say which curated tags the
 * table is actually about.
 *
 * @param rows rows the list is showing
 * @param reports one report per scored row
 * @returns the three groups and the bars
 */
export function priorityCoverage(rows: Da[], reports: VizReports): VizPriority {
  const tagged: Da[] = [];
  const untagged: Da[] = [];
  const unscored: Da[] = [];
  const counts = new Map<string, number>();
  const curated = new Set<string>();
  let scored = 0;

  for (const row of rows) {
    const report = reportOf(reports, row);
    if (!report) {
      unscored.push(row);
      continue;
    }
    scored++;
    let kept = 0;
    for (const t of report.tags) {
      counts.set(t.tag, (counts.get(t.tag) ?? 0) + 1);
      if (isPriorityTag(t)) {
        curated.add(t.tag);
        kept++;
      }
    }
    (kept > 0 ? tagged : untagged).push(row);
  }

  return {
    tagged,
    untagged,
    unscored,
    bars: [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label, value]) => ({
        label, value, share: share(value, scored), priority: curated.has(label),
      })),
  };
}

/** One burst-and-anchor group of the theme reading. */
export interface VizTheme {
  key: string;
  /** Anchor tag the group's rows keep; empty for the untagged rows of a burst. */
  anchor: string;
  /** Burst the group's rows sit in, as the pass numbered it. */
  cluster: number;
  /** Terms more than `minShared - 1` of the group's rows propose. */
  shared: VizBar[];
  items: Da[];
}

/** The theme reading: the groups, and the rows the cap left out. */
export interface VizThemes {
  groups: VizTheme[];
  unscored: Da[];
}

/**
 * Group the rows by burst and anchor tag, and name the terms each group shares.
 *
 * The anchor is the highest-ranked tag a row kept, which is what a promoted
 * sub-tag is named after; the terms are counted over the same lists the promote
 * half reads, so this is the evidence behind a `parent/theme` chip whether or not
 * aim minted one.
 *
 * @param rows rows the list is showing
 * @param reports one report per scored row
 * @param minShared rows that must propose a term before it counts as shared
 * @returns the groups, most rows first, and the unscored rows
 */
export function themeGroups(
  rows: Da[], reports: VizReports, minShared = DEFAULT_TAG_AIM.promoteMin,
): VizThemes {
  const groups = new Map<string, { anchor: string; cluster: number; items: Da[]; counts: Map<string, number> }>();
  const unscored: Da[] = [];

  for (const row of rows) {
    const report = reportOf(reports, row);
    if (!report) {
      unscored.push(row);
      continue;
    }
    const anchor = report.tags[0]?.tag ?? '';
    const key = `${report.cluster}\u0000${anchor}`;
    let group = groups.get(key);
    if (!group) {
      group = { anchor, cluster: report.cluster, items: [], counts: new Map() };
      groups.set(key, group);
    }
    group.items.push(row);
    for (const t of report.tags) group.counts.set(t.tag, (group.counts.get(t.tag) ?? 0) + 1);
  }

  return {
    groups: [...groups.entries()]
      .sort((a, b) => b[1].items.length - a[1].items.length || a[1].cluster - b[1].cluster)
      .map(([key, g]) => ({
        key,
        anchor: g.anchor,
        cluster: g.cluster,
        items: g.items,
        shared: [...g.counts.entries()]
          .filter(([tag, n]) => tag !== g.anchor && n >= minShared)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([label, value]) => ({ label, value, share: share(value, g.items.length) })),
      })),
    unscored,
  };
}

/**
 * Each channel's share of the pass's total contribution, largest first.
 *
 * The contributions come from the explanations, so they are the weighted shares
 * the score is actually made of, not the raw channel values.
 *
 * @param reports one report per scored row
 * @returns one bar per channel that contributed
 */
export function channelShares(reports: VizReports): VizBar[] {
  const totals = new Map<keyof TagParts, number>();
  for (const report of reports.values()) {
    for (const t of report.tags) {
      for (const c of t.channels) totals.set(c.channel, (totals.get(c.channel) ?? 0) + c.contribution);
    }
  }
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([channel, contribution]) => ({
      label: TAG_CHANNEL_LABEL[channel],
      value: Math.round(contribution * 1000) / 1000,
      share: share(contribution, sum),
    }));
}

/** One keyword surface form, the tag it names, and the rows whose text carried it. */
export interface VizKeyword {
  form: string;
  tag: string;
  rows: number;
  /** Titles that matched, in list order. */
  titles: string[];
}

/**
 * The trie's hits, by surface form.
 *
 * A form is one entry of the dictionary, so a title matching both `react` and
 * `react hooks` counts for both. Suppressing entries are left out the way
 * `TurboTextTagger.match` leaves them out.
 *
 * @param rows rows the list is showing
 * @param reports one report per scored row
 * @param examples how many titles to keep per form
 * @returns the forms, most widespread first
 */
export function keywordHits(rows: Da[], reports: VizReports, examples = 3): VizKeyword[] {
  const held = new Map<string, VizKeyword>();
  const counted = new Map<string, Set<number>>();

  for (const row of rows) {
    const report = reportOf(reports, row);
    if (!report) continue;
    for (const hit of report.keywords) {
      if (hit.block) continue;
      const key = `${hit.tag}\u0000${normalizeText(hit.form)}`;
      let entry = held.get(key);
      if (!entry) {
        entry = { form: hit.form, tag: hit.tag, rows: 0, titles: [] };
        held.set(key, entry);
        counted.set(key, new Set());
      }
      const seen = counted.get(key)!;
      if (seen.has(row.tid ?? -1)) continue;
      seen.add(row.tid ?? -1);
      entry.rows++;
      if (entry.titles.length < examples) entry.titles.push(row.txt || row.ref);
    }
  }

  return [...held.values()]
    .sort((a, b) => b.rows - a.rows || a.form.localeCompare(b.form));
}

/**
 * The blocks a reading replaces the `rsdt` blocks with.
 *
 * `priority` splits by whether a row kept a curated tag and `themes` by burst and
 * anchor; both end with the rows the pass's cap left unscored, so every row the
 * list holds appears exactly once. Every other mode keeps the blocks it already
 * had.
 *
 * @param mode reading the panel is on
 * @param rows rows the list is showing
 * @param reports one report per scored row
 * @returns the blocks to render, or undefined when the mode keeps the existing ones
 */
export function vizBlocks(mode: RestVizMode, rows: Da[], reports: VizReports): RestGroup[] | undefined {
  if (mode === 'priority') {
    const { tagged, untagged, unscored } = priorityCoverage(rows, reports);
    return [
      ...(tagged.length > 0 ? [{ key: 'priority', label: 'priority tag kept', items: tagged }] : []),
      ...(untagged.length > 0 ? [{ key: 'untagged', label: 'no tag kept', items: untagged }] : []),
      ...(unscored.length > 0
        ? [{ key: VIZ_UNSCORED_LABEL, label: VIZ_UNSCORED_LABEL, items: unscored }] : []),
    ];
  }
  if (mode === 'themes') {
    const { groups, unscored } = themeGroups(rows, reports);
    return [
      ...groups.map((g) => {
        const themes = g.shared.map((s) => s.label).join(', ');
        return {
          key: g.key,
          label: `${g.anchor || '(untagged)'} · burst ${g.cluster}`
            + `${themes ? ` · ${themes}` : ''} · ${g.items.length} rows`,
          items: g.items,
        };
      }),
      ...(unscored.length > 0
        ? [{ key: VIZ_UNSCORED_LABEL, label: VIZ_UNSCORED_LABEL, items: unscored }] : []),
    ];
  }
  return undefined;
}
