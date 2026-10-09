// src/ui/restGrouper.ts
import { db, daStamp, type Da } from '../sdb';
import { dtMs } from '../fc';
import { getStore, runBody } from '../recr';
import { metaTitle, parseSessionRef, SESSION_PREFIX } from '../sessionTree';
import {
  RSTEXT_TAG_SCORE, TAG_DEL, tagRowReports,
  type RowTagReport, type TagRow, type TagRowsOptions,
} from '../srctag';

export { dtMs };

/**
 * One rendered block of the rest list: a heading and the rows sharing it. A
 * block carries rows directly (`items`), visit-time blocks (`subgroups`), or
 * both, and the flat built-ins use `items` alone.
 */
export interface RestGroup {
  key: string;
  label: string;
  items: Da[];
  /** Visit-time blocks inside a date block, newest first. */
  subgroups?: RestGroup[];
}

/** `treeCac['restGrouper']` value: blocks by `dt` alone. */
export const RSDT_GROUPER = 'rsdt';

/** `treeCac['restGrouper']` value: blocks by `dt`, then by `visitTime`. */
export const RSID_GROUPER = 'rsid';

/** `treeCac['restGrouper']` value: one block per session, for the recr rows `f=recr` lists. */
export const RSSESS_GROUPER = 'rsess';

/**
 * `treeCac['restGrouper']` value: the {@link RSDT_GROUPER} blocks unchanged,
 * plus each row's `srctag` suggestions rendered beside it as unpainted chips.
 * The blocks do not depend on the tags, so the list paints immediately and the
 * chips arrive one tick later.
 */
export const RSTAG_GROUPER = 'rstag';

/**
 * `treeCac['restGrouper']` value: the same blocks and chips as
 * {@link RSTAG_GROUPER}, scored by the TextRank channels instead.
 *
 * `rstag` reads a row against its neighbours in `tid` order, which is wrong for
 * the case this list mostly holds — a burst of sibling links opened from one
 * search page shares its vocabulary, so both TF-IDF and the neighbour centroid
 * find the same terms everywhere. This mode scores each site's rows as their own
 * working set (see {@link restTextMap}) and drops TF-IDF entirely, so a tag has
 * to be central to the row's own text or to its site's, not merely present in
 * the burst around it.
 */
export const RSTEXT_GROUPER = 'rstext';

/** Rows {@link restTagMap} scores; the rest list can hold hundreds of rows. */
export const RSTAG_LIMIT = 200;

/** Rows {@link restTextMap} scores. */
export const RSTEXT_LIMIT = 200;

/** Heading of the trailing `rsess` block holding recr's non-session rows. */
export const RECR_CONFIG_LABEL = 'recr config';

/** Values that leave the rest list flat, without headings. */
export const FLAT_GROUPERS = ['', 'none'];

/** Heading for rows whose `dt` is missing or unparseable. */
export const UNDATED_LABEL = 'undated';

/** Ref prefix a grouper script row is listed under. */
export const REST_GROUPER_PREFIX = 'restGroupers';

/**
 * Chrome history visit time of a row (`rec.visitTime`), the second axis `rsid`
 * splits on.
 *
 * @param da - Row to read.
 * @returns Epoch milliseconds, or 0 when absent or not a usable number.
 */
const visitMs = (da: Da): number => {
  const v = (da.rec as { visitTime?: unknown } | undefined)?.visitTime;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * Rows newest `tid` first, the order every built-in starts from. `iq` already
 * returns this order, so the sort only makes it explicit here.
 *
 * @param das - Rows below the pin cards.
 * @returns A `tid`-descending copy.
 */
const byTidDesc = (das: Da[]): Da[] => [...das].sort((a, b) => (b.tid ?? 0) - (a.tid ?? 0));

/** Heading text for an epoch-millisecond instant. */
const msLabel = (ms: number): string => new Date(ms).toLocaleString();

/**
 * Whether `treeCac['restGrouper']` names a `type='src'` row rather than a
 * built-in. Script groupers resolve asynchronously, so the caller can skip the
 * synchronous path for them.
 *
 * @param grouper - `treeCac['restGrouper']` value.
 * @returns True when the value selects a script row.
 */
export const isRestGrouperScript = (grouper: string | undefined): boolean =>
  !!grouper && !FLAT_GROUPERS.includes(grouper) && !BUILT_IN_GROUPERS.has(grouper);

/** One block holding every row, for the flat and fallback paths. */
const flatGroup = (das: Da[]): RestGroup[] =>
  das.length > 0 ? [{ key: '', label: '', items: das }] : [];

/**
 * Built-in `rsdt`: rows sorted by `tid` descending, then split into one block
 * per distinct `dt`, newest first; rows with no `dt` trail in one block.
 *
 * @param das - Rows below the pin cards.
 * @returns The blocks, in render order.
 */
export function groupByDt(das: Da[]): RestGroup[] {
  const rows = byTidDesc(das);
  const dated = rows
    .filter((d) => dtMs(d.dt) > 0)
    .sort((a, b) => dtMs(b.dt) - dtMs(a.dt));

  const groups: RestGroup[] = [];
  for (const d of dated) {
    const key = String(dtMs(d.dt));
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(d);
    else groups.push({ key, label: msLabel(dtMs(d.dt)), items: [d] });
  }

  const undated = rows.filter((d) => !(dtMs(d.dt) > 0));
  if (undated.length > 0) groups.push({ key: UNDATED_LABEL, label: UNDATED_LABEL, items: undated });
  return groups;
}

/**
 * Built-in `rsid`: {@link groupByDt} plus a visit-time level, so each date block
 * splits into one subgroup per distinct `rec.visitTime`, newest first. Rows with
 * no visit time stay directly under the date heading, and a date block holding
 * no visit times at all renders exactly like `rsdt`.
 *
 * @param das - Rows below the pin cards.
 * @returns The blocks, in render order.
 */
export function groupByDtVisit(das: Da[]): RestGroup[] {
  return groupByDt(das).map((g) => {
    const timed = g.items.filter((d) => visitMs(d) > 0);
    if (timed.length === 0) return g;
    timed.sort((a, b) => visitMs(b) - visitMs(a));

    const subs: RestGroup[] = [];
    for (const d of timed) {
      const key = String(visitMs(d));
      const last = subs[subs.length - 1];
      if (last && last.key === key) last.items.push(d);
      else subs.push({ key, label: msLabel(visitMs(d)), items: [d] });
    }
    return { ...g, items: g.items.filter((d) => visitMs(d) === 0), subgroups: subs };
  });
}

/**
 * Built-in `rsess`: one block per session, newest session first, plus a trailing
 * block for recr's rows that name no session (`settings/main`, `tools/*`).
 *
 * Session rows carry no `dt`, so the dt-based built-ins would collapse every row
 * into one `undated` block. A session's label is its id, with the meta row's
 * title appended when that row holds one.
 *
 * @param das - recr rows, as `f=recr` reads them.
 * @returns The blocks, in render order.
 */
export function groupBySession(das: Da[]): RestGroup[] {
  const blocks = new Map<string, { items: Da[]; meta?: Da; label: string; stamp: number }>();
  const config: Da[] = [];

  for (const d of byTidDesc(das)) {
    const ref = parseSessionRef(d.ref);
    if (!ref) {
      config.push(d);
      continue;
    }
    let held = blocks.get(ref.sessionId);
    if (!held) {
      held = { items: [], label: `${SESSION_PREFIX}${ref.sessionId}`, stamp: 0 };
      blocks.set(ref.sessionId, held);
    }
    held.stamp = Math.max(held.stamp, daStamp(d));
    // the meta row heads its block; the node rows keep the newest-tid-first order
    if (ref.kind === 'meta') {
      held.meta = d;
      const title = metaTitle(d.txt);
      if (title) held.label = `${SESSION_PREFIX}${ref.sessionId} · ${title}`;
    } else {
      held.items.push(d);
    }
  }

  const ordered = [...blocks.entries()].sort((a, b) => b[1].stamp - a[1].stamp);
  const groups: RestGroup[] = ordered.map(([key, b]) => ({
    key, label: b.label, items: b.meta ? [b.meta, ...b.items] : b.items,
  }));
  if (config.length > 0) {
    groups.push({ key: RECR_CONFIG_LABEL, label: RECR_CONFIG_LABEL, items: config });
  }
  return groups;
}

/** Built-in groupers by their `treeCac['restGrouper']` value. */
const BUILT_IN_GROUPERS = new Map<string, (das: Da[]) => RestGroup[]>([
  [RSDT_GROUPER, groupByDt],
  [RSID_GROUPER, groupByDtVisit],
  [RSSESS_GROUPER, groupBySession],
  // the tag chips are a decoration layer, so the blocks are `rsdt` itself
  [RSTAG_GROUPER, groupByDt],
  [RSTEXT_GROUPER, groupByDt],
]);

/** Options for {@link restTagMap}. */
export interface RestTagOptions {
  /** Priority tags for the keyword trie; defaults to the tags the scored rows already carry. */
  priorityTags?: string[];
  /** Rows scored, newest `tid` first; defaults to {@link RSTAG_LIMIT}. */
  limit?: number;
  /** Extra channels, e.g. an API `embed`/`classify`, and weight overrides. Omitted leaves the local lexical channels only. */
  tag?: TagRowsOptions;
}

/** Priority tags of a rest pass: the tags the scored rows themselves carry. */
const restPriorityTags = (rows: Da[]): string[] =>
  [...new Set(rows.flatMap((d) => d.tags ?? []))].filter((t) => t !== 'pin' && t !== TAG_DEL);

/**
 * Key one pass's reports by `tid`, dropping any tag the row already carries so
 * the chips only ever show what `srctag` would add.
 *
 * @param rows rows the pass scored
 * @param reports reports the pass returned
 * @returns one report per scored row, keyed by `tid`
 */
function ownTagLess(rows: Da[], reports: RowTagReport[]): Map<number, RowTagReport> {
  const held = new Map(rows.map((d) => [d.tid, new Set(d.tags ?? [])]));
  const out = new Map<number, RowTagReport>();
  for (const r of reports) {
    if (typeof r.tid !== 'number') continue;
    const own = held.get(r.tid);
    out.set(r.tid, own ? { ...r, tags: r.tags.filter((t) => !own.has(t.tag)) } : r);
  }
  return out;
}

/**
 * Run `srctag` over the rest rows and key its reports by `tid`, for the `rstag`
 * grouper's chips. Only the newest {@link RSTAG_LIMIT} rows are scored, a tag a
 * row already carries is dropped, and nothing is written back.
 *
 * @param das rows below the pin cards
 * @param opts priority tags, row cap, and channel overrides
 * @returns one report per scored row, keyed by `tid`
 */
export async function restTagMap(das: Da[], opts: RestTagOptions = {}): Promise<Map<number, RowTagReport>> {
  const rows = byTidDesc(das).slice(0, opts.limit ?? RSTAG_LIMIT);
  const priorityTags = opts.priorityTags ?? restPriorityTags(rows);
  const reports = await tagRowReports(rows as TagRow[], {
    ...opts.tag,
    window: { dim: 'tid', ...opts.tag?.window },
    priorityTags,
  });
  return ownTagLess(rows, reports);
}

/**
 * The `rstext` pass: score each site's rows as their own working set, on the
 * visit-time dimension, with TF-IDF suppressed and TextRank carrying the score.
 *
 * Bucketing by hostname is what the neighbour window cannot do on its own — a
 * burst of sibling links from one search page shares its vocabulary, so a row's
 * nearest neighbours are the wrong evidence for what it is about, while its
 * site's other rows are the right one. Within a bucket the window is the
 * visit-time one, so the rows a user opened together still pool their terms.
 *
 * Nothing is written back; the caller renders the reports as chips.
 *
 * @param das rows below the pin cards
 * @param opts priority tags, row cap, and channel overrides
 * @returns one report per scored row, keyed by `tid`
 */
export async function restTextMap(das: Da[], opts: RestTagOptions = {}): Promise<Map<number, RowTagReport>> {
  const rows = byTidDesc(das).slice(0, opts.limit ?? RSTEXT_LIMIT);
  const priorityTags = opts.priorityTags ?? restPriorityTags(rows);
  const reports = await tagRowReports(rows as TagRow[], {
    ...opts.tag,
    bucket: 'domain',
    score: { ...RSTEXT_TAG_SCORE, ...opts.tag?.score },
    window: { dim: 'visitTime', ...opts.tag?.window },
    priorityTags,
  });
  return ownTagLess(rows, reports);
}

/** One tag the rest list's `srctag` pass scored highly, with the rows that support it. */
export interface RestTagHint {
  tag: string;
  /** Highest score any scored row gave the tag. */
  score: number;
  /** Rows whose report suggests the tag. */
  rows: Da[];
}

/**
 * Holder of the rest list's last `srctag` pass, shared with the userbar
 * omnibox's suggestion zone (and with `rstag`'s own chips) so one pass serves
 * both and the zone does not rescore the same rows.
 */
class RestTagStore {
  private map: Map<number, RowTagReport> = new Map();
  private rows: Da[] = [];
  private listeners = new Set<() => void>();

  /**
   * Publish one pass.
   *
   * @param map one report per scored row, keyed by `tid`
   * @param rows the rows that pass scored, in its own order
   */
  set(map: Map<number, RowTagReport>, rows: Da[]): void {
    this.map = map;
    this.rows = rows;
    for (const l of this.listeners) l();
  }

  /** Rows the last pass reported; 0 before the first pass resolves. */
  get size(): number {
    return this.map.size;
  }

  /**
   * Watch for a new pass.
   *
   * @param fn called after every {@link set}
   * @returns the unsubscribe function
   */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /**
   * The most important suggestions of the last pass: tags ranked by how many
   * scored rows suggest them, then by their best score, so breadth decides
   * before confidence.
   *
   * @param n how many hints to return
   * @returns the hints, most important first
   */
  rank(n: number): RestTagHint[] {
    const byTag = new Map<string, RestTagHint>();
    for (const row of this.rows) {
      const report = row.tid === undefined ? undefined : this.map.get(row.tid);
      if (!report) continue;
      for (const t of report.tags) {
        const hit = byTag.get(t.tag);
        if (hit) {
          hit.rows.push(row);
          hit.score = Math.max(hit.score, t.score);
        } else {
          byTag.set(t.tag, { tag: t.tag, score: t.score, rows: [row] });
        }
      }
    }
    return [...byTag.values()]
      .sort((a, b) => b.rows.length - a.rows.length || b.score - a.score)
      .slice(0, n);
  }
}

/** Shared holder of the rest list's `srctag` pass; see {@link RestTagStore}. */
export const restTagStore = new RestTagStore();

/**
 * The synchronous half of {@link groupRest}: flat and built-in grouping.
 *
 * @param das - Rows below the pin cards.
 * @param grouper - `treeCac['restGrouper']` value.
 * @returns The blocks, or null when `grouper` needs a script row.
 */
export function restGroupsFor(das: Da[], grouper: string | undefined): RestGroup[] | null {
  if (isRestGrouperScript(grouper)) return null;
  if (!grouper || FLAT_GROUPERS.includes(grouper)) return flatGroup(das);
  return BUILT_IN_GROUPERS.get(grouper)?.(das) ?? flatGroup(das);
}

/** One block a grouper script returned, before normalization. */
interface GroupLike {
  key?: unknown;
  label?: unknown;
  items?: unknown;
  subgroups?: unknown;
}

/** Shape test for one block a grouper script returned: rows or subgroups. */
const isGroupLike = (v: unknown): v is GroupLike => {
  const g = v as GroupLike;
  return typeof v === 'object' && v !== null
    && (Array.isArray(g.items) || Array.isArray(g.subgroups));
};

/**
 * Normalize a script block, keeping an optional visit-time level.
 *
 * @param g - Block a script returned.
 * @param fallbackKey - Index to use when the block carries no `key`.
 * @returns The block in render order.
 */
const toGroup = (g: GroupLike, fallbackKey: number): RestGroup => ({
  key: String(g.key ?? fallbackKey),
  label: String(g.label ?? ''),
  items: Array.isArray(g.items) ? g.items as Da[] : [],
  ...(Array.isArray(g.subgroups)
    ? { subgroups: g.subgroups.filter(isGroupLike).map((s, i) => toGroup(s, i)) }
    : {}),
});

/**
 * Groups `das` by a `type='src'` grouper row. The row's body runs through the
 * same {@link runBody} path as `run_src`, with `ctx.args = { das }`, and returns
 * the block array. A block carries `items`, `subgroups`, or both. A missing row,
 * a throwing body, or a result that is not an array of blocks falls back to the
 * flat list so the region never blanks.
 *
 * @param das - Rows below the pin cards.
 * @param grouper - Ref of the `type='src'` grouper row.
 * @returns The blocks, in render order.
 */
export async function groupRest(das: Da[], grouper: string | undefined): Promise<RestGroup[]> {
  if (!isRestGrouperScript(grouper)) return restGroupsFor(das, grouper) ?? flatGroup(das);
  const ref = grouper as string;
  const body = await getStore().readScript(ref);
  if (body === undefined) {
    console.error(`restGrouper: no type='src' row for ${ref}`);
    return flatGroup(das);
  }
  try {
    const out = await runBody(body, { db, ref, args: { das }, console });
    if (!Array.isArray(out) || !out.every(isGroupLike)) {
      throw new Error('grouper must return an array of { items } or { subgroups }');
    }
    return out.map(toGroup);
  } catch (e) {
    console.error(`restGrouper ${ref} failed: ${e instanceof Error ? e.message : String(e)}`);
    return flatGroup(das);
  }
}
