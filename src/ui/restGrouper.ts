// src/ui/restGrouper.ts
import { db, daStamp, type Da } from '../sdb';
import { dtMs } from '../fc';
import { getStore, runBody } from '../recr';
import { metaTitle, parseSessionRef, SESSION_PREFIX } from '../sessionTree';
import { modelVecCache, type VecCache } from '../vecCache';
import {
  DEFAULT_TAG_SCORE, DEFAULT_TEXTRANK, DEFAULT_TRIE, embedWithCache, pinPriorityTags, RSTEXT_TAG_SCORE,
  SRCTAG_EMBED_REF, TAG_DEL, tagRowReports,
  type RowTagReport, type TagAimConfig, type TagDim, type TagParts, type TagRow, type TagRowsOptions,
  type TagScoreConfig, type TextRankOptions, type TrieOptions,
} from '../srctag';
import { loadAdapterSet, type AdapterSet } from './srctagSmoke';

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

/**
 * `treeCac['restGrouper']` value: the same blocks and chips as
 * {@link RSTAG_GROUPER}, scored by the frequency family alone — TF-IDF over the
 * row's own text and its URLs, against the neighbour centroid.
 *
 * The tuner beside the list moves this family's weights, its window, and its
 * cut-offs live; see {@link REST_PROFILES}.
 */
export const RSFREQ_GROUPER = 'rsfreq';

/**
 * `treeCac['restGrouper']` value: the same blocks and chips, scored by the two
 * TextRank walks alone — the row's own centrality and the neighbour burst's.
 *
 * This is {@link RSTEXT_GROUPER}'s channel set read on the default `tid` window
 * rather than on a site-bucketed visit-time one, so the tuner's window switch is
 * the only thing that separates the two readings.
 */
export const RSTRANK_GROUPER = 'rstrank';

/**
 * `treeCac['restGrouper']` value: the same blocks and chips, scored by the
 * TurboText Aho–Corasick trie alone — the keywords the pin cards and the
 * `srctag/keywords.md` doc hold.
 *
 * The trie channel has a weight of its own ({@link TagScoreConfig.keyword})
 * here; everywhere else a keyword match only lifts the priority channel.
 */
export const RSTT_GROUPER = 'rstt';

/** Rows {@link restTagMap} scores; the rest list can hold hundreds of rows. */
export const RSTAG_LIMIT = 200;

/** Rows {@link restTextMap} scores. */
export const RSTEXT_LIMIT = 200;

/**
 * Ordering and bucketing a rest pass reads a row in. `domain` is the visit-time
 * window restricted to the row's own site, which is the reading a burst of
 * sibling links needs; `tid`, `dt` and `visitTime` read the row against its
 * neighbours in that dimension instead.
 */
export type RestWindowMode = 'tid' | 'dt' | 'visitTime' | 'domain';

/** The window modes the tuner offers, in render order. */
export const REST_WINDOW_MODES: { value: RestWindowMode; label: string }[] = [
  { value: 'tid', label: 'tid window' },
  { value: 'dt', label: 'dt window' },
  { value: 'visitTime', label: 'visitTime window' },
  { value: 'domain', label: 'domain (visitTime)' },
];

/**
 * The dimension and bucket one {@link RestWindowMode} names.
 *
 * @param mode - window mode.
 * @returns the `tagRows` ordering dimension, plus the bucket for `domain`.
 */
export const restWindowSpec = (mode: RestWindowMode): { dim: TagDim; bucket?: 'domain' } =>
  mode === 'domain' ? { dim: 'visitTime', bucket: 'domain' } : { dim: mode };

/** Weight keys a rest pass can be tuned on. */
export type RestKnob = keyof TagParts;

/**
 * How the panel above the blocks reads a grouper's pass. `chips` is the tag
 * layer alone — today's view — and the other modes replace the blocks with the
 * reading that one algorithm is actually about.
 */
export type RestVizMode = 'chips' | 'priority' | 'themes' | 'channels' | 'keywords';

/** The visualization modes the tuner offers, in render order. */
export const REST_VIZ_MODES: { value: RestVizMode; label: string }[] = [
  { value: 'chips', label: 'chips (tags only)' },
  { value: 'priority', label: 'priority coverage' },
  { value: 'themes', label: 'theme groups' },
  { value: 'channels', label: 'channel shares' },
  { value: 'keywords', label: 'keyword hits' },
];

/** Mode a grouper starts on when its profile names none: the view it renders today. */
export const REST_VIZ_DEFAULT: RestVizMode = 'chips';

/**
 * One algorithm grouper's default hyperparameters and the knobs its tuner
 * offers. The defaults are what a fresh mount starts on, and nothing is
 * persisted, so a reload restores them.
 */
export interface RestTagProfile {
  /** Channels this family scores with, and their default weights. */
  score: Partial<TagScoreConfig>;
  /** Knobs the tuner exposes for this family, in render order. */
  knobs: RestKnob[];
  /** Window a fresh mount starts on. */
  mode: RestWindowMode;
  /** Rows scored. */
  limit: number;
  /**
   * Whether a row's URL feeds the channels. Off for the three algorithm
   * groupers: a hostname label or a path segment (`dev`, `docs`, `org`) is the
   * noisiest evidence a link row has, and the title is what names it.
   */
  urls: boolean;
  /**
   * Whether the priority tags come from the pin cards rather than from the
   * scored rows' own tags. A pin card is the user's statement of what the links
   * are about; the two read-path groupers instead read the rows' own tags, which
   * is what lets a tag on one row lend itself to its neighbours.
   */
  pinsPriority: boolean;
  /** Whether the aim pass (`srctag.applyTagAim`) runs over the pass's rows. */
  aim: boolean;
  /** Mode the panel starts on; unset means {@link REST_VIZ_DEFAULT}. */
  viz?: RestVizMode;
  /** TextRank knobs the tuner offers, for the families that walk the graph. */
  rank?: TextRankOptions;
  /** Trie knobs the tuner offers, for `rstt`. */
  trie?: TrieOptions;
}

/**
 * The five tag groupers' presets. The three algorithm groupers isolate one family
 * as the scorer — TF-IDF for `rsfreq`, the two TextRank walks for `rstrank`, the
 * TurboText trie for `rstt` — while the priority channel stays on in all three,
 * because the pin cards' `#tag` headings are the curated half of what they
 * propose. The two read paths, `rstag` and `rstext`, keep the fused default and
 * the TextRank preset.
 *
 * The three algorithm defaults are starting points, not answers; the tuner is
 * there to move them against a real table.
 */
export const REST_PROFILES: Record<string, RestTagProfile> = {
  [RSTAG_GROUPER]: {
    score: {},
    knobs: ['tfidf', 'embed', 'priority', 'suggest'],
    mode: 'tid',
    limit: RSTAG_LIMIT,
    urls: true,
    pinsPriority: false,
    aim: false,
  },
  [RSTEXT_GROUPER]: {
    score: RSTEXT_TAG_SCORE,
    knobs: ['textRank', 'clusterRank', 'priority'],
    mode: 'domain',
    limit: RSTEXT_LIMIT,
    urls: true,
    pinsPriority: false,
    aim: false,
    rank: DEFAULT_TEXTRANK,
  },
  [RSFREQ_GROUPER]: {
    score: {
      tfidf: 1, embed: 0, textRank: 0, clusterRank: 0,
      priority: 0.5, keyword: 0, suggest: 0, topK: 5, minScore: 0.3,
    },
    knobs: ['tfidf', 'priority'],
    mode: 'tid',
    limit: RSTAG_LIMIT,
    urls: false,
    pinsPriority: true,
    aim: true,
  },
  [RSTRANK_GROUPER]: {
    score: {
      tfidf: 0, embed: 0, textRank: 0.6, clusterRank: 0.4,
      priority: 0.5, keyword: 0, suggest: 0, topK: 5, minScore: 0.4,
    },
    knobs: ['textRank', 'clusterRank', 'priority'],
    mode: 'tid',
    limit: RSTAG_LIMIT,
    urls: false,
    pinsPriority: true,
    aim: true,
    rank: DEFAULT_TEXTRANK,
  },
  [RSTT_GROUPER]: {
    score: {
      tfidf: 0, embed: 0, textRank: 0, clusterRank: 0,
      priority: 0.5, keyword: 1, suggest: 0, topK: 5, minScore: 0.5,
    },
    knobs: ['keyword', 'priority'],
    mode: 'tid',
    limit: RSTAG_LIMIT,
    urls: false,
    pinsPriority: true,
    aim: true,
    trie: DEFAULT_TRIE,
  },
};

/**
 * A live tuner override for one algorithm grouper. Every field falls back to the
 * grouper's {@link RestTagProfile}.
 */
export interface RestHyper {
  /** Window the pass reads a row in. */
  mode?: RestWindowMode;
  /** Panel reading; unset means the profile's own default. */
  viz?: RestVizMode;
  /** Rows scored. */
  limit?: number;
  /** Candidate tags kept per row. */
  topK?: number;
  /** Suggestions scoring below this are dropped. */
  minScore?: number;
  /** Weight overrides, by channel. */
  weights?: Partial<Record<RestKnob, number>>;
  /** Whether the row's URLs feed the channels. */
  urls?: boolean;
  /** Whether the aim pass runs; unset means the profile's own answer. */
  aim?: boolean;
  /** Focus cut-off: the score a suggestion the priority half did not carry must clear. */
  aimMin?: number;
  /** Rows of one burst that must share a term before the aim pass mints its sub-tag. */
  promoteMin?: number;
  /** Most sub-tags one promote group mints. */
  promoteTop?: number;
  /** Load the `srctag/*` adapters into the pass — the dynamic half of `rstag`. */
  dyn?: boolean;
  /** TextRank overrides: window, damping, iterations, tolerance. */
  rank?: TextRankOptions;
  /** Trie overrides: fuzzy budget and overlap resolution. */
  trie?: TrieOptions;
}

/** One {@link RestHyper} per grouper ref, as the tuner holds it in component state. */
export type RestHyperState = Record<string, RestHyper | undefined>;

/**
 * Fold a tuner override over a grouper's profile into the score config the pass
 * runs with.
 *
 * The fold starts from the fusion's own defaults, so a profile that names only
 * some channels — `rstag` names none, and means `srctag`'s defaults — reads back
 * in the tuner as the weights the pass is actually using rather than as zeroes.
 *
 * @param profile - the grouper's defaults.
 * @param hyper - the live override, or undefined for the defaults.
 * @returns the channel weights and cut-offs `tagRows` reads.
 */
export function restHyperScore(profile: RestTagProfile, hyper?: RestHyper): Partial<TagScoreConfig> {
  const out: Partial<TagScoreConfig> = { ...DEFAULT_TAG_SCORE, ...profile.score };
  for (const knob of profile.knobs) {
    const weight = hyper?.weights?.[knob];
    if (typeof weight === 'number') out[knob] = weight;
  }
  if (hyper?.topK !== undefined) out.topK = hyper.topK;
  if (hyper?.minScore !== undefined) out.minScore = hyper.minScore;
  return out;
}

/**
 * The panel reading a grouper is on: the live override, else the profile's own,
 * else `chips`.
 *
 * @param profile - the grouper's defaults.
 * @param hyper - the live override, or undefined for the defaults.
 * @returns the mode to render.
 */
export const restVizMode = (profile: RestTagProfile, hyper?: RestHyper): RestVizMode =>
  hyper?.viz ?? profile.viz ?? REST_VIZ_DEFAULT;

/**
 * The aim knobs a pass runs with, from the profile and the live override.
 *
 * @param profile - the grouper's defaults.
 * @param hyper - the live override, or undefined for the defaults.
 * @returns the overrides for `srctag.applyTagAim`, or `false` when aim is off.
 */
export function restAim(profile: RestTagProfile, hyper?: RestHyper): Partial<TagAimConfig> | false {
  if (!(hyper?.aim ?? profile.aim)) return false;
  return {
    ...(hyper?.aimMin !== undefined ? { aimMin: hyper.aimMin } : {}),
    ...(hyper?.promoteMin !== undefined ? { promoteMin: hyper.promoteMin } : {}),
    ...(hyper?.promoteTop !== undefined ? { promoteTop: hyper.promoteTop } : {}),
  };
}

/**
 * Whether a family has anywhere to put a dynamic adapter: only a profile that
 * scores the embedding or the classifier channel can use one. A profile whose
 * `score` omits a channel still gets that channel's `DEFAULT_TAG_SCORE` weight,
 * which is why the merged config is what this reads.
 *
 * @param profile - the grouper's defaults.
 * @returns true when the tuner should offer the `dyn` flag.
 */
export const restDynCapable = (profile: RestTagProfile): boolean => {
  const score = { ...DEFAULT_TAG_SCORE, ...profile.score };
  return score.embed > 0 || score.suggest > 0;
};

/**
 * Namespace the dynamic embedder's vectors live under in `db.embs`. It names the
 * adapter row rather than a provider model, because that is the identity this
 * side can see: pointing the row at another model through `secret.md` reuses the
 * older vectors until the table is cleared.
 */
export const RSTAG_VEC_MODEL = SRCTAG_EMBED_REF;

/** Session-scoped `srctag/*` adapters; the tuner's `dyn` flag is what asks for them. */
let dynAdapters: Promise<AdapterSet> | undefined;
/** Session-scoped vector cache over `db.embs`, one namespace for the embedder. */
let dynVecs: Promise<VecCache> | undefined;
/** The same cache once it resolved, for {@link restVecStatus}. */
let dynVecCache: VecCache | undefined;

/**
 * The store's `srctag/*` adapter rows, loaded once per session.
 *
 * A missing row is a normal state, so this only rejects when the store itself
 * fails; either way it resolves to a set whose `errors` say what happened, which
 * is what the panel prints.
 *
 * @returns the adapters the store holds, and one line per problem
 */
export function restDynAdapters(): Promise<AdapterSet> {
  dynAdapters ??= loadAdapterSet().catch((e) => ({
    synonyms: {},
    errors: [`adapter load failed: ${e instanceof Error ? e.message : String(e)}`],
  }));
  return dynAdapters;
}

/**
 * The `db.embs` cache for the dynamic embedder, primed once per session.
 *
 * @returns the primed cache, or undefined when the table could not be read — the
 *   embedder then runs uncached rather than not at all
 */
async function dynVectorCache(): Promise<VecCache | undefined> {
  dynVecs ??= modelVecCache(RSTAG_VEC_MODEL);
  try {
    dynVecCache = await dynVecs;
    return dynVecCache;
  } catch (e) {
    dynVecs = undefined;
    dynVecCache = undefined;
    console.warn(`[srctag] vec cache unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/**
 * What the session's vector cache holds, for the panel's status line.
 *
 * @returns the model namespace and its counters, or undefined before a `dyn` pass ran
 */
export function restVecStatus(): { model: string; primed: number; written: number } | undefined {
  return dynVecCache
    ? { model: dynVecCache.model, primed: dynVecCache.primed, written: dynVecCache.written() }
    : undefined;
}

/**
 * The dynamic channels of one pass: the embedder behind the vector cache, and the
 * classifier asked for the tags the pass is already about.
 *
 * @param priorityTags - tags handed to the classifier as its labels
 * @returns the `tagRows` options a failed or absent adapter leaves empty
 */
async function restDynTag(priorityTags: string[]): Promise<TagRowsOptions> {
  const set = await restDynAdapters();
  const out: TagRowsOptions = {};
  if (set.embed) {
    const embed = set.embed;
    const cache = await dynVectorCache();
    out.embed = cache ? (texts) => embedWithCache(embed, RSTAG_VEC_MODEL, texts, cache) : embed;
  }
  if (set.classify) {
    out.classify = set.classify;
    out.labels = priorityTags;
  }
  return out;
}

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
  // the three algorithm groupers add their own chips to the same rsdt blocks
  [RSFREQ_GROUPER, groupByDt],
  [RSTRANK_GROUPER, groupByDt],
  [RSTT_GROUPER, groupByDt],
]);

/**
 * Whether a `treeCac['restGrouper']` value renders `srctag` chips beside the
 * rows: the two read-path presets and the three algorithm groupers do, the
 * block-only built-ins do not.
 *
 * @param grouper - `treeCac['restGrouper']` value.
 * @returns True when the value selects a tag-carrying grouper.
 */
export const isTagGrouper = (grouper: string | undefined): boolean =>
  !!grouper
  && (grouper === RSTAG_GROUPER || grouper === RSTEXT_GROUPER || grouper in REST_PROFILES);

/** Options for {@link restTagMap}, {@link restTextMap} and {@link restProfileMap}. */
export interface RestTagOptions {
  /** Priority tags for the keyword trie; defaults to the pin cards', then to the scored rows' own tags. */
  priorityTags?: string[];
  /** Pin `md` cards whose `#tag` headings supply the priority tags of an algorithm pass. */
  pins?: TagRow[];
  /** Rows scored, newest `tid` first; defaults to the pass's own cap. */
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
 * The fixed half of a rest pass: what it reads on, what it weighs, and where its
 * priority tags come from. The caller's {@link RestTagOptions} override the cap
 * and add channels.
 */
interface RestPassSpec {
  dim: TagDim;
  bucket?: 'domain';
  score: Partial<TagScoreConfig>;
  limit: number;
  /** Read the priority tags from the pin cards rather than from the scored rows. */
  pinsPriority: boolean;
  /** Aim knobs, or `false` to leave the raw scores; see `srctag.applyTagAim`. */
  aim: Partial<TagAimConfig> | false;
  /** Score with the store's `srctag/*` adapters as well as the lexical channels. */
  dyn: boolean;
}

/**
 * Shared body of the rest-list tag passes: cap the rows, resolve the priority
 * tags, score, drop what the rows already carry, and run the aim pass.
 *
 * @param das rows below the pin cards.
 * @param spec the pass's dimension, weights, cap, priority source, aim, and adapters.
 * @param opts the caller's priority tags, pin cards, row cap, and channel overrides.
 * @returns one report per scored row, keyed by `tid`.
 */
async function runRestPass(
  das: Da[], spec: RestPassSpec, opts: RestTagOptions,
): Promise<Map<number, RowTagReport>> {
  const rows = byTidDesc(das).slice(0, opts.limit ?? spec.limit);
  /* The pin cards' `#tag` headings are the curated half of an algorithm pass; a
     table with no pin card falls back to the rows' own tags, so the trie the
     priority channel builds is never empty. */
  const pinTags = spec.pinsPriority ? pinPriorityTags(opts.pins ?? []) : [];
  const priorityTags = opts.priorityTags ?? (pinTags.length > 0 ? pinTags : restPriorityTags(rows));
  /* A dynamic adapter is a network call, so only a pass that asked for one makes
     it; the aim pass reads the same priority list the fusion did. */
  const dyn = spec.dyn ? await restDynTag(priorityTags) : {};
  const reports = await tagRowReports(rows as TagRow[], {
    ...opts.tag,
    ...dyn,
    ...(spec.bucket ? { bucket: spec.bucket } : {}),
    score: { ...spec.score, ...opts.tag?.score },
    window: { dim: spec.dim, ...opts.tag?.window },
    priorityTags,
    aim: spec.aim === false ? false : { ...spec.aim },
  });
  return ownTagLess(rows, reports);
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
  return runRestPass(das, {
    dim: 'tid', score: {}, limit: RSTAG_LIMIT, pinsPriority: false, aim: false, dyn: false,
  }, opts);
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
  return runRestPass(das, {
    dim: 'visitTime', bucket: 'domain', score: RSTEXT_TAG_SCORE,
    limit: RSTEXT_LIMIT, pinsPriority: false, aim: false, dyn: false,
  }, opts);
}

/**
 * A profile pass: the family's channels score the rows, the priority tags come
 * from wherever the profile says, the aim pass runs unless the profile turned it
 * off, and the tuner's live overrides sit on top of everything.
 *
 * Nothing is written back; the caller renders the reports as chips or as the
 * panel's own reading.
 *
 * @param das rows below the pin cards
 * @param grouper one of {@link REST_PROFILES}' refs
 * @param hyper live tuner override, or undefined for the profile defaults
 * @param opts pin cards, priority tags, row cap, and channel overrides
 * @returns one report per scored row, keyed by `tid`
 */
export async function restProfileMap(
  das: Da[], grouper: string, hyper?: RestHyper, opts: RestTagOptions = {},
): Promise<Map<number, RowTagReport>> {
  const profile = REST_PROFILES[grouper];
  if (!profile) return new Map();
  const { dim, bucket } = restWindowSpec(hyper?.mode ?? profile.mode);
  const tag: TagRowsOptions = {
    ...opts.tag,
    urls: hyper?.urls ?? profile.urls,
    ...(profile.rank || hyper?.rank
      ? { rank: { ...profile.rank, ...hyper?.rank } } : {}),
    ...(profile.trie || hyper?.trie
      ? { trie: { ...profile.trie, ...hyper?.trie } } : {}),
  };
  return runRestPass(das, {
    dim, bucket, pinsPriority: profile.pinsPriority,
    score: restHyperScore(profile, hyper),
    limit: hyper?.limit ?? profile.limit,
    aim: restAim(profile, hyper),
    dyn: restDynCapable(profile) && hyper?.dyn === true,
  }, { ...opts, tag });
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
 * Which scored rows propose each tag, from one pass's reports. A chip's tooltip
 * lists them, so a suggestion is read against the items that produced it.
 *
 * @param rows the rows the pass scored, in its own order
 * @param map one report per scored row, keyed by `tid`
 * @returns tag -> rows whose report suggests it, first-suggestion order
 */
export function restTagContributors(
  rows: Da[], map: Map<number, RowTagReport>,
): Map<string, Da[]> {
  const out = new Map<string, Da[]>();
  for (const row of rows) {
    const report = row.tid === undefined ? undefined : map.get(row.tid);
    if (!report) continue;
    for (const t of report.tags) {
      const held = out.get(t.tag);
      if (held) held.push(row);
      else out.set(t.tag, [row]);
    }
  }
  return out;
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
