/**
 * qarf.ts — query-adaptive rank fusion: the rest list's readings fused with a
 * weight that follows the row, rather than one channel split for the whole pass.
 *
 * Reciprocal rank fusion treats its rankers as equally informative on every
 * query. On a rest list that is wrong twice over: a title made of rare, specific
 * tokens is read best by the exact lexical lists (`bm25`, `priority`), while a
 * title made of common words — a paraphrasis of an intent — is read best by the
 * lists that go through the row's neighbours (`textRank`, `clusterRank`) and, when
 * a `dyn` adapter supplies one, by the embedding list.
 *
 * Following QARF (Rafeeq et al., DATA 2026), the weight is a closed-form function
 * of IDF statistics the pass already has:
 *
 *   idf(t)  = log(N / df(t))                  over the pass's own working set
 *   spec(q) = mean idf of q's tokens           an unseen token takes the maximum
 *   ẑ(q)    = (spec(q) − μ_IDF) / σ_IDF
 *   λ(q)    = clip[ℓ,u]( σ(α · ẑ(q) + logit(λ₀)) )
 *
 * and the fused score applies λ to the lexical side and 1−λ to the semantic one.
 *
 * Two things make this xbb's reading rather than the paper's. The *row* is the
 * query and the *candidate tags* are the documents, so λ is read per row from
 * that row's own tokens rather than per request; and the paper's two rankers
 * become two groups of lists, which is what λ₀ — the lexical share the profile's
 * own weights already stand for — names. `alpha: 0` therefore reproduces the
 * `rrf` reading exactly, so any difference a sweep measures is the adaptive
 * weighting and nothing else.
 *
 * The same rule moves the theme stage. `discoverThemes` mixes a burst's c-TF-IDF
 * with that burst's own graph walk through one fixed `graph` weight, which is the
 * failure this module exists to remove, one stage later: a burst of rare tokens
 * is about the terms only it holds, a burst of common ones about the terms it
 * keeps returning to.
 */

import {
  RRF_TAG_SCORE, rrfTagReports, rrfTagRows,
  type AdaptiveFusion, type FusionChannel, type RrfRowsOptions, type WeightBlend,
} from './rstag';
import type { RowTagReport, TagRow, TagRowResult, TagScoreConfig } from './srctag';

/** Guard against a zero-length normalization factor. */
const EPS = 1e-6;

/**
 * Channels that read a row through its own exact lexical evidence. A row of rare
 * tokens is what these lists are good at, so they carry more of its score.
 */
export const QARF_SPARSE: readonly FusionChannel[] = ['bm25', 'priority'];

/**
 * Channels that read a row through its neighbours, and the semantic list a `dyn`
 * adapter supplies — the reading a title of common words needs.
 */
export const QARF_DENSE: readonly FusionChannel[] = ['textRank', 'clusterRank', 'embed', 'suggest'];

/**
 * Knobs of the adaptive weighting. `alpha` is the only one that moves a reading;
 * the two bounds are what keep one row from silencing a side entirely.
 */
export interface QarfConfig {
  /**
   * Steepness of the specificity → weight sigmoid. 0 reads every row the way the
   * profile's weights do, which is what makes it the control setting for a sweep.
   */
  alpha: number;
  /** Lowest lexical share any row is read with. */
  floor: number;
  /** Highest lexical share any row is read with. */
  ceil: number;
}

/** Defaults of {@link QarfConfig}: the paper's own floor and ceiling, and the steepness it recommends. */
export const DEFAULT_QARF: QarfConfig = { alpha: 1, floor: 0.1, ceil: 0.9 };

/**
 * Channel weights of the `qarf` grouper.
 *
 * Deliberately the same weighting as the `rrf` grouper's: the difference between
 * the two readings is the per-row share, not the weights, so a sweep can compare
 * them without a second confound.
 */
export const QARF_TAG_SCORE: Partial<TagScoreConfig> = { ...RRF_TAG_SCORE };

/** Options of {@link qarfTagRows}: the chain's own, plus the adaptive weighting's. */
export interface QarfRowsOptions extends RrfRowsOptions {
  /** Adaptive weighting knobs; omitted reads {@link DEFAULT_QARF}. */
  qarf?: Partial<QarfConfig>;
}

/**
 * IDF statistics of one working set: the table the paper reads a query's
 * specificity against, and the two scalars that put that specificity on a scale
 * comparable across working sets of different sizes.
 */
export interface QarfCorpus {
  /** Rows the statistics were read over. */
  n: number;
  /** Mean IDF of the vocabulary. */
  mu: number;
  /** Standard deviation of the vocabulary's IDF. */
  sigma: number;
  /** Largest IDF the corpus produced, the value a token it has never seen takes. */
  max: number;
  /** IDF per term, `log(n / df)`. */
  idf: Map<string, number>;
}

/**
 * Build the IDF table and its summary scalars over one working set.
 *
 * The corpus is the rows a pass reads, so under `bucket: 'domain'` it is one
 * site's rows and "rare" means rare within that site. A term every row holds has
 * an IDF of 0, and a term one row holds the whole `log n`.
 *
 * @param docs one row's tokens per entry, after pre-processing
 * @returns the corpus the specificity of a row is read against
 */
export function qarfCorpus(docs: string[][]): QarfCorpus {
  const n = Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const tokens of docs) for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = new Map<string, number>();
  let sum = 0;
  let max = 0;
  for (const [term, count] of df) {
    const value = Math.log(n / Math.max(1, count));
    idf.set(term, value);
    sum += value;
    if (value > max) max = value;
  }
  const mu = idf.size > 0 ? sum / idf.size : 0;
  let variance = 0;
  for (const value of idf.values()) variance += (value - mu) * (value - mu);
  const sigma = idf.size > 0 ? Math.sqrt(variance / idf.size) : 0;
  return { n: docs.length, mu, sigma, max, idf };
}

/**
 * Mean IDF of one row's own tokens: how specific, against the working set it is
 * being read in, the evidence for it is.
 *
 * A token the working set has never seen takes the corpus maximum — the
 * conservative reading of an unfamiliar word as a rare one, which the paper also
 * chooses.
 *
 * @param tokens the row's tokens
 * @param corpus statistics from {@link qarfCorpus}
 * @returns mean IDF; the corpus mean when the row has no tokens
 */
export function querySpecificity(tokens: string[], corpus: QarfCorpus): number {
  if (tokens.length === 0) return corpus.mu;
  let sum = 0;
  for (const t of tokens) sum += corpus.idf.get(t) ?? corpus.max;
  return sum / tokens.length;
}

/**
 * Specificity on the corpus's own scale, so one `alpha` means the same thing on
 * a three-row list and a three-thousand-row one. A concentrated IDF distribution
 * makes every term look alike, in which case there is nothing to adapt to.
 *
 * @param spec specificity from {@link querySpecificity}
 * @param corpus statistics from {@link qarfCorpus}
 * @returns the z score; 0 when the corpus carries no IDF spread
 */
export function specificityZ(spec: number, corpus: QarfCorpus): number {
  return corpus.sigma > EPS ? (spec - corpus.mu) / corpus.sigma : 0;
}

/**
 * The lexical share one row is read with.
 *
 * The sigmoid is shifted so a row of exactly average specificity gets the share
 * the profile's own weights stand for, which is what lets `alpha: 0` reproduce
 * the fixed reading; the clip then bounds how far a single row can lean either
 * way, so neither side is ever silenced.
 *
 * @param z the row's specificity, on the corpus's scale
 * @param share lexical share the profile's weights stand for
 * @param cfg adaptive weighting knobs
 * @returns the lexical share, inside `[floor, ceil]`
 */
export function qarfLambda(z: number, share: number, cfg: QarfConfig = DEFAULT_QARF): number {
  const lo = Math.min(cfg.floor, cfg.ceil);
  const hi = Math.max(cfg.floor, cfg.ceil);
  const neutral = Math.min(1 - EPS, Math.max(EPS, Math.min(hi, Math.max(lo, share))));
  const raw = 1 / (1 + Math.exp(-(cfg.alpha * z + Math.log(neutral / (1 - neutral)))));
  return Math.min(hi, Math.max(lo, raw));
}

/**
 * Lexical share of a pass's own weights: what fraction of the total weight its
 * enabled lists put on the exact lexical side.
 *
 * @param cfg the pass's normalized weights
 * @param channels channels of the lists that held terms
 * @returns the share, or undefined when one side carries no weight at all — with
 *   only one side enabled there is nothing to trade, and the profile's weights stand
 */
export function qarfShare(cfg: TagScoreConfig, channels: FusionChannel[]): number | undefined {
  const held = new Set(channels);
  const sum = (side: readonly FusionChannel[]) =>
    side.reduce((total, c) => (held.has(c) ? total + cfg[c] : total), 0);
  const sparse = sum(QARF_SPARSE);
  const dense = sum(QARF_DENSE);
  if (sparse <= 0 || dense <= 0) return undefined;
  return sparse / (sparse + dense);
}

/**
 * The weights one row's fusion runs with.
 *
 * λ takes the lexical group's share of the pass's total weight and 1−λ the
 * semantic group's, each group keeping the relative weights it was configured
 * with. The total is unchanged, so a fused score of 1 still means "the top of
 * every list this pass ran", and `explainTag`'s contributions still add up to the
 * score — the reason this divides the weights rather than the result, exactly as
 * the pass-wide normalization does.
 *
 * @param cfg the pass's normalized weights
 * @param channels channels of the lists that held terms
 * @param lambda the row's lexical share
 * @returns the weights to fuse this row with
 */
export function qarfRowWeights(
  cfg: TagScoreConfig, channels: FusionChannel[], lambda: number,
): TagScoreConfig {
  const held = new Set(channels);
  const sum = (side: readonly FusionChannel[]) =>
    side.reduce((total, c) => (held.has(c) ? total + cfg[c] : total), 0);
  const sparse = sum(QARF_SPARSE);
  const dense = sum(QARF_DENSE);
  const total = sparse + dense;
  if (sparse <= 0 || dense <= 0 || total <= 0) return cfg;
  const out = { ...cfg };
  for (const c of QARF_SPARSE) if (held.has(c)) out[c] = (lambda * total * cfg[c]) / sparse;
  for (const c of QARF_DENSE) if (held.has(c)) out[c] = ((1 - lambda) * total * cfg[c]) / dense;
  return out;
}

/**
 * The lexical share of every row in one working set, by that row's index.
 *
 * A row whose corpus carries no IDF spread gets the neutral share, which leaves
 * its weights alone: there is nothing in the set to tell one row's specificity
 * from another's.
 *
 * @param docs one row's tokens per entry, as the pass reads them
 * @param weights the pass's weights — only their ratios matter
 * @param channels channels of the lists that held terms
 * @param over adaptive weighting overrides
 * @returns the lexical share per row
 */
export function qarfLambdas(
  docs: string[][], weights: TagScoreConfig, channels: FusionChannel[], over: Partial<QarfConfig> = {},
): number[] {
  const cfg: QarfConfig = { ...DEFAULT_QARF, ...over };
  const corpus = qarfCorpus(docs);
  const share = qarfShare(weights, channels);
  return docs.map((tokens) => {
    if (share === undefined) return 1;
    return qarfLambda(specificityZ(querySpecificity(tokens, corpus), corpus), share, cfg);
  });
}

/**
 * The adaptive half of a `qarf` pass: the weights each row is fused with, and the
 * theme-stage scale each burst is scored with.
 *
 * `alpha: 0` returns no blend at all rather than a blend that happens to compute
 * the profile's weights, so the control setting is exact rather than
 * approximately equal.
 *
 * @param over adaptive weighting overrides
 * @returns the two hooks {@link rrfTagReports} moves the chain with
 */
export function qarfAdaptive(over: Partial<QarfConfig> = {}): AdaptiveFusion {
  const cfg: QarfConfig = { ...DEFAULT_QARF, ...over };
  const blend: NonNullable<AdaptiveFusion['blend']> = (docs) => (index) => {
    if (cfg.alpha <= 0) return undefined;
    const corpus = qarfCorpus(docs);
    const z = specificityZ(querySpecificity(docs[index] ?? [], corpus), corpus);
    const weights: WeightBlend = (pass, channels) => {
      const share = qarfShare(pass, channels);
      if (share === undefined) return { weights: pass };
      const lambda = qarfLambda(z, share, cfg);
      return { weights: qarfRowWeights(pass, channels, lambda), lambda };
    };
    return weights;
  };
  const burst: NonNullable<AdaptiveFusion['burst']> = (pooled) => {
    if (cfg.alpha <= 0) return [];
    const corpus = qarfCorpus(pooled);
    return pooled.map((tokens) => {
      const z = specificityZ(querySpecificity(tokens, corpus), corpus);
      /* The theme stage mixes c-TF-IDF with the burst's walk multiplicatively, so
         λ scales the walk instead of replacing half a sum: a burst of rare tokens
         leans on the class statistic, a burst of common ones on the walk, and a
         burst of exactly average specificity keeps `graph` as the profile sets it.
         The sigmoid is read against a neutral share of one half, which is what
         makes that last case the identity. */
      return qarfLambda(-z, 0.5, cfg) / 0.5;
    });
  };
  return { blend, burst };
}

/**
 * The λ distribution of one working set: whether a pass on this list is really
 * reading each row differently, or whether every query is more specific than the
 * corpus's mean and the weighting has collapsed into one recalibrated constant.
 *
 * @param docs one row's tokens per entry, as the pass read them
 * @param weights the pass's normalized weights
 * @param channels channels of the lists that held terms
 * @param over adaptive weighting overrides
 * @returns the mean, spread and clipped share of the per-row λ, and the neutral share
 */
export function qarfStats(
  docs: string[][], weights: TagScoreConfig, channels: FusionChannel[], over: Partial<QarfConfig> = {},
): { mean: number; sigma: number; clipped: number; neutral?: number } {
  const cfg: QarfConfig = { ...DEFAULT_QARF, ...over };
  const neutral = qarfShare(weights, channels);
  const values = qarfLambdas(docs, weights, channels, cfg);
  const mean = values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);
  const variance = values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / Math.max(1, values.length);
  const lo = Math.min(cfg.floor, cfg.ceil);
  const hi = Math.max(cfg.floor, cfg.ceil);
  const clipped = values.filter((v) => v <= lo + EPS || v >= hi - EPS).length / Math.max(1, values.length);
  return { mean, sigma: Math.sqrt(variance), clipped, ...(neutral === undefined ? {} : { neutral }) };
}

/**
 * The pass options a `qarf` reading actually scores with: this grouper's own
 * preset under whatever the caller named, so the two chain groupers can be moved
 * apart later without a second call-site change.
 */
const withPreset = (opts: QarfRowsOptions): QarfRowsOptions =>
  ({ ...opts, score: { ...QARF_TAG_SCORE, ...opts.score } });

/**
 * Score rows through the 3-stage chain with each row's own fusion weight.
 *
 * @param rows rows to score, in any order
 * @param opts channels, the three stages' knobs, and the adaptive weighting's
 * @returns one result per scored row, in the working set's order
 */
export async function qarfTagRows(rows: TagRow[], opts: QarfRowsOptions = {}): Promise<TagRowResult[]> {
  return rrfTagRows(rows, withPreset(opts), qarfAdaptive(opts.qarf));
}

/**
 * Score rows through the adaptive chain and return each row's tags with the stats
 * a hover needs.
 *
 * @param rows rows to score, in any order
 * @param opts channels, configuration, and the adaptive weighting's
 * @param adaptive the two hooks, when the caller has already resolved them
 * @returns one report per scored row, in the working set's order
 */
export async function qarfTagReports(
  rows: TagRow[], opts: QarfRowsOptions = {}, adaptive?: AdaptiveFusion,
): Promise<RowTagReport[]> {
  return rrfTagReports(rows, withPreset(opts), adaptive ?? qarfAdaptive(opts.qarf));
}
