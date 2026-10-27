/**
 * @vitest-environment happy-dom
 *
 * rstag.test.ts — the rest list's pass machinery and its 3-stage pipeline.
 *
 * The stages are tested apart from each other first (BM25F ranks, the fusion
 * combines ranks, c-TF-IDF tells a theme from a common word) and only then end
 * to end, so a failure names the stage that moved rather than "the chips are
 * wrong". The invariant every scoring test carries is the one the chips rely on:
 * `channels[].contribution` adds up to the row's `score`.
 */

import { describe, expect, it } from 'vitest';
import { explainTag, type TagRow } from '../src/srctag';
import {
  DEFAULT_BM25, DEFAULT_GLOBAL, DEFAULT_STOP_WORDS, RRF_TAG_SCORE, applyRrfBuckets, bm25fCorpus,
  bm25fScores, cTfIdf, discoverThemes, filterTerms, globalTerms, isProvenanceTag, mmrSelect,
  rankedTerms, reciprocalRankFusion, rrfTagReports, rrfTagRows, termSimilarity,
} from '../src/rstag';

/** A row with the fields a tab row carries, so tests read like the real store. */
const row = (tid: number, txt: string, over: Partial<TagRow> = {}): TagRow =>
  ({ tid, txt, ref: `https://example.com/${tid}`, type: 'tab', tags: [], rec: {}, ...over });

/** A pin md card, the row kind whose `#tag` headings carry the curated tags. */
const pin = (txt: string): TagRow =>
  ({ tid: -1, txt, ref: 'pin/demo.md', type: 'md', tags: [], rec: {} });

const cfg = (fields: Record<string, number>) => ({ fields, k1: 1.2, b: 0.75 });

describe('bm25fScores', () => {
  it('scores a term the title carries above the same term in a URL', () => {
    const docs = [{ title: ['pytorch'], url: ['pytorch'], tags: [] }];
    const title = bm25fCorpus(docs, cfg({ title: 3 }));
    const url = bm25fCorpus(docs, cfg({ url: 1 }));
    const onTitle = bm25fScores(title, docs, 0, cfg({ title: 3 })).pytorch;
    const onUrl = bm25fScores(url, docs, 0, cfg({ url: 1 })).pytorch;
    expect(onTitle).toBeGreaterThan(onUrl);
  });

  it('ranks a term most documents lack above one they all hold', () => {
    const docs = [
      { title: ['react', 'hooks'], url: [], tags: [] },
      { title: ['react', 'state'], url: [], tags: [] },
      { title: ['react', 'router'], url: [], tags: [] },
    ];
    const corpus = bm25fCorpus(docs, DEFAULT_BM25);
    const scores = bm25fScores(corpus, docs, 0, DEFAULT_BM25);
    expect(scores.hooks).toBeGreaterThan(scores.react);
  });

  it('lets k1 decide how much a repeated term is worth', () => {
    const docs = [
      { title: ['react'], url: [], tags: [] },
      { title: ['react', 'react', 'react'], url: [], tags: [] },
    ];
    const corpus = bm25fCorpus(docs, cfg({ title: 1 }));
    const stuffingGain = (k1: number) => {
      const curve = { fields: { title: 1 }, k1, b: 0 };
      return bm25fScores(corpus, docs, 1, curve).react / bm25fScores(corpus, docs, 0, curve).react;
    };
    // a low k1 saturates sooner, so writing the term three times buys less than
    // it does under a high one — which is the whole point of the knob
    expect(stuffingGain(0.1)).toBeLessThan(stuffingGain(20));
  });

  it('stops rewarding a field for being long as b rises', () => {
    const docs = [
      { title: ['react'], url: [], tags: [] },
      { title: ['react', 'and', 'a', 'long', 'tail', 'here'], url: [], tags: [] },
    ];
    const corpus = bm25fCorpus(docs, cfg({ title: 1 }));
    const read = (b: number, index: number) =>
      bm25fScores(corpus, docs, index, { fields: { title: 1 }, k1: 1.2, b }).react;
    expect(read(0, 1)).toBeCloseTo(read(0, 0), 12);
    expect(read(1, 0)).toBeGreaterThan(read(1, 1));
  });

  it('reads no field the config does not weight', () => {
    const docs = [{ title: ['react'], url: ['pytorch'], tags: [] }];
    const corpus = bm25fCorpus(docs, cfg({ title: 1 }));
    expect(bm25fScores(corpus, docs, 0, cfg({ title: 1 })).pytorch).toBeUndefined();
  });
});

describe('rankedTerms', () => {
  it('orders by weight and breaks a tie on the term, so a run is reproducible', () => {
    expect(rankedTerms({ b: 1, a: 1, c: 2 })).toEqual(['c', 'a', 'b']);
    expect(rankedTerms({ b: 1, a: 1, c: 2 }, 2)).toEqual(['c', 'a']);
  });
});

describe('reciprocalRankFusion', () => {
  it('fuses by rank, so two lists that swap their top agree', () => {
    const fused = reciprocalRankFusion([['a', 'b'], ['b', 'a']]);
    expect(fused.a).toBeCloseTo(fused.b, 12);
  });

  it('rewards a term several lists agree on over one that tops a single list', () => {
    const fused = reciprocalRankFusion([['x', 'a'], ['y', 'a'], ['z', 'a']]);
    expect(fused.a).toBeGreaterThan(fused.x);
    expect(fused.a).toBeCloseTo(3 / 62, 12);
  });

  it('flattens what a first place is worth as the rank constant grows', () => {
    const small = reciprocalRankFusion([['a', 'b']], 1);
    const large = reciprocalRankFusion([['a', 'b']], 100);
    expect(small.a / small.b).toBeGreaterThan(large.a / large.b);
  });

  it('counts a repeated term in one list once, at its best rank', () => {
    expect(reciprocalRankFusion([['a', 'b', 'a']], 0).a).toBe(1);
  });
});

describe('cTfIdf', () => {
  it('discounts a term every class holds, at equal in-class frequency', () => {
    const [first] = cTfIdf([['pytorch', 'shared'], ['vue', 'shared']]);
    expect(first.pytorch).toBeGreaterThan(first.shared);
  });

  it('returns one score map per class, in the order given', () => {
    const scores = cTfIdf([['a'], ['b']]);
    expect(scores).toHaveLength(2);
    expect(Object.keys(scores[1])).toEqual(['b']);
  });
});

describe('termSimilarity', () => {
  it('reads two spellings of one word as near-duplicates and two words as apart', () => {
    expect(termSimilarity('pytorch', 'pytorchs')).toBeGreaterThan(0.8);
    expect(termSimilarity('pytorch', 'vue')).toBe(0);
    expect(termSimilarity('ml', 'ml')).toBe(1);
  });
});

describe('mmrSelect', () => {
  it('takes a lower-scored distinct item over a near-duplicate of a pick', () => {
    const picked = mmrSelect([
      { item: 'pytorch', score: 1 },
      { item: 'pytorchs', score: 0.99 },
      { item: 'vue', score: 0.5 },
    ], 2, 0.5, termSimilarity);
    expect(picked).toEqual(['pytorch', 'vue']);
  });

  it('is pure relevance when lambda is 1', () => {
    const items = [{ item: 'a', score: 1 }, { item: 'ab', score: 0.9 }];
    expect(mmrSelect(items, 2, 1, termSimilarity)).toEqual(['a', 'ab']);
  });
});

describe('discoverThemes', () => {
  /** One class is one bucket: its tokens are every row of that bucket pooled. */
  it('mints the term its own burst is about, not the one every burst holds', () => {
    const themes = discoverThemes(
      [['pytorch', 'shared'], ['vue', 'shared'], ['pytorch', 'shared']], { graph: 0 }, 1, 1,
    );
    expect(themes[0]).toEqual(['pytorch']);
  });

  it('leaves out a term below the bucket threshold, the anchor, and beyond the cap', () => {
    const pooled = [['hooks', 'state', 'state', 'hooks', 'state', 'hooks', 'docs']];
    // `hooks` is the anchor the bucket is already about, so it is never its own theme
    expect(discoverThemes(pooled, { graph: 0 }, 3, 2, ['hooks'])[0]).toEqual(['state']);
    // a threshold above every count mints nothing
    expect(discoverThemes(pooled, { graph: 0 }, 4, 2, ['hooks'])[0]).toEqual([]);
    // `top` caps what survives, most distinctive first
    expect(discoverThemes(pooled, { graph: 0 }, 1, 1, ['hooks'])[0]).toEqual(['state']);
  });

  it('caps a bucket at `top` themes, most distinctive first', () => {
    const pooled = [['hooks', 'guide', 'hooks', 'guide', 'hooks', 'guide']];
    // with one class every term has the same global frequency, so this is the
    // deterministic tie-break; the walk can reorder what the threshold admitted
    // but never introduce a term the bucket does not hold
    expect(discoverThemes(pooled, { graph: 0 }, 3, 2)).toEqual([['guide', 'hooks']]);
    expect(discoverThemes(pooled, { graph: 0 }, 3, 1)).toEqual([['guide']]);
  });
});

describe('applyRrfBuckets', () => {
  const scored = (tid: number, cluster: number, tags: [string, number][]) => ({
    row: row(tid, `row ${tid}`),
    dim: 'tid' as const,
    cluster,
    window: { lo: 0, hi: 0, radius: 0, indices: [] },
    keywords: [],
    suggestions: tags.map(([tag, score]) => ({
      tag, score,
      parts: { tfidf: 0, bm25: score, embed: 0, textRank: 0, clusterRank: 0, priority: 0, keyword: 0, suggest: 0, group: 0 },
    })),
  });

  it('focuses on the priority-carried tags and the score cut-off', () => {
    const out = applyRrfBuckets([scored(1, 0, [['react', 0.5], ['weak', 0.1]])], { aimMin: 0.4 });
    expect(out[0].suggestions.map((s) => s.tag)).toEqual(['react']);
  });

  it('mints a sub-tag from the terms its burst shares, under the anchor', () => {
    const rows = [
      scored(1, 0, [['react', 0.6], ['hooks', 0.3]]),
      scored(2, 0, [['react', 0.6], ['hooks', 0.3]]),
      scored(3, 0, [['react', 0.6], ['hooks', 0.3]]),
    ];
    const out = applyRrfBuckets(rows, { aimMin: 0.4, promoteMin: 3, promoteTop: 1 }, { graph: 0 });
    const sub = out[0].suggestions.find((s) => s.tag === 'react/hooks')!;
    expect(sub).toBeDefined();
    expect(sub.parts.group).toBe(3);
    expect(explainTag(sub, { ...RRF_TAG_SCORE, bm25: 1, group: 1 } as never).origin).toBe('sub');
  });

  it('leaves the rows raw when the promote half is off', () => {
    const rows = [scored(1, 0, [['react', 0.6], ['hooks', 0.3]])];
    const out = applyRrfBuckets(rows, { promote: false });
    expect(out[0].suggestions.map((s) => s.tag)).toEqual(['react']);
  });
});

describe('rrfTagReports', () => {
  const burst = [
    row(1, 'react hooks guide'),
    row(2, 'react hooks state'),
    row(3, 'react hooks docs'),
  ];

  it('carries a curated tag through the trie and mints the term the burst shares', async () => {
    const reports = await rrfTagReports(burst, {
      score: { ...RRF_TAG_SCORE, tfidf: 0 },
      priorityTags: ['react'],
      pins: [pin('## reading #react')],
      window: { dim: 'tid' },
      aim: {},
    });
    const tags = reports[0].tags.map((t) => t.tag);
    expect(tags[0]).toBe('react');
    expect(tags).toContain('react/hooks');
    expect(reports[0].tags.find((t) => t.tag === 'react/hooks')!.origin).toBe('sub');
  });

  it('keeps the channel shares adding up to the score', async () => {
    const reports = await rrfTagReports(burst, { priorityTags: ['react'] });
    for (const report of reports) {
      for (const t of report.tags) {
        const total = t.channels.reduce((n, c) => n + c.contribution, 0);
        expect(total, `${report.tid} #${t.tag}`).toBeCloseTo(t.score, 6);
      }
    }
  });

  it('normalizes the fused score to the best the enabled lists could jointly give', async () => {
    const reports = await rrfTagReports(burst, { priorityTags: ['react'] });
    for (const report of reports) {
      for (const t of report.tags) expect(t.score).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('reports the BM25F stage under its own channel and leaves tfidf out', async () => {
    const reports = await rrfTagReports(burst, { priorityTags: ['react'] });
    const hooks = reports[0].tags.find((t) => t.tag === 'hooks')!;
    expect(hooks.channels.map((c) => c.channel)).toContain('bm25');
    expect(hooks.channels.map((c) => c.channel)).not.toContain('tfidf');
  });

  it('drops what the row already carries, the way every pass does', async () => {
    const { runRestPass } = await import('../src/rstag');
    const map = await runRestPass(
      [row(1, 'react hooks guide', { tags: ['react'] }), row(2, 'react hooks state', { tags: ['react'] })],
      { dim: 'tid', score: { ...RRF_TAG_SCORE }, limit: 10, pinsPriority: true, aim: {} },
      { pins: [pin('## reading #react')] },
    );
    expect(map.get(1)!.tags.map((t) => t.tag)).not.toContain('react');
  });

  it('scores each site as its own working set when the pass buckets by domain', async () => {
    const rows = [
      row(1, 'deep learning framework', { rec: { url: 'https://pytorch.org/docs' } }),
      row(2, 'web framework guide', { rec: { url: 'https://vuejs.org/guide' } }),
      row(3, 'torch optimizer notes', { rec: { url: 'https://pytorch.org/tutorials' } }),
    ];
    const results = await rrfTagRows(rows, { bucket: 'domain', window: { dim: 'visitTime' }, priorityTags: ['torch'] });
    expect(results.map((r) => r.dim)).toEqual(['visitTime', 'visitTime', 'visitTime']);
    // `pytorch` is in both rows of that site, so the site's own corpus ranks it
    expect(results[0].suggestions.map((s) => s.tag)).toContain('pytorch');
    // the sibling's `torch` never lands on the other site's row
    expect(results[1].suggestions.map((s) => s.tag)).not.toContain('pytorch');
  });

  it('is deterministic: the same run proposes the same tags in the same order', async () => {
    const a = await rrfTagReports(burst, { priorityTags: ['react'] });
    const b = await rrfTagReports(burst, { priorityTags: ['react'] });
    expect(b.map((r) => r.tags.map((t) => t.tag))).toEqual(a.map((r) => r.tags.map((t) => t.tag)));
    expect(b.map((r) => r.tags.map((t) => t.score))).toEqual(a.map((r) => r.tags.map((t) => t.score)));
  });

  it('adds a semantic list when an embedder is supplied', async () => {
    const embed = async (texts: string[]) => texts.map((t) =>
      (t.includes('react') ? [1, 0] : t.includes('vue') ? [0, 1] : [0.5, 0.5]));
    const reports = await rrfTagReports(burst, { priorityTags: ['react'], embed });
    const channels = reports.flatMap((r) => r.tags.flatMap((t) => t.channels.map((c) => c.channel)));
    expect(channels).toContain('embed');
  });
});

describe('pre-processing', () => {
  /** `n` rows of one topic, every one carrying `shared`. */
  const spread = (n: number, shared: string, tags: string[] = []) =>
    Array.from({ length: n }, (_, i) => row(i + 1, `${shared} unique${i} token${i}`, { tags }));

  it('names a filter value by its separators, its camelCase and its own token', () => {
    expect(filterTerms(['suffix_GoogleSearch'])).toEqual([
      'suffix_googlesearch', 'suffix', 'googlesearch', 'google', 'search',
    ]);
    expect(filterTerms([''])).toEqual([]);
    expect(filterTerms(['f=deep-work.x'])).toContain('deep');
  });

  it('reads a provenance tag as capture context, not as a topic', () => {
    expect(isProvenanceTag('suffix_GoogleSearch')).toBe(true);
    expect(isProvenanceTag('dev_saOpera')).toBe(true);
    expect(isProvenanceTag('FIXMEchange_rejected')).toBe(true);
    expect(isProvenanceTag('FIXME_dup_ref')).toBe(true);
    expect(isProvenanceTag('react')).toBe(false);
    expect(isProvenanceTag('pin')).toBe(false);
  });

  it('takes a term the whole working set carries as a corpus stop word', () => {
    const docs = [['chrome', 'tabs'], ['chrome', 'windows'], ['chrome', 'flags']];
    expect([...globalTerms(docs, 0.6, 0)]).toEqual(['chrome']);
    // the share means nothing over three rows, which is the guard's point
    expect([...globalTerms(docs, 0.6, 8)]).toEqual([]);
    expect([...globalTerms(docs, 1, 0)]).toEqual([]);
  });

  it('drops a global term from the chips, and keeps it when the floor is off', async () => {
    const rows = spread(10, 'chrome');
    const read = async (global: Partial<typeof DEFAULT_GLOBAL>) =>
      (await rrfTagReports(rows, { priorityTags: [], global }))
        .flatMap((r) => r.tags.map((t) => t.tag));
    expect(await read({})).not.toContain('chrome');
    expect(await read({ maxDf: 1 })).toContain('chrome');
  });

  it('drops the terms of the row\'s own provenance tags whatever their frequency', async () => {
    const rows = spread(10, 'topic', ['dev_saOpera', 'suffix_GoogleSearch', 'FIXME_dup_ref']);
    const tags = (await rrfTagReports(rows, { priorityTags: [], global: { maxDf: 1, minRows: 0 } }))
      .flatMap((r) => r.tags.map((t) => t.tag));
    for (const term of ['dev', 'saopera', 'suffix', 'googlesearch', 'fixme', 'dup', 'ref']) {
      expect(tags).not.toContain(term);
    }
    expect(tags).not.toContain('FIXME_dup_ref');
  });

  it('never proposes a term the caller named', async () => {
    const rows = spread(10, 'chrome');
    const tags = (await rrfTagReports(rows, {
      priorityTags: [],
      global: { maxDf: 1, minRows: 0, exclude: filterTerms(['f=chrome']) },
    })).flatMap((r) => r.tags.map((t) => t.tag));
    expect(tags).not.toContain('chrome');
  });

  it('drops a function word by name, whatever its frequency', async () => {
    /* A short title is where this matters: `vs` and `how` are central to its
       graph walk and, on a list that repeats them, pass the floor as well. */
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, 'react vs vue how'));
    const read = async (stop: string[]) =>
      (await rrfTagReports(rows, { priorityTags: [], global: { maxDf: 1, minRows: 0, stop } }))
        .flatMap((r) => r.tags.map((t) => t.tag));
    expect(await read([])).toContain('vs');
    const stopped = await read(DEFAULT_STOP_WORDS);
    expect(stopped).not.toContain('vs');
    expect(stopped).not.toContain('how');
    // the topic words are untouched, which is what separates this from a
    // length floor that would also drop a two-character CJK bigram
    expect(stopped).toContain('react');
    expect(stopped).toContain('vue');
  });
});
