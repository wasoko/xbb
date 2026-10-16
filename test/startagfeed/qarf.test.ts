/**
 * @vitest-environment happy-dom
 *
 * qarf.test.ts — the adaptive fusion weight.
 *
 * The weighting is tested on its own first (the IDF table, a query's specificity,
 * the sigmoid and the group rescale) and only then through the chain, because the
 * property that matters most is a negative one: at `alpha: 0` the reading must be
 * the fixed one, exactly, so that anything a sweep shows is attributable to the
 * adaptive weighting. The invariant every scoring test carries is the one the
 * chips rely on: `channels[].contribution` adds up to the row's `score`.
 */

import { describe, expect, it } from 'vitest';
import { mergeTagScore, tokenize, type TagRow } from '../../src/srctag';
import { RRF_TAG_SCORE, applyRrfBuckets, discoverThemes, rrfTagReports, rrfTagRows, runRestPass } from '../../src/rstag';
import {
  QARF_DENSE, QARF_SPARSE, qarfAdaptive, qarfCorpus, qarfLambda, qarfRowWeights, qarfShare, qarfStats,
  qarfTagReports, qarfTagRows, querySpecificity, specificityZ,
} from '../../src/qarf';

/** A row with the fields a tab row carries, so tests read like the real store. */
const row = (tid: number, txt: string, over: Partial<TagRow> = {}): TagRow =>
  ({ tid, txt, ref: `https://example.com/${tid}`, type: 'tab', tags: [], rec: {}, ...over });

/** A pin md card, the row kind whose `#tag` headings carry the curated tags. */
const pin = (txt: string): TagRow => ({ tid: -1, txt, ref: 'pin/demo.md', type: 'md', tags: [], rec: {} });

/** The profile's weights with everything merged in, the shape a blend is handed. */
const pass = mergeTagScore({ ...RRF_TAG_SCORE });

/** The channels the chain builds a lexical list for, without a `dyn` adapter. */
const lexical: ('bm25' | 'textRank' | 'clusterRank')[] = ['bm25', 'textRank', 'clusterRank'];

describe('qarfCorpus', () => {
  it('reads IDF as log(N / df), so a term every row holds is worth nothing', () => {
    const corpus = qarfCorpus([['shared', 'a'], ['shared', 'b'], ['shared', 'c'], ['shared']]);
    expect(corpus.idf.get('shared')).toBeCloseTo(0, 12);
    expect(corpus.idf.get('a')).toBeCloseTo(Math.log(4), 12);
    expect(corpus.max).toBeCloseTo(Math.log(4), 12);
  });

  it('summarizes the vocabulary with its own mean and spread', () => {
    const corpus = qarfCorpus([['a'], ['b'], ['c'], ['a']]);
    const values = [...corpus.idf.values()];
    expect(corpus.n).toBe(4);
    expect(corpus.mu).toBeCloseTo(values.reduce((s, v) => s + v, 0) / values.length, 12);
    expect(corpus.sigma).toBeGreaterThan(0);
  });

  it('carries no spread when every term of the set is equally rare', () => {
    const corpus = qarfCorpus([['a'], ['b'], ['c']]);
    expect(corpus.sigma).toBeCloseTo(0, 12);
  });
});

describe('querySpecificity', () => {
  const corpus = qarfCorpus([['common', 'rare'], ['common'], ['common']]);

  it('is the mean IDF of the query tokens', () => {
    const expected = ((corpus.idf.get('common') ?? 0) + (corpus.idf.get('rare') ?? 0)) / 2;
    expect(querySpecificity(['common', 'rare'], corpus)).toBeCloseTo(expected, 12);
  });

  it('reads a token the corpus never saw as a rare one', () => {
    expect(querySpecificity(['unheard'], corpus)).toBeCloseTo(corpus.max, 12);
    expect(querySpecificity(['unheard'], corpus)).toBeGreaterThan(querySpecificity(['common'], corpus));
  });

  it('falls back to the corpus mean for a row with no tokens', () => {
    expect(querySpecificity([], corpus)).toBeCloseTo(corpus.mu, 12);
  });
});

describe('specificityZ', () => {
  it('is dimensionless, and 0 when the corpus carries no spread', () => {
    const flat = qarfCorpus([['a'], ['b']]);
    expect(specificityZ(9, flat)).toBe(0);
    const spread = qarfCorpus([['a', 'b', 'c'], ['a'], ['b']]);
    expect(specificityZ(spread.mu, spread)).toBeCloseTo(0, 12);
  });
});

describe('qarfLambda', () => {
  it('is the profile share at alpha 0, whatever the specificity', () => {
    for (const z of [-3, 0, 2.5]) expect(qarfLambda(z, 0.5, { alpha: 0, floor: 0.1, ceil: 0.9 })).toBeCloseTo(0.5, 12);
    expect(qarfLambda(-3, 0.75, { alpha: 0, floor: 0.1, ceil: 0.9 })).toBeCloseTo(0.75, 12);
  });

  it('leans lexical as a query gets more specific than its corpus', () => {
    const cfg = { alpha: 1, floor: 0.1, ceil: 0.9 };
    expect(qarfLambda(1, 0.5, cfg)).toBeGreaterThan(qarfLambda(-1, 0.5, cfg));
    expect(qarfLambda(0, 0.5, cfg)).toBeCloseTo(0.5, 12);
  });

  it('bounds the share, so no row silences either side', () => {
    const cfg = { alpha: 20, floor: 0.1, ceil: 0.9 };
    expect(qarfLambda(100, 0.5, cfg)).toBeCloseTo(0.9, 12);
    expect(qarfLambda(-100, 0.5, cfg)).toBeCloseTo(0.1, 12);
  });
});

describe('qarfShare', () => {
  it('is the lexical fraction of the enabled weights', () => {
    const share = qarfShare(pass, lexical)!;
    expect(share).toBeCloseTo(pass.bm25 / (pass.bm25 + pass.textRank + pass.clusterRank), 12);
    expect(share).toBeCloseTo(0.5, 12);
  });

  it('counts the semantic lists once a dyn adapter supplies them', () => {
    const all = [...QARF_SPARSE, ...QARF_DENSE];
    expect(qarfShare(pass, all)!).toBeLessThan(qarfShare(pass, lexical)!);
  });

  it('is undefined when one side carries no weight, so there is nothing to trade', () => {
    expect(qarfShare(pass, ['bm25'])).toBeUndefined();
    expect(qarfShare(pass, ['textRank', 'clusterRank'])).toBeUndefined();
  });
});

describe('qarfRowWeights', () => {
  it('is the profile weights exactly at the neutral share', () => {
    const share = qarfShare(pass, lexical)!;
    expect(qarfRowWeights(pass, lexical, share)).toEqual(pass);
  });

  it('keeps the total, so a fused score of 1 still means the top of every list', () => {
    const total = (cfg: typeof pass) => lexical.reduce((s, c) => s + cfg[c], 0);
    for (const lambda of [0.1, 0.5, 0.9]) {
      expect(total(qarfRowWeights(pass, lexical, lambda))).toBeCloseTo(total(pass), 12);
    }
  });

  it('keeps each group\'s own relative weights', () => {
    const weights = qarfRowWeights(pass, lexical, 0.8);
    expect(weights.textRank / weights.clusterRank).toBeCloseTo(pass.textRank / pass.clusterRank, 12);
  });

  it('leaves the weights alone when one side is empty', () => {
    expect(qarfRowWeights(pass, ['bm25'], 0.8)).toBe(pass);
  });
});

describe('qarfAdaptive', () => {
  const pooled = [['rare'], ['common'], ['common']];

  it('moves nothing at alpha 0, rather than recomputing the profile weights', () => {
    const adaptive = qarfAdaptive({ alpha: 0 });
    expect(adaptive.blend!([['a']])(0)).toBeUndefined();
    expect(adaptive.burst!(pooled)).toEqual([]);
  });

  it('leans a rare burst on its class statistic and a common one on its walk', () => {
    const scales = qarfAdaptive({ alpha: 2 }).burst!(pooled);
    expect(scales[0]).toBeLessThan(1);
    expect(scales[1]).toBeGreaterThan(1);
  });

  it('leaves a burst of average specificity at the profile\'s graph weight', () => {
    const scales = qarfAdaptive({ alpha: 2 }).burst!([['a'], ['b'], ['c']]);
    for (const scale of scales) expect(scale).toBeCloseTo(1, 12);
  });
});

describe('qarfStats', () => {
  it('reports the spread a sweep reads to tell adaptivity from a recalibration', () => {
    const docs = [['filler', 'word'], ['filler', 'word'], ['filler', 'word'], ['filler', 'unique']];
    const stats = qarfStats(docs, pass, lexical);
    expect(stats.neutral).toBeCloseTo(0.5, 12);
    expect(stats.sigma).toBeGreaterThan(0);
    expect(stats.mean).toBeLessThan(0.5);
  });

  it('shows no spread on a set every row is equally specific in', () => {
    const docs = [['a', 'b'], ['b', 'c'], ['c', 'a']];
    expect(qarfStats(docs, pass, lexical).sigma).toBeCloseTo(0, 12);
  });
});

describe('the adaptive chain', () => {
  /* Five rows of two common words and one of a token only it holds: one query is
     paraphrastic and one is rare, and the two must not be read the same way. */
  const mixed = [
    row(1, 'filler word'), row(2, 'filler word'), row(3, 'filler word'),
    row(4, 'filler word'), row(5, 'filler word'), row(6, 'filler unique'),
  ];
  const opts = { priorityTags: [] };

  it('reproduces the fixed reading exactly at alpha 0', async () => {
    const fixed = await rrfTagReports(mixed, opts);
    const control = await qarfTagReports(mixed, { ...opts, qarf: { alpha: 0 } });
    expect(control).toEqual(fixed);
  });

  it('reads a rare row with more lexical weight than a paraphrastic one', async () => {
    const results = await qarfTagRows(mixed, { ...opts, qarf: { alpha: 2 } });
    const rare = results.find((r) => r.row.tid === 6)!;
    const common = results.find((r) => r.row.tid === 1)!;
    expect(rare.weights!.bm25).toBeGreaterThan(common.weights!.bm25);
    expect(rare.weights!.textRank).toBeLessThan(common.weights!.textRank);
  });

  it('leaves a pass alone when only one side of the trade is enabled', async () => {
    const results = await qarfTagRows(mixed, {
      ...opts, score: { tfidf: 0, embed: 0, textRank: 0, clusterRank: 0, priority: 0, suggest: 0 },
      qarf: { alpha: 2 },
    });
    for (const r of results) expect(r.weights).toBeUndefined();
  });

  it('keeps the channel shares adding up to the score', async () => {
    const reports = await qarfTagReports(mixed, { ...opts, qarf: { alpha: 2 }, aim: {} });
    for (const report of reports) {
      for (const t of report.tags) {
        const total = t.channels.reduce((n, c) => n + c.contribution, 0);
        expect(total, `${report.tid} #${t.tag}`).toBeCloseTo(t.score, 6);
      }
    }
  });

  it('normalizes the fused score to the best the enabled lists could jointly give', async () => {
    const reports = await qarfTagReports(mixed, { ...opts, qarf: { alpha: 2 } });
    for (const report of reports) for (const t of report.tags) expect(t.score).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('is deterministic: the same run reads the same rows the same way', async () => {
    const a = await qarfTagReports(mixed, { ...opts, qarf: { alpha: 1 } });
    const b = await qarfTagReports(mixed, { ...opts, qarf: { alpha: 1 } });
    expect(b.map((r) => r.tags.map((t) => [t.tag, t.score])))
      .toEqual(a.map((r) => r.tags.map((t) => [t.tag, t.score])));
  });

  it('runs as a pass pipeline, with the chain handed over by the profile', async () => {
    const map = await runRestPass(mixed, {
      dim: 'tid', score: { ...RRF_TAG_SCORE }, limit: 10, pinsPriority: true, aim: {},
      pipeline: 'qarf',
      qarf: { ...qarfAdaptive({ alpha: 2 }), tag: qarfTagReports },
    }, { pins: [pin('## reading #filler')] });
    expect(map.size).toBe(6);
    for (const report of map.values()) expect(report.tags.length).toBeGreaterThan(0);
  });
});

describe('the adaptive theme stage', () => {
  const pooled = [['alpha', 'alpha', 'alpha', 'beta'], ['gamma', 'delta', 'epsilon']];

  it('is the identity at a scale of 1', () => {
    expect(discoverThemes(pooled, { graph: 1 }, 1, 2, [], [1, 1]))
      .toEqual(discoverThemes(pooled, { graph: 1 }, 1, 2));
  });

  it('drops the graph walk entirely at a scale of 0, the c-TF-IDF reading', () => {
    expect(discoverThemes(pooled, { graph: 1 }, 1, 2, [], [0, 0]))
      .toEqual(discoverThemes(pooled, { graph: 0 }, 1, 2));
  });

  it('leaves the promoted sub-tags untouched at alpha 0', async () => {
    const burst = [row(1, 'react hooks guide'), row(2, 'react hooks state'), row(3, 'react hooks docs')];
    const opts = { priorityTags: ['react'], aim: {} };
    const fixed = await rrfTagReports(burst, opts);
    const control = await rrfTagReports(burst, opts, qarfAdaptive({ alpha: 0 }));
    expect(control).toEqual(fixed);
  });

  it('reaches the promoted sub-tags through the burst hook', async () => {
    const burst = [row(1, 'react hooks guide'), row(2, 'react hooks state'), row(3, 'react hooks docs')];
    const scored = await rrfTagRows(burst, { priorityTags: ['react'] });
    const control = applyRrfBuckets(scored, { priorityTags: ['react'] }, {}, 0.12);
    const scaled = applyRrfBuckets(scored, { priorityTags: ['react'] }, {}, 0.12,
      qarfAdaptive({ alpha: 2 }).burst);
    const themes = (rs: typeof control) => rs.flatMap((r) => r.suggestions.map((s) => s.tag)).filter((t) => t.includes('/'));
    expect(themes(scaled)).toEqual(themes(control));
    expect(tokenize('react hooks').length).toBeGreaterThan(0);
  });
});
