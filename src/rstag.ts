/**
 * rstag.ts — the rest list's tagging engine.
 *
 * Two things live here. The first is the pass machinery every tag grouper runs:
 * cap the working set, resolve the priority tags, score, drop the tags a row
 * already carries, run the aim pass, and key the reports by `tid`. The second is
 * the 3-stage hybrid pipeline the `rrf` grouper scores with.
 *
 * The pipeline exists because an exact keyword matcher (TurboText/FlashText) is
 * fast and rigid: it is a recall layer, not a ranking one. Read as three stages:
 *
 *   1. *Candidates* — `TurboTextTagger`, plus the row's own tokens and the
 *      classifier's labels. Exact and cheap, O(text) whatever the dictionary holds.
 *   2. *Statistical ranking* — {@link bm25fScores}, BM25F over weighted fields,
 *      so a term the title carries outranks the same term in a URL, with `k1`
 *      damping repetition and `b` normalizing a long field.
 *   3. *Semantic bucketing and expansion* — {@link reciprocalRankFusion} fuses the
 *      ranked lists by rank rather than by score, which is what lets a BM25F list
 *      and a cosine list be combined without calibrating either; and
 *      {@link cTfIdf} with MMR ({@link discoverThemes}) reads the terms
 *      *distinctive to* one burst, which is what a sub-tag is.
 *
 * Nothing here talks to the store or the DOM. Rows arrive structurally, the
 * embedding and classifier calls are injected, and the one thing this module
 * cannot own — loading the `srctag/*` adapter rows — reaches it as
 * {@link RestPassSpec.dyn}, so the scoring half stays pure and a caller that
 * has no store can still run a pass.
 *
 * The lexical primitives (tokenizer, trie, TextRank, BM25F's vector maths) come
 * from `src/srctag.ts`; this module composes them into a pass rather than
 * re-implementing them.
 */

import {
  DEFAULT_TAG_AIM, RSTEXT_TAG_SCORE, TAG_DEL, TurboTextTagger,
  clusterRows, cosineDense, defaultWindow, keywordEntries, mergeTagScore,
  neighbourhood, pinPriorityTags, rankTags, reportRowTags, rowSources, sortByDim, tagRowReports,
  textRank, tokenize, urlTokens,
  type KeywordMatch, type RowTagReport, type SparseVector,
  type TagAimConfig, type TagDim, type TagParts, type TagRow, type TagRowResult, type TagRowsOptions,
  type TagScoreConfig,
} from './srctag';

// ─── The rest-list pass ────────────────────────────────────────────────────

/** Rows {@link restTagMap} scores; the rest list can hold hundreds of rows. */
export const RSTAG_LIMIT = 200;

/** Rows {@link restTextMap} scores. */
export const RSTEXT_LIMIT = 200;

/** Options for {@link restTagMap}, {@link restTextMap} and a profile pass. */
export interface RestTagOptions {
  /** Priority tags for the keyword trie; defaults to the pin cards', then to the scored rows' own tags. */
  priorityTags?: string[];
  /** Pin `md` cards whose `#tag` headings supply the priority tags of an algorithm pass. */
  pins?: TagRow[];
  /** Rows scored, newest `tid` first; defaults to the pass's own cap. */
  limit?: number;
  /** Extra channels, e.g. an API `embed`/`classify`, and weight overrides. Omitted leaves the local lexical channels only. */
  tag?: TagRowsOptions;
  /**
   * Filter values the list is showing. Their terms never become candidates — a
   * list filtered on `suffix_GoogleSearch` must not propose `google` on every
   * row of it; see {@link filterTerms}.
   */
  filters?: string[];
}

/** Rows newest `tid` first, the order every rest pass starts from. */
const byTidDesc = (das: TagRow[]): TagRow[] => [...das].sort((a, b) => (b.tid ?? 0) - (a.tid ?? 0));

/** Priority tags of a rest pass: the tags the scored rows themselves carry. */
const restPriorityTags = (rows: TagRow[], skip?: (tag: string) => boolean): string[] =>
  [...new Set(rows.flatMap((d) => d.tags ?? []))]
    .filter((t) => t !== 'pin' && t !== TAG_DEL && !(skip?.(t) ?? false));

/**
 * Key one pass's reports by `tid`, dropping any tag the row already carries so
 * the chips only ever show what a pass would add.
 *
 * @param rows rows the pass scored
 * @param reports reports the pass returned
 * @returns one report per scored row, keyed by `tid`
 */
function ownTagLess(rows: TagRow[], reports: RowTagReport[]): Map<number, RowTagReport> {
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
export interface RestPassSpec {
  dim: TagDim;
  bucket?: 'domain';
  score: Partial<TagScoreConfig>;
  limit: number;
  /** Read the priority tags from the pin cards rather than from the scored rows. */
  pinsPriority: boolean;
  /** Aim knobs, or `false` to leave the raw scores; see `srctag.applyTagAim`. */
  aim: Partial<TagAimConfig> | false;
  /**
   * Pipeline the rows are scored with. The default `fusion` is `srctag`'s
   * weighted channel sum; `rrf` is this module's 3-stage chain.
   */
  pipeline?: 'fusion' | 'rrf';
  /** BM25F knobs of the `rrf` pipeline. */
  bm25?: Partial<Bm25Config> & { fields?: Record<string, number> };
  /** Rank constant of the `rrf` fusion. */
  rrf?: Partial<RrfConfig>;
  /** Sub-tag discovery knobs of the `rrf` pipeline. */
  buckets?: Partial<BucketConfig>;
  /** Pre-processing knobs of the `rrf` pipeline: the corpus frequency floor and the terms to drop. */
  global?: Partial<GlobalConfig> & { exclude?: string[] };
  /**
   * Resolve the dynamic channels for a pass, given the priority tags it ended up
   * with. Only a caller that can reach the store supplies one; the scoring half
   * then runs whatever adapters came back.
   */
  dyn?: (priorityTags: string[]) => Promise<TagRowsOptions>;
}

/**
 * Shared body of the rest-list tag passes: cap the rows, resolve the priority
 * tags, score, drop what the rows already carry, and run the aim pass.
 *
 * @param das rows below the pin cards.
 * @param spec the pass's dimension, weights, cap, priority source, aim, and pipeline.
 * @param opts the caller's priority tags, pin cards, row cap, and channel overrides.
 * @returns one report per scored row, keyed by `tid`.
 */
export async function runRestPass(
  das: TagRow[], spec: RestPassSpec, opts: RestTagOptions = {},
): Promise<Map<number, RowTagReport>> {
  const rows = byTidDesc(das).slice(0, opts.limit ?? spec.limit);
  /* The pin cards' `#tag` headings are the curated half of an algorithm pass; a
     table with no pin card falls back to the rows' own tags, so the trie the
     priority channel builds is never empty. */
  const pinTags = spec.pinsPriority ? pinPriorityTags(opts.pins ?? []) : [];
  /* The rrf pipeline reads its curated half off the rows only when they are
     topics; a provenance tag is the capture context, not one, and its terms are
     dropped from the evidence anyway. */
  const priorityTags = opts.priorityTags
    ?? (pinTags.length > 0 ? pinTags : restPriorityTags(rows, spec.pipeline === 'rrf' ? isProvenanceTag : undefined));
  /* A dynamic adapter is a network call, so only a pass that asked for one makes
     it; the aim pass reads the same priority list the fusion did. */
  const dyn = spec.dyn ? await spec.dyn(priorityTags) : {};
  const shared: TagRowsOptions = {
    ...opts.tag,
    ...dyn,
    ...(spec.bucket ? { bucket: spec.bucket } : {}),
    score: { ...spec.score, ...opts.tag?.score },
    window: { dim: spec.dim, ...opts.tag?.window },
    priorityTags,
    aim: spec.aim === false ? false : { ...spec.aim },
  };
  /* The list's own filter is named evidence of what a row is *not* about, so its
     terms are dropped the way the corpus frequency floor drops a term the whole
     working set carries. */
  const named = filterTerms(opts.filters ?? []);
  const global = {
    ...spec.global,
    ...(named.length > 0 ? { exclude: [...(spec.global?.exclude ?? []), ...named] } : {}),
  };
  const reports = spec.pipeline === 'rrf'
    ? await rrfTagReports(rows, {
      ...shared, bm25: spec.bm25, rrf: spec.rrf, buckets: spec.buckets, global,
    })
    : await tagRowReports(rows, shared);
  return ownTagLess(rows, reports);
}

/**
 * Run a fused pass over the rest rows and key its reports by `tid`, for the
 * `rstag` grouper's chips. Only the newest {@link RSTAG_LIMIT} rows are scored,
 * a tag a row already carries is dropped, and nothing is written back.
 *
 * @param das rows below the pin cards
 * @param opts priority tags, row cap, and channel overrides
 * @returns one report per scored row, keyed by `tid`
 */
export async function restTagMap(das: TagRow[], opts: RestTagOptions = {}): Promise<Map<number, RowTagReport>> {
  return runRestPass(das, {
    dim: 'tid', score: {}, limit: RSTAG_LIMIT, pinsPriority: false, aim: false,
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
export async function restTextMap(das: TagRow[], opts: RestTagOptions = {}): Promise<Map<number, RowTagReport>> {
  return runRestPass(das, {
    dim: 'visitTime', bucket: 'domain', score: RSTEXT_TAG_SCORE,
    limit: RSTEXT_LIMIT, pinsPriority: false, aim: false,
  }, opts);
}

// ─── Stage 2: BM25F ────────────────────────────────────────────────────────

/** Field-weighted text of one row: field name → tokens. */
export type Bm25Fields = Record<string, string[]>;

/**
 * Knobs of {@link bm25fScores}. These are the three the BM25F formulation turns
 * on, and each answers one failure mode: a field weight for the fact that a
 * title names an item while a URL only files it, `k1` for keyword stuffing, and
 * `b` for a long field drowning a short one.
 */
export interface Bm25Config {
  /** Weight per field. A field absent from this map is not read at all. */
  fields: Record<string, number>;
  /** Term-frequency saturation: lower discounts a repeated term sooner. */
  k1: number;
  /** Length normalization in [0,1]: 0 ignores a field's length, 1 fully normalizes it. */
  b: number;
}

/** Defaults of {@link Bm25Config}: the title outweighs the URL and the row's own tags. */
export const DEFAULT_BM25: Bm25Config = {
  fields: { title: 3, url: 1, tags: 2 }, k1: 1.2, b: 0.75,
};

/** Statistics of one working set: the corpus a row's terms are scored against. */
export interface Bm25Corpus {
  /** Documents in the working set. */
  n: number;
  /** Documents holding a term, over every weighted field. */
  df: Map<string, number>;
  /** Mean field length, per field. */
  avgLen: Record<string, number>;
}

/** Guard against a zero-length normalization factor. */
const EPS = 1e-6;

/**
 * Corpus statistics of a working set: document frequencies and mean field
 * lengths, over the fields {@link Bm25Config.fields} weights.
 *
 * @param docs field-weighted tokens per row
 * @param cfg field weights
 * @returns the corpus {@link bm25fScores} reads
 */
export function bm25fCorpus(docs: Bm25Fields[], cfg: Bm25Config): Bm25Corpus {
  const df = new Map<string, number>();
  const total: Record<string, number> = {};
  for (const doc of docs) {
    const seen = new Set<string>();
    for (const [field, tokens] of Object.entries(doc)) {
      if (!weighted(cfg, field)) continue;
      total[field] = (total[field] ?? 0) + tokens.length;
      for (const t of tokens) seen.add(t);
    }
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avgLen: Record<string, number> = {};
  for (const [field, sum] of Object.entries(total)) avgLen[field] = sum / Math.max(1, docs.length);
  return { n: docs.length, df, avgLen };
}

/**
 * BM25F weight of every term one document holds.
 *
 * The per-field term frequencies are combined into one pseudo-frequency, each
 * field scaled by its weight and length-normalized, and the pseudo-frequency is
 * then saturated by `k1` and multiplied by the corpus IDF. That is the whole of
 * BM25F: one ranking function over a structured document, rather than one score
 * per field that a caller has to reconcile.
 *
 * @param corpus statistics from {@link bm25fCorpus}
 * @param docs the same working set the corpus was built from
 * @param index document to score
 * @param cfg field weights and the two saturating knobs
 * @returns term → weight; only terms this document holds
 */
export function bm25fScores(
  corpus: Bm25Corpus, docs: Bm25Fields[], index: number, cfg: Bm25Config,
): SparseVector {
  const doc = docs[index];
  if (!doc) return {};
  const pseudo: SparseVector = {};
  for (const [field, weight] of Object.entries(cfg.fields)) {
    if (!weighted(cfg, field)) continue;
    const tokens = doc[field];
    if (!tokens || tokens.length === 0) continue;
    const avg = corpus.avgLen[field] ?? tokens.length;
    const norm = Math.max(1 - cfg.b + cfg.b * (avg > 0 ? tokens.length / avg : 1), EPS);
    for (const token of tokens) pseudo[token] = (pseudo[token] ?? 0) + weight / norm;
  }
  const out: SparseVector = {};
  for (const [term, tfu] of Object.entries(pseudo)) {
    out[term] = bm25Idf(corpus, term) * (tfu / (cfg.k1 + tfu));
  }
  return out;
}

/** BM25's IDF: `log(1 + (N - df + 0.5) / (df + 0.5))`, so a term in every document scores near 0. */
function bm25Idf(corpus: Bm25Corpus, term: string): number {
  const df = corpus.df.get(term) ?? 0;
  return Math.log(1 + (corpus.n - df + 0.5) / (df + 0.5));
}

/**
 * Whether a field takes part: a field the config does not name, or weights at 0,
 * is not read at all — not read at weight 0, which would still put its length
 * into the corpus statistics.
 */
function weighted(cfg: Bm25Config, field: string): boolean {
  return (cfg.fields[field] ?? 0) > 0;
}

/** Terms of a score map, best first; ties break on the term so a run is reproducible. */
export function rankedTerms(scores: SparseVector, limit = Infinity): string[] {
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return (Number.isFinite(limit) ? sorted.slice(0, limit) : sorted).map(([t]) => t);
}

// ─── Pre-processing: the terms that are not evidence ───────────────────────

/**
 * Tag families that describe how a row was captured rather than what it is
 * about. A row's own provenance tag is dropped from its evidence whatever its
 * frequency, because `dev_saOpera` on every row of a list says which browser
 * opened them, not what any one of them is: `suffix_` is the title tail
 * `fc.txtRx` strips, `dev_` is what `sdb.dev_PREFFIX` names, and `ref_` is the
 * domain tag that family reserved.
 */
export const PROVENANCE_TAG_PREFIXES = ['suffix_', 'dev_', 'ref_'];

/**
 * Whether a tag names how a row was captured rather than what it is about.
 *
 * @param tag tag to test
 * @returns true for a provenance tag
 */
export const isProvenanceTag = (tag: string): boolean =>
  PROVENANCE_TAG_PREFIXES.some((p) => tag.startsWith(p));

/**
 * Knobs of the pre-processing step that runs before any stage scores a row: the
 * terms that sit on a row without being about it, which every keyword extractor
 * drops some version of.
 *
 * A *stop word* is a function word; a *global term* is one the working set as a
 * whole carries; a *provenance tag* is the row's capture context; and a *named
 * term* is one the caller already knows is structural because the list is
 * filtered on it. {@link excludedTerms} resolves the first two once per pass, and
 * `rrfRowsInSet` adds each row's own provenance terms before tokenizing that row.
 */
export interface GlobalConfig {
  /**
   * Share of the working set that may hold a term before it is dropped as
   * global, over the title, the URL and the row's own tags together. 1 reads the
   * whole set as evidence and drops nothing.
   */
  maxDf: number;
  /**
   * Rows the working set needs before the share means anything. Three rows make
   * every term "global" — a term holds 100% of them at df 3 — so a pass too
   * small to have a corpus keeps all of its terms.
   */
  minRows: number;
  /** Terms dropped whatever their frequency. */
  exclude: string[];
  /**
   * Function words dropped by name, on top of the tokenizer's shared
   * `STOP_WORDS`. That list belongs to every pipeline, so this one carries the
   * English words it leaves out: a short title's `vs`, `how` and `any` are
   * central to its TextRank walk and rare enough to pass the frequency floor,
   * which is how they reach a chip. A *length* floor is not the answer — it
   * counts characters, so raising it to catch `vs` also drops every CJK bigram,
   * which is a whole token in this tokenizer.
   */
  stop: string[];
}

/**
 * English function words the shared tokenizer list leaves out: interrogatives,
 * quantifiers, connectives and the prepositions that show up in a page title.
 * Deliberately no verbs or nouns — `use`, `make` and `based` carry a topic often
 * enough to stay, and a stop list that guesses wrong silently hides a chip.
 */
export const DEFAULT_STOP_WORDS: string[] = [
  'vs', 'versus', 'how', 'why', 'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'whether',
  'any', 'all', 'some', 'such', 'like', 'unlike', 'than', 'then', 'there', 'here',
  'more', 'most', 'much', 'many', 'less', 'least', 'only', 'also', 'just', 'even',
  'still', 'yet', 'ever', 'never', 'always', 'often', 'sometimes',
  'after', 'before', 'during', 'since', 'until', 'while', 'about', 'around',
  'above', 'below', 'under', 'over', 'between', 'within', 'without', 'behind', 'beyond',
  'again', 'because', 'though', 'although', 'however', 'therefore', 'thus', 'instead', 'rather',
];

/** Defaults of {@link GlobalConfig}: a term in more than three of every five rows is not evidence. */
export const DEFAULT_GLOBAL: GlobalConfig = {
  maxDf: 0.6, minRows: 8, exclude: [], stop: DEFAULT_STOP_WORDS,
};

/**
 * The terms a filter value names, so a list can drop what it is itself about.
 *
 * `suffix_GoogleSearch` — the tag `fc.txtRx` writes for a title ending in
 * `Google Search` — is `suffix`, `google` and `search` as evidence, and none of
 * the three tells a reader anything about one row of a list filtered on it. The
 * value is split on its separators and again on camelCase boundaries, and the
 * whole value, each separator part and each camel piece are returned
 * lower-cased — `googlesearch` among them, because that is the token the
 * tokenizer derives from the tag itself.
 *
 * @param values filter values, as `treeCac` holds them
 * @returns the terms, deduplicated in first-appearance order
 */
export function filterTerms(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    const term = t.trim().toLowerCase();
    if (!term || seen.has(term)) return;
    seen.add(term);
    out.push(term);
  };
  for (const value of values) {
    const raw = String(value ?? '').trim();
    if (!raw) continue;
    add(raw);
    for (const part of raw.split(/[_\-.:/|=]+/)) {
      add(part);
      for (const piece of part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) add(piece);
    }
  }
  return out;
}

/**
 * Terms held by more than `maxDf` of a working set: its corpus-level stop list.
 *
 * @param docs tokens per row, over every evidence source the pass reads
 * @param maxDf share of the set a term may occur in and still count as evidence
 * @param minRows rows the set needs before the share is read at all
 * @returns the terms to drop
 */
export function globalTerms(
  docs: string[][], maxDf = DEFAULT_GLOBAL.maxDf, minRows = DEFAULT_GLOBAL.minRows,
): Set<string> {
  const out = new Set<string>();
  if (docs.length < minRows || maxDf >= 1) return out;
  const df = new Map<string, number>();
  for (const tokens of docs) for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  for (const [term, count] of df) if (count / docs.length > maxDf) out.add(term);
  return out;
}

/**
 * Whether the pass reads a row's URLs at all: the token bag does it under
 * `urls`, and the BM25F `url` field does it under its own weight.
 *
 * @param opts the pass's channels
 * @returns true when either source is on
 */
const readsUrls = (opts: RrfRowsOptions): boolean =>
  (opts.urls ?? true) || (opts.bm25?.fields?.url ?? DEFAULT_BM25.fields.url ?? 0) > 0;

/**
 * Everything the pass must not propose for this working set: the terms the
 * caller named, plus whatever the corpus frequency floor calls global.
 *
 * The frequency is measured over the whole pass rather than over one bucket, so
 * "global" means global to the list the reader is looking at whatever the
 * window switch says.
 *
 * @param rows the pass's working set
 * @param opts the pass's channels, for whether the URL is read
 * @param cfg the resolved pre-processing knobs
 * @returns the terms to drop
 */
function excludedTerms(rows: TagRow[], opts: RrfRowsOptions, cfg: GlobalConfig): Set<string> {
  const out = new Set([...cfg.exclude, ...cfg.stop].map(t => t.trim().toLowerCase()).filter(Boolean));
  if (cfg.maxDf >= 1 || rows.length < cfg.minRows) return out;
  const useUrls = readsUrls(opts);
  const docs = rows.map((row) => {
    const sources = rowSources(row);
    const tags = (row.tags ?? []).flatMap(t => tokenize(t));
    return [...tokenize(sources.text), ...(useUrls ? sources.urls.flatMap(urlTokens) : []), ...tags];
  });
  for (const term of globalTerms(docs, cfg.maxDf, cfg.minRows)) out.add(term);
  return out;
}

// ─── Stage 3a: reciprocal rank fusion ──────────────────────────────────────

/** Knobs of {@link rankMaps}. */
export interface RrfConfig {
  /**
   * Rank constant. A larger value flattens how much the top of a list is worth,
   * so one list's first place stops deciding the fusion on its own.
   */
  k: number;
}

/** Defaults of {@link RrfConfig}: the constant the original RRF paper reports. */
export const DEFAULT_RRF: RrfConfig = { k: 60 };

/**
 * Reciprocal rank fusion of several ranked lists: `Σ 1 / (k + rank)`.
 *
 * Ranks, not scores, are what gets combined, so a BM25F weight and an embedding
 * cosine need no calibration to be fused — the reason this is the fusion step
 * rather than another weighted sum. A term absent from a list contributes
 * nothing from it, so a term several lists agree on outranks one that tops a
 * single list.
 *
 * @param lists ranked term lists; each is read in the order given
 * @param k rank constant
 * @returns term → fused reciprocal-rank weight
 */
export function reciprocalRankFusion(lists: string[][], k = DEFAULT_RRF.k): SparseVector {
  const out: SparseVector = {};
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((term, i) => {
      if (seen.has(term)) return;
      seen.add(term);
      out[term] = (out[term] ?? 0) + 1 / (k + i + 1);
    });
  }
  return out;
}

/** Rank of each term in one list, the first occurrence winning. */
function rankMaps(lists: string[][], k: number): Map<string, number>[] {
  return lists.map((list) => {
    const out = new Map<string, number>();
    list.forEach((term, i) => {
      if (!out.has(term)) out.set(term, 1 / (k + i + 1));
    });
    return out;
  });
}

/** Order-preserving deduplication. */
function unique(terms: string[]): string[] {
  return [...new Set(terms)];
}

// ─── Stage 3b: c-TF-IDF and MMR ────────────────────────────────────────────

/**
 * Class-based TF-IDF over one bucket per class: the term frequency inside the
 * class, weighted by how *rare* the term is across the classes.
 *
 * This is what tells a theme from a common word. A term every bucket holds has a
 * large global frequency and is discounted; a term one bucket holds and the
 * others do not is what that bucket is about, which plain frequency cannot see.
 *
 * @param classes token multisets, one per class
 * @returns one term → score map per class, in the order given
 */
export function cTfIdf(classes: string[][]): SparseVector[] {
  const globalTf = new Map<string, number>();
  const perClass: Map<string, number>[] = classes.map((tokens) => {
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
      globalTf.set(t, (globalTf.get(t) ?? 0) + 1);
    }
    return tf;
  });
  const avgLen = classes.reduce((sum, c) => sum + c.length, 0) / Math.max(1, classes.length);
  return perClass.map((tf) => {
    const out: SparseVector = {};
    for (const [term, count] of tf) {
      out[term] = count * Math.log(1 + avgLen / Math.max(1, globalTf.get(term) ?? 1));
    }
    return out;
  });
}

/** Character-bigram Jaccard distance, the similarity MMR keeps candidates apart by. */
export function termSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const out = new Set<string>();
    for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return a === b ? 1 : 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return shared / (ga.size + gb.size - shared);
}

/**
 * Maximal marginal relevance: pick the best items while penalizing the ones
 * that repeat a choice already made.
 *
 * A bucket's most distinctive terms are often near-synonyms of one another, so
 * taking the top-K by score alone would mint three ways of saying one thing.
 *
 * @param items scored candidates
 * @param k how many to pick
 * @param lambda trade-off: 1 is pure relevance, 0 pure diversity
 * @param similarity comparison used for the redundancy penalty
 * @returns the picked items, in pick order
 */
export function mmrSelect<T>(
  items: { item: T; score: number }[], k: number, lambda: number, similarity: (a: T, b: T) => number,
): T[] {
  const pool = [...items];
  const picked: T[] = [];
  while (picked.length < k && pool.length > 0) {
    let best = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const redundancy = picked.reduce((max, p) => Math.max(max, similarity(pool[i].item, p)), 0);
      const value = lambda * pool[i].score - (1 - lambda) * redundancy;
      if (value > bestValue) {
        bestValue = value;
        best = i;
      }
    }
    picked.push(pool[best].item);
    pool.splice(best, 1);
  }
  return picked;
}

/** Knobs of the `rrf` pipeline's bucket half. */
export interface BucketConfig {
  /** MMR trade-off: 1 keeps the highest c-TF-IDF terms, 0 the most distinct ones. */
  lambda: number;
  /** Share of the TextRank centrality folded into a theme's score; 0 leaves the graph out. */
  graph: number;
}

/** Defaults of {@link BucketConfig}. */
export const DEFAULT_BUCKETS: BucketConfig = { lambda: 0.7, graph: 0.5 };

/** Terms of a token list with their counts. */
function countTerms(tokens: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tokens) out.set(t, (out.get(t) ?? 0) + 1);
  return out;
}

/**
 * Themes one bucket proposes: terms distinctive to it, diversified.
 *
 * The two halves answer the two readings of "what is this burst about". c-TF-IDF
 * says which terms this bucket has and its neighbours do not, and the TextRank
 * walk over the bucket's pooled tokens says which of those the bucket actually
 * keeps coming back to; MMR then drops the near-duplicates of one another.
 *
 * @param pooled one token multiset per class, the buckets of the working set
 * @param buckets discovery knobs
 * @param min occurrences a term needs inside its own class
 * @param top most themes one class mints
 * @param skip term that is already the class's own anchor
 * @returns one theme list per class, in the order given
 */
export function discoverThemes(
  pooled: string[][], buckets: Partial<BucketConfig>, min: number, top: number, skip: string[] = [],
): string[][] {
  const cfg = { ...DEFAULT_BUCKETS, ...buckets };
  const scores = cTfIdf(pooled);
  return pooled.map((tokens, i) => {
    const counts = countTerms(tokens);
    const rank = cfg.graph > 0 ? textRank(tokens, { minLength: 2 }) : {};
    const candidates: { item: string; score: number }[] = [];
    for (const [term, n] of counts) {
      if (n < min || term === skip[i]) continue;
      candidates.push({ item: term, score: (scores[i][term] ?? 0) * (1 + cfg.graph * (rank[term] ?? 0)) });
    }
    candidates.sort((a, b) => b.score - a.score || a.item.localeCompare(b.item));
    return mmrSelect(candidates, top, cfg.lambda, termSimilarity);
  });
}

// ─── The 3-stage pipeline ──────────────────────────────────────────────────

/**
 * Channel weights of the `rrf` grouper: BM25F is the statistical list, the two
 * TextRank walks and the trie are the lexical ones, and `embed` — the semantic
 * list — only exists once a `dyn` adapter supplies an embedder. `tfidf` is 0
 * because BM25F *is* this pipeline's statistical channel.
 *
 * The cut-off is calibrated against the normalized fused score of
 * {@link rrfExplainCfg}, not against a raw channel value: 1 means the top of
 * every list this pass ran. On a short title that scale is flat — every
 * candidate sits in the first few ranks of every list, so `minScore` and the aim
 * pass's cut-off keep almost all of them — which leaves `topK` as the knob that
 * decides how many chips a row keeps, and the pre-processing as the one that
 * decides whether they are worth keeping. {@link rrfScore} is what resolves these
 * weights, so a caller that names only some channels still gets this preset for
 * the rest.
 */
export const RRF_TAG_SCORE: Partial<TagScoreConfig> = {
  tfidf: 0, bm25: 1, embed: 1, textRank: 0.6, clusterRank: 0.4, priority: 1,
  keyword: 0, suggest: 0.5, topK: 5, minScore: 0.12,
};

/** Options of {@link rrfTagRows}: the fusion's channels plus the three stages' own knobs. */
export interface RrfRowsOptions extends TagRowsOptions {
  /** Stage 2: the BM25F fields and their saturating knobs. */
  bm25?: Partial<Bm25Config> & { fields?: Record<string, number> };
  /** Stage 3a: the rank constant of the fusion. */
  rrf?: Partial<RrfConfig>;
  /** Stage 3b: the sub-tag discovery's knobs. */
  buckets?: Partial<BucketConfig>;
  /** The pre-processing step: the corpus frequency floor, and the terms the caller already knows are structural. */
  global?: Partial<GlobalConfig> & { exclude?: string[] };
}

/** One ranked list feeding the fusion, with the channel its contribution is reported under. */
interface RrfList {
  channel: keyof TagParts;
  terms: string[];
  weight: number;
}

/**
 * Every channel weight the fusion will actually read, divided by the best score
 * the enabled lists could jointly give one term.
 *
 * The fused score is normalized so 1 means "the top of every list this pass
 * ran", which is what lets {@link TagScoreConfig.minScore} and
 * {@link TagAimConfig.aimMin} keep their meaning here; dividing the *weights*
 * rather than the result is what keeps `channels[].contribution` adding up to
 * `score` in `srctag.explainTag`.
 *
 * @param cfg the run's weights
 * @param enabled lists this pass will produce (a weight above 0 *and* a channel with something to say)
 * @param k rank constant
 * @returns the weights a caller explains the run's suggestions with
 */
export function rrfExplainCfg(cfg: TagScoreConfig, enabled: (keyof TagParts)[], k: number): TagScoreConfig {
  const total = enabled.reduce((sum, c) => sum + cfg[c], 0);
  const best = total > 0 ? total / (k + 1) : 1;
  const out = { ...cfg };
  for (const channel of enabled) out[channel] = cfg[channel] / best;
  return out;
}

/** A promoted theme's channel breakdown: nothing but the rows that proposed it. */
const themeParts = (n: number): TagParts => ({
  tfidf: 0, bm25: 0, embed: 0, textRank: 0, clusterRank: 0, priority: 0, keyword: 0, suggest: 0,
  group: n,
});

/** The terms a row's own provenance tags name; see {@link PROVENANCE_TAG_PREFIXES}. */
const provenanceTerms = (row: TagRow): string[] =>
  (row.tags ?? []).filter(isProvenanceTag).flatMap((tag) => tokenize(tag));

/**
 * Score one bucket's rows through all three stages.
 *
 * @param rows the working set, already one bucket's worth
 * @param opts channels and the three stages' knobs
 * @param explainCfg the weights this run explains its suggestions with
 * @returns one result per scored row, in the working set's order
 */
async function rrfRowsInSet(
  rows: TagRow[], opts: RrfRowsOptions, weight: TagScoreConfig, cfg: TagScoreConfig,
  drop: Set<string>,
): Promise<TagRowResult[]> {
  const k = opts.rrf?.k ?? DEFAULT_RRF.k;
  const bm25Cfg: Bm25Config = {
    ...DEFAULT_BM25, ...opts.bm25, fields: { ...DEFAULT_BM25.fields, ...opts.bm25?.fields },
  };

  const windowCfg = defaultWindow(opts.window?.dim ?? 'tid', opts.window);
  const sorted = sortByDim(rows, windowCfg.dim);
  const clusters = clusterRows(sorted, windowCfg);
  const clusterOf = new Map<number, number>();
  for (const c of clusters) for (const i of c.indices) clusterOf.set(i, c.key);

  /* A dropped term is removed from the *inputs*, not filtered out of the result:
     a global term left in the token bag still reaches a graph walk and comes back
     through a rank, and a curated tag left in the trie still proposes itself. */
  const perRow = sorted.map((row) => {
    const extra = provenanceTerms(row);
    return extra.length === 0 ? drop : new Set([...drop, ...extra]);
  });
  const keep = (tokens: string[], i: number): string[] =>
    (perRow[i].size === 0 ? tokens : tokens.filter(t => !perRow[i].has(t)));
  const useUrls = opts.urls ?? true;
  const sources = sorted.map(rowSources);
  const texts = sources.map(s => (useUrls ? [s.text, ...s.urls] : [s.text]).join(' '));
  const docs = sources.map((s, i) => keep(useUrls
    ? [...tokenize(s.text), ...s.urls.flatMap(urlTokens)]
    : tokenize(s.text), i));
  /* Fields rather than one bag: the title, the URL, and the row's own tags are
     the three things a row says about itself, and BM25F weights them apart. */
  const fields: Bm25Fields[] = sorted.map((row, i) => ({
    title: keep(tokenize(sources[i].text), i),
    /* The `url` field is its own weight, so it reads the row's URLs whenever that
       weight is above 0 — `urls` governs the token bag the trie and the graph
       walks read, not this field. */
    url: keep(sources[i].urls.flatMap(urlTokens), i),
    tags: keep(unique((row.tags ?? []).filter(t => !isProvenanceTag(t))).flatMap(t => tokenize(t)), i),
  }));
  const corpus = bm25fCorpus(fields, bm25Cfg);

  const priority = opts.priorityTags ?? pinPriorityTags(opts.pins ?? []);
  const tagger = new TurboTextTagger(keywordEntries(priority, opts.synonyms), opts.trie);

  const only = opts.onlyTids ? new Set(opts.onlyTids) : undefined;
  const kept: number[] = [];
  const keywords: KeywordMatch[][] = [];
  const suggestions: { tag: string; score: number }[][] = [];
  const candidates = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    if (only && (row.tid === undefined || !only.has(row.tid))) continue;
    kept.push(i);
    const hits = tagger.match(texts[i]).filter(h => !drop.has(h.tag));
    keywords.push(hits);
    const labels = opts.classify && opts.labels
      ? (await opts.classify(texts[i], opts.labels)).filter(s => !drop.has(s.tag))
      : [];
    suggestions.push(labels);
    for (const t of docs[i]) candidates.add(t);
    for (const h of hits) candidates.add(h.tag);
    for (const s of labels) candidates.add(s.tag);
  }

  /* The semantic list needs a vector per row and per candidate term, so both go
     in one batched call — that is what makes a cosine ranking affordable here
     without a request per term. A caller that supplies only precomputed row
     vectors (`opts.embeddings`) gets no semantic list: there is nothing to score
     a candidate term against. */
  let rowVecs: (ArrayLike<number> | undefined)[] | undefined;
  let termVecs: Map<string, ArrayLike<number>> | undefined;
  if (opts.embed) {
    const terms = [...candidates];
    const vecs = await opts.embed([...texts, ...terms]);
    rowVecs = vecs.slice(0, texts.length);
    termVecs = new Map(terms.map((t, i) => [t, vecs[texts.length + i] ?? []]));
  }

  const results: TagRowResult[] = [];
  for (let n = 0; n < kept.length; n++) {
    const i = kept[n];
    const row = sorted[i];
    const own = new Set(docs[i]);
    const win = neighbourhood(sorted, i, windowCfg);
    const lists: RrfList[] = [];

    if (weight.bm25 > 0) {
      lists.push({ channel: 'bm25', terms: rankedTerms(bm25fScores(corpus, fields, i, bm25Cfg)), weight: weight.bm25 });
    }
    if (weight.textRank > 0) {
      lists.push({ channel: 'textRank', terms: rankedTerms(textRank(docs[i], opts.rank)), weight: weight.textRank });
    }
    if (weight.clusterRank > 0) {
      /* Gated on the row's own copy of the term, the rule the priority channel
         follows: the burst can lift a term the row carries, never introduce one. */
      const pooled = textRank(win.indices.flatMap(j => docs[j] ?? []), opts.rank);
      lists.push({
        channel: 'clusterRank',
        terms: rankedTerms(pooled).filter(t => own.has(t)),
        weight: weight.clusterRank,
      });
    }
    if (weight.priority > 0 && keywords[n].length > 0) {
      const ordered = [...keywords[n]]
        .sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1) || a.start - b.start)
        .map(h => h.tag);
      lists.push({ channel: 'priority', terms: unique(ordered), weight: weight.priority });
    }
    if (weight.suggest > 0 && suggestions[n].length > 0) {
      const ordered = [...suggestions[n]].sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));
      lists.push({ channel: 'suggest', terms: unique(ordered.map(s => s.tag)), weight: weight.suggest });
    }
    if (weight.embed > 0 && termVecs && rowVecs?.[i]) {
      const rowVec = rowVecs[i];
      const ranked = [...candidates]
        .map(t => ({ t, s: cosineDense(rowVec, termVecs!.get(t) ?? []) }))
        .sort((a, b) => b.s - a.s || a.t.localeCompare(b.t))
        .map(x => x.t);
      lists.push({ channel: 'embed', terms: ranked, weight: weight.embed });
    }

    const active = lists.filter(l => l.terms.length > 0);
    const ranks = rankMaps(active.map(l => l.terms), k);
    /* Ranked before cutting: `rankTags` reads its input in score order and keeps
       the survivors in that order, which is what makes the first suggestion the
       one a sub-tag is anchored to. */
    const scored = [...new Set(active.flatMap(l => l.terms))].map((tag) => {
      const parts: TagParts = {
        tfidf: 0, bm25: 0, embed: 0, textRank: 0, clusterRank: 0, priority: 0, keyword: 0, suggest: 0,
        group: 0,
      };
      let score = 0;
      active.forEach((list, li) => {
        const value = ranks[li].get(tag);
        if (value === undefined) return;
        parts[list.channel] = value;
        score += cfg[list.channel] * value;
      });
      return { tag, score, parts };
    }).sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));

    results.push({
      row,
      suggestions: rankTags(scored, cfg),
      window: win,
      dim: windowCfg.dim,
      cluster: clusterOf.get(i) ?? 0,
      keywords: keywords[n],
    });
  }
  return results;
}

/**
 * Focus a scored set, then mint a sub-tag for each term a bucket shares.
 *
 * The focus half is `srctag.applyTagAim`'s rule, so an `rrf` chip list is cut
 * the same way every other grouper's is. The promote half is stage 3b: where
 * `applyTagAim` mints a theme on a plain row count, this scores the bucket's
 * terms by c-TF-IDF and the bucket's own TextRank walk, then takes the
 * diversified top few — the terms the bucket is *about*, not merely the ones it
 * repeats.
 *
 * Evidence still comes from before the focus cut, so the filter cannot erase the
 * signal it is reading, and a promoted tag is always a term some scored set
 * already proposed.
 *
 * @param results scored rows, as {@link rrfTagRows} returns them
 * @param aim aim overrides; `aimMin` is clamped up to the run's own cut-off
 * @param buckets discovery knobs
 * @param minScore the run's `minScore`
 * @returns new results carrying the focused lists and the promoted sub-tags
 */
export function applyRrfBuckets(
  results: TagRowResult[],
  aim: Partial<TagAimConfig> = {},
  buckets: Partial<BucketConfig> = {},
  minScore = 0,
): TagRowResult[] {
  const cfg = { ...DEFAULT_TAG_AIM, ...aim };
  const cut = Math.max(cfg.aimMin, minScore);
  const priority = new Set(aim.priorityTags ?? []);

  const focused = results.map((r) => ({
    ...r,
    suggestions: r.suggestions.filter(
      (s) => s.parts.priority > 0 || priority.has(s.tag) || s.score >= cut,
    ),
  }));
  if (!cfg.promote || cfg.promoteMin <= 0) return focused;

  /* One bucket per burst and anchor: the rows that kept the same top tag inside
     the same cluster of the same ordering. */
  const anchor = focused.map((r) => r.suggestions[0]?.tag ?? '');
  const groups = new Map<string, { anchor: string; members: number[]; pooled: string[] }>();
  results.forEach((r, i) => {
    const key = `${r.dim}\u0000${r.cluster}\u0000${anchor[i]}`;
    let group = groups.get(key);
    if (!group) {
      group = { anchor: anchor[i], members: [], pooled: [] };
      groups.set(key, group);
    }
    group.members.push(i);
    group.pooled.push(...r.suggestions.map((s) => s.tag));
  });

  const list = [...groups.values()];
  const themes = discoverThemes(list.map(g => g.pooled), buckets, cfg.promoteMin, cfg.promoteTop,
    list.map(g => g.anchor));
  list.forEach((group, gi) => {
    const counts = countTerms(group.pooled);
    for (const i of group.members) {
      /* The row's own tags, and whatever focus already kept of it, are terms it
         carries; a sub-tag repeats neither. */
      const carried = new Set([...(results[i].row.tags ?? []), ...focused[i].suggestions.map((s) => s.tag)]);
      for (const theme of themes[gi]) {
        const tag = anchor[i] ? `${anchor[i]}${cfg.sep}${theme}` : theme;
        if (carried.has(tag)) continue;
        carried.add(tag);
        const strength = counts.get(theme) ?? 0;
        focused[i].suggestions.push({ tag, score: strength, parts: themeParts(strength) });
      }
    }
  });
  return focused;
}

/** The enabled weight-carrying channels of one `rrf` pass, for {@link rrfExplainCfg}. */
function enabledChannels(cfg: TagScoreConfig, has: { embed: boolean; classify: boolean; priority: boolean }): (keyof TagParts)[] {
  const out: (keyof TagParts)[] = [];
  if (cfg.bm25 > 0) out.push('bm25');
  if (cfg.textRank > 0) out.push('textRank');
  if (cfg.clusterRank > 0) out.push('clusterRank');
  if (cfg.priority > 0 && has.priority) out.push('priority');
  if (cfg.suggest > 0 && has.classify) out.push('suggest');
  if (cfg.embed > 0 && has.embed) out.push('embed');
  return out;
}

/**
 * The weights an `rrf` run scores with: this pipeline's own preset, moved by
 * whatever the caller named.
 *
 * The preset is merged rather than assumed, because a caller that names only a
 * channel or two — a test, or a `run_src` row — wants the pipeline it asked for,
 * not {@link TagScoreConfig}'s fusion defaults, whose channels this pipeline does
 * not all run.
 *
 * @param opts the run's own overrides
 * @returns every weight resolved
 */
export function rrfScore(opts: RrfRowsOptions = {}): TagScoreConfig {
  return mergeTagScore({ ...RRF_TAG_SCORE, ...opts.score });
}

/** Everything both entry points need resolved before a row is scored. */
function rrfSettings(opts: RrfRowsOptions): {
  weight: TagScoreConfig; cfg: TagScoreConfig; k: number; priority: string[]; global: GlobalConfig;
} {
  const weight = rrfScore(opts);
  const k = opts.rrf?.k ?? DEFAULT_RRF.k;
  const priority = opts.priorityTags ?? pinPriorityTags(opts.pins ?? []);
  const cfg = rrfExplainCfg(weight, enabledChannels(weight, {
    embed: !!opts.embed,
    classify: !!(opts.classify && opts.labels),
    priority: priority.length > 0,
  }), k);
  const global = { ...DEFAULT_GLOBAL, ...opts.global, exclude: opts.global?.exclude ?? [] };
  return { weight, cfg, k, priority, global };
}

/**
 * Score tags for every row through the 3-stage chain.
 *
 * Rows are ordered on the configured dimension and split by hostname when
 * `bucket: 'domain'` is set, exactly as `srctag.tagRows` does it, so the two
 * pipelines read the same working sets.
 *
 * @param rows rows to score, in any order
 * @param opts channels and the three stages' knobs
 * @returns one result per scored row, in the working set's order
 */
export async function rrfTagRows(rows: TagRow[], opts: RrfRowsOptions = {}): Promise<TagRowResult[]> {
  const { weight, cfg, global } = rrfSettings(opts);
  const drop = excludedTerms(rows, opts, global);
  if (opts.bucket === 'domain') {
    const out: TagRowResult[] = [];
    for (const bucket of domainBuckets(rows).values()) {
      out.push(...await rrfRowsInSet(bucket, { ...opts, bucket: undefined }, weight, cfg, drop));
    }
    return out;
  }
  return rrfRowsInSet(rows, opts, weight, cfg, drop);
}

/** Rows grouped by the hostname they were saved from, first-appearance order. */
function domainBuckets(rows: TagRow[]): Map<string, TagRow[]> {
  const out = new Map<string, TagRow[]>();
  for (const row of rows) {
    const key = hostOf(row);
    const held = out.get(key);
    if (held) held.push(row);
    else out.set(key, [row]);
  }
  return out;
}

/** Hostname of a row, `www.` stripped, or `''` when the row names no absolute URL. */
function hostOf(row: TagRow): string {
  for (const candidate of [row.rec?.url, row.ref]) {
    if (typeof candidate !== 'string') continue;
    try {
      return new URL(candidate).hostname.replace(/^www\./, '');
    } catch {
      // a ref that is not an absolute URL says nothing about the row's site
    }
  }
  return '';
}

/**
 * Score rows through the 3-stage chain and return each row's tags with the stats
 * a hover needs. `opts.aim` runs {@link applyRrfBuckets} between the scoring and
 * the report; the raw scores are the default.
 *
 * @param rows rows to score, in any order
 * @param opts channels and configuration
 * @returns one report per scored row, in the working set's order
 */
export async function rrfTagReports(rows: TagRow[], opts: RrfRowsOptions = {}): Promise<RowTagReport[]> {
  const dim = opts.window?.dim ?? 'tid';
  const { weight, cfg, priority } = rrfSettings(opts);
  const scored = await rrfTagRows(rows, opts);
  const results = opts.aim === undefined || opts.aim === false ? scored : applyRrfBuckets(scored, {
    ...opts.aim,
    priorityTags: opts.aim.priorityTags ?? priority,
  }, opts.buckets, weight.minScore);
  return results.map((r) => reportRowTags(r, cfg, dim));
}
