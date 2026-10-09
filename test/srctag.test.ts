/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KeywordTagger, centroidDense, centroidSparse, clusterRows, commitTagUpdates, cosineDense,
  cosineSparse, createClassifierDevClassify, createCloudflareEmbed, createEmbedClient, customTagPort,
  dedupeTags, defaultWindow, dexieTagPort, embedBatch, embedWithCache, explainTag, explanationText,
  hashEmbed, idf, installSrctagGlobal,
  keywordEntries, loadAdaptersFromStore, loadTagAdapter, markdownLinks, mergeTags, neighbourhood,
  normalizeText, parseKeywordDoc, pinPriorityTags, pinTags, planTagUpdates, rankTags, rowSources,
  rowStamp, scoreTagsForRow, sortByDim, srctagApi, tagRows, tagRowsForPinSave, tagRowsInteractive,
  tagSweepRows, tagRowReports, tfidfVectors, textRank, tokenize, urlTokens,
} from '../src/srctag';
import type { SparseVector, TagParts, TagRow, TagRowsOptions } from '../src/srctag';

/** A row with the fields a tab row carries, so tests read like the real store. */
function row(tid: number, txt: string, over: Partial<TagRow> = {}): TagRow {
  return { tid, txt, ref: `https://example.com/${tid}`, type: 'tab', tags: [], rec: {}, ...over };
}

const ctx = { db: {}, ref: 'srctag/test.js', args: {}, console };

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, and drops stop words and one-letter words', () => {
    expect(tokenize('React Hooks: A Guide to State')).toEqual(['react', 'hooks', 'guide', 'state']);
  });

  it('cuts a CJK run into sliding bigrams', () => {
    expect(tokenize('机器学习很好')).toEqual(['机器', '器学', '学习', '习很', '很好']);
  });

  it('keeps Latin and CJK apart without merging the boundary', () => {
    expect(tokenize('React 机器学习')).toEqual(['react', '机器', '器学', '学习']);
  });

  it('can keep whole CJK runs or single characters instead', () => {
    expect(tokenize('机器学习', { cjk: 'run' })).toEqual(['机器学习']);
    expect(tokenize('机器学习', { cjk: 'unigram' })).toEqual(['机', '器', '学', '习']);
  });

  it('drops raw URLs so path noise cannot outrank the title', () => {
    expect(tokenize('see https://example.com/a/b for details')).toEqual(['see', 'details']);
  });

  it('normalizes full-width forms', () => {
    expect(normalizeText('Ｒｅａｃｔ')).toBe('react');
  });
});

describe('url tokens', () => {
  it('keeps hostname labels, path segments, and query values', () => {
    expect(urlTokens('https://www.news.ycombinator.com/item?id=42&q=rust'))
      .toEqual(['news', 'ycombinator', 'item', 'rust']);
  });

  it('drops generic path segments', () => {
    expect(urlTokens('https://example.com/index.html')).toEqual(['example']);
  });

  it('falls back to tokenizing a string that is not a URL', () => {
    expect(urlTokens('pin_react_notes')).toEqual(['pin', 'react', 'notes']);
  });
});

describe('row sources', () => {
  it('reads a tab row title and its ref as the URL', () => {
    expect(rowSources(row(1, 'React docs'))).toEqual({
      text: 'React docs', urls: ['https://example.com/1'],
    });
  });

  it('reads links out of a pin card, whose ref is not a URL', () => {
    const pin = row(2, '# react\n- [Hooks](https://react.dev/learn)', { ref: 'pin_react', type: 'md' });
    expect(markdownLinks(pin.txt)).toEqual(['https://react.dev/learn']);
    expect(rowSources(pin).urls).toEqual(['https://react.dev/learn']);
  });

  it('prefers rec.url when the row carries one', () => {
    const r = row(3, 'title', { ref: 'pin_x', type: 'md', rec: { url: 'https://a.b/c' } });
    expect(rowSources(r).urls).toEqual(['https://a.b/c']);
  });
});

describe('tf-idf', () => {
  it('gives a rarer token a higher idf', () => {
    const table = idf([['shared', 'rare'], ['shared'], ['shared']]);
    expect(table.rare).toBeGreaterThan(table.shared);
  });

  it('builds one vector per document', () => {
    const { vectors } = tfidfVectors([['a', 'a', 'b'], ['b']]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0].a).toBeGreaterThan(0);
    expect(vectors[1].a).toBeUndefined();
  });

  it('measures a vector against itself as 1 and against an unrelated one as 0', () => {
    const a: SparseVector = { x: 1, y: 2 };
    expect(cosineSparse(a, a)).toBeCloseTo(1);
    expect(cosineSparse(a, { z: 1 })).toBe(0);
  });

  it('averages a centroid over its vectors', () => {
    expect(centroidSparse([{ x: 2 }, { x: 4 }])).toEqual({ x: 3 });
    expect(centroidSparse([])).toEqual({});
  });

  it('measures dense vectors and a dense centroid', () => {
    expect(cosineDense([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineDense([1, 0], [0, 1])).toBe(0);
    expect(centroidDense([[0, 2], [2, 0]])).toEqual([1, 1]);
  });

  it('falls back to a unit-length hash vector', () => {
    const v = hashEmbed('react hooks');
    expect(v).toHaveLength(64);
    expect(Math.hypot(...v)).toBeCloseTo(1);
  });
});

describe('textRank', () => {
  it('ranks the token that recurs beside many others above a one-off', () => {
    const ranks = textRank(tokenize('react hooks guide react hooks state react'));
    expect(ranks.react).toBe(1);
    expect(ranks.react).toBeGreaterThan(ranks.guide);
    expect(ranks.guide).toBeGreaterThan(0);
  });

  it('normalizes by the top rank and returns nothing for no tokens', () => {
    const ranks = textRank(['a', 'b', 'a']);
    expect(Math.max(...Object.values(ranks))).toBe(1);
    expect(textRank([])).toEqual({});
  });

  it('scores a lone token without an edge as the top rank', () => {
    expect(textRank(['solo'])).toEqual({ solo: 1 });
  });

  it('is deterministic for the same input and options', () => {
    const tokens = tokenize('alpha beta gamma');
    expect(textRank(tokens, { window: 4 })).toEqual(textRank(tokens, { window: 4 }));
    // window 2 leaves a path; window 4 closes it into a triangle, whose three
    // equally weighted nodes rank alike
    expect(textRank(tokens, { window: 2 })).not.toEqual(textRank(tokens, { window: 4 }));
  });

  it('honours the minLength filter', () => {
    expect(textRank(['ab', 'abcdef'], { minLength: 3 })).toEqual({ abcdef: 1 });
  });
});

describe('KeywordTagger', () => {
  it('prefers the longest form and consumes its span', () => {
    const t = new KeywordTagger([{ tag: 'ml', keywords: ['machine learning'] }, { tag: 'm', keywords: ['machine'] }]);
    expect(t.match('machine learning is fun')).toEqual([
      { tag: 'ml', form: 'machine learning', start: 0, end: 16 },
    ]);
  });

  it('reports every occurrence, overlaps included, in one pass', () => {
    const t = new KeywordTagger([{ tag: 'ml', keywords: ['machine learning'] }, { tag: 'm', keywords: ['machine'] }]);
    // the same text `match` collapses to one hit
    expect(t.matchAll('machine learning is fun').map(h => h.tag)).toEqual(['m', 'ml']);
    expect(t.counts('machine learning is fun')).toEqual(new Map([['m', 1], ['ml', 1]]));
  });

  it('counts a repeated keyword like a FlashText trie cannot', () => {
    const t = new KeywordTagger([{ tag: 'react', keywords: ['react'] }]);
    expect(t.counts('react and react again').get('react')).toBe(2);
    expect(t.match('react and react again')).toHaveLength(2);
  });

  it('refuses to match inside a longer word', () => {
    const t = new KeywordTagger([{ tag: 'art', keywords: ['art'] }]);
    expect(t.match('cart')).toEqual([]);
    expect(t.match('an art show').map(m => m.tag)).toEqual(['art']);
  });

  it('matches a CJK keyword beside other CJK characters', () => {
    const t = new KeywordTagger([{ tag: 'ml', keywords: ['机器学习'] }]);
    expect(t.match('机器学习很好').map(m => m.tag)).toEqual(['ml']);
  });

  it('counts distinct forms and ignores empty ones', () => {
    const t = new KeywordTagger();
    t.add('a', 'alpha');
    t.add('a', 'alpha');
    t.add('b', '  ');
    expect(t.size).toBe(1);
  });

  it('turns a hyphenated tag into a spaced surface form', () => {
    expect(keywordEntries(['machine-learning'])).toEqual([
      { tag: 'machine-learning', keywords: ['machine-learning', 'machine learning'] },
    ]);
  });

  it('parses the keywords.md dialect', () => {
    const entries = parseKeywordDoc('## machine learning\n- ml\n- 机器学习\n\n## react\n- hooks');
    expect(entries).toEqual([
      { tag: 'machine learning', keywords: ['ml', '机器学习'] },
      { tag: 'react', keywords: ['hooks'] },
    ]);
  });
});

describe('pin cards', () => {
  it('reads tags from headings only, dropping the closing hashes', () => {
    const txt = '# #react #frontend\nprose #notatag\n## #hooks #state #\n';
    expect(pinTags(txt)).toEqual([
      { tag: 'react', level: 1 },
      { tag: 'frontend', level: 1 },
      { tag: 'hooks', level: 2 },
      { tag: 'state', level: 2 },
    ]);
  });

  it('keeps first-appearance order across pins and dedupes', () => {
    const pins = [
      row(1, '# #react #hooks', { ref: 'pin_a', type: 'md' }),
      row(2, '## #hooks #state', { ref: 'pin_b', type: 'md' }),
    ];
    expect(pinPriorityTags(pins)).toEqual(['react', 'hooks', 'state']);
  });

  it('ignores a `#` that does not start a token', () => {
    expect(pinTags('# tabs=1&e=diff')).toEqual([]);
  });
});

describe('adjacency', () => {
  it('reads tid, the later of dt and modAt, and both visit-time spellings', () => {
    expect(rowStamp(row(7, 't'), 'tid')).toBe(7);
    const times = row(1, 't', { dt: '2024-01-01T00:00:00Z', modAt: '2024-06-01T00:00:00Z' });
    expect(rowStamp(times, 'dt')).toBe(Date.parse('2024-06-01T00:00:00Z'));
    expect(rowStamp(row(1, 't', { rec: { visitTime: 500 } }), 'visitTime')).toBe(500);
    expect(rowStamp(row(1, 't', { rec: { visitTIme: { 900: {} } } }), 'visitTime')).toBe(900);
    expect(rowStamp(row(1, 't', { rec: { access2discard: { 1200: true } } }), 'visitTime')).toBe(1200);
    expect(rowStamp(row(1, 't'), 'visitTime')).toBe(0);
  });

  it('orders rows on the chosen dimension without touching the input', () => {
    const rows = [row(3, 'c'), row(1, 'a'), row(2, 'b')];
    expect(sortByDim(rows, 'tid').map(r => r.tid)).toEqual([1, 2, 3]);
    expect(rows[0].tid).toBe(3);
  });

  it('shrinks the window inside a dense burst', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i + 1, `t${i}`));
    const win = neighbourhood(rows, 5, defaultWindow('tid', { window: 4, denseSpan: 8, denseCount: 5 }));
    expect(win.radius).toBe(2);
    expect(win.indices).not.toContain(5);
    expect(win.indices.every(i => Math.abs(i - 5) <= 2)).toBe(true);
  });

  it('grows the window when neighbours are far apart', () => {
    const rows = [row(0, 'a'), row(100, 'b'), row(200, 'c')];
    const win = neighbourhood(rows, 1, defaultWindow('tid', { window: 3, maxWindow: 8, denseSpan: 8, denseCount: 5 }));
    expect(win.radius).toBe(6);
    expect(win.indices).toEqual([0, 2]);
  });

  it('splits clusters at a burst gap', () => {
    const rows = [row(1, 'a'), row(2, 'b'), row(3, 'c'), row(100, 'd')];
    expect(clusterRows(rows, defaultWindow('tid', { burstGap: 1 })).map(c => c.indices))
      .toEqual([[0, 1, 2], [3]]);
  });
});

describe('fusion', () => {
  const corpus = [
    row(1, 'react hooks tutorial', { tags: ['react'] }),
    row(2, 'react hooks guide', { tags: ['react'] }),
    row(3, 'react state management', { tags: ['react'] }),
  ];
  const cfg = defaultWindow('tid', { window: 1, minWindow: 1, maxWindow: 1 });
  const scoreCfg = {
    tfidf: 0.35, embed: 0.35, textRank: 0, clusterRank: 0,
    priority: 0.2, suggest: 0.1, keywordBoost: 1.5, topK: 8, minScore: 0.01,
  };

  function vectors(rows: TagRow[]) {
    return tfidfVectors(rows.map(r => tokenize(r.txt))).vectors;
  }

  it('scores a channel per candidate and lets a priority tag win', () => {
    const rows = corpus;
    const vecs = vectors(rows);
    const out = scoreTagsForRow({
      rows, index: 1, vectors: vecs, windowCfg: cfg, cfg: scoreCfg, priority: ['react'], keywords: [],
    });
    expect(out[0].tag).toBe('react');
    expect(out[0].parts.priority).toBe(1);
    expect(out.map(s => s.tag)).toContain('hooks');
  });

  it('boosts a tag the keyword trie names', () => {
    const rows = corpus;
    const tagger = new KeywordTagger(keywordEntries(['react hooks']));
    const out = scoreTagsForRow({
      rows, index: 1, vectors: vectors(rows), windowCfg: cfg, cfg: scoreCfg,
      priority: ['react hooks'], keywords: tagger.match('react hooks guide'),
    });
    const hit = out.find(s => s.tag === 'react hooks')!;
    expect(hit.parts.keyword).toBe(1);
    expect(hit.parts.priority).toBe(1.5);
  });

  it('carries a classifier proposal with no textual support', () => {
    const rows = corpus;
    const out = scoreTagsForRow({
      rows, index: 0, vectors: vectors(rows), windowCfg: cfg, cfg: scoreCfg, priority: [],
      keywords: [], suggestions: [{ tag: 'vue', score: 0.9 }],
    });
    const hit = out.find(s => s.tag === 'vue')!;
    expect(hit.parts.tfidf).toBe(0);
    expect(hit.score).toBeCloseTo(0.09);
  });

  it('adds an embedding channel when vectors are supplied', () => {
    const rows = corpus;
    const embeddings = [hashEmbed('react hooks'), hashEmbed('react hooks'), hashEmbed('react state')];
    const out = scoreTagsForRow({
      rows, index: 1, vectors: vectors(rows), windowCfg: cfg, cfg: scoreCfg, priority: [], keywords: [], embeddings,
    });
    expect(out.some(s => s.parts.embed > 0)).toBe(true);
  });

  it('drops near-duplicates and applies the cut-offs', () => {
    expect(dedupeTags(['react hooks', 'react hook', 'react', 'vue'])).toEqual(['react hooks', 'vue']);
    const ranked = rankTags([
      { tag: 'a', score: 0.9, parts: {} as never },
      { tag: 'b', score: 0.001, parts: {} as never },
    ], { ...scoreCfg, minScore: 0.05 });
    expect(ranked.map(s => s.tag)).toEqual(['a']);
  });
});

describe('tagRows', () => {
  it('orders on the visit-time dimension and reports the window and cluster', async () => {
    const rows = [
      row(1, 'react hooks', { rec: { visitTime: 3000 } }),
      row(2, 'react hooks guide', { rec: { visitTime: 1000 } }),
      row(3, 'vue tutorial', { rec: { visitTime: 2000 } }),
    ];
    const pins = [row(9, '# #react', { ref: 'pin_react', type: 'md' })];
    const res = await tagRowsForPinSave(pins, rows, { window: { burstGap: 10_000 } });
    expect(res.map(r => r.row.tid)).toEqual([2, 3, 1]);
    expect(res[0].cluster).toBe(0);
    expect(res[0].suggestions.map(s => s.tag)).toContain('react');
  });

  it('restricts scoring to the requested tids', async () => {
    const rows = [row(1, 'a'), row(2, 'b')];
    const res = await tagRowsInteractive(rows, [2]);
    expect(res.map(r => r.row.tid)).toEqual([2]);
  });

  it('uses the sweep default of insert order', async () => {
    const rows = [row(2, 'b'), row(1, 'a')];
    const res = await tagSweepRows(rows);
    expect(res.map(r => r.row.tid)).toEqual([1, 2]);
  });

  it('calls the injected embedding and classifier once per set and row', async () => {
    const rows = [row(1, 'react hooks'), row(2, 'react state')];
    const embed = vi.fn(async (texts: string[]) => texts.map(t => [t.length]));
    const classify = vi.fn(async () => [{ tag: 'react', score: 1 }]);
    const res = await tagRows(rows, { embed, classify, labels: ['react', 'vue'] });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledTimes(2);
    expect(res.every(r => r.suggestions.some(s => s.tag === 'react'))).toBe(true);
  });
});

describe('planTagUpdates', () => {
  const result = (over: Partial<TagRow>, score = 0.5) => ({
    row: { ...row(1, 't'), ...over },
    suggestions: [{ tag: 'new', score, parts: {} as never }],
    window: { lo: 0, hi: 0, radius: 0, indices: [] },
    cluster: 0,
  });

  it('adds without touching what the row already carries', () => {
    const [u] = planTagUpdates([result({ tags: ['user'] })]);
    expect(u).toMatchObject({ tid: 1, add: ['new'], remove: [], tags: ['user', 'new'] });
    expect(u.rec.tagAuto).toEqual({ new: { score: 0.5, src: 'srctag', at: expect.any(String) } });
  });

  it('prunes only the tags a previous run recorded', () => {
    const prev = { tagAuto: { old: { score: 1, src: 'srctag', at: 'x' } } };
    const [u] = planTagUpdates([result({ tags: ['user', 'old'], rec: prev })], { mode: 'replaceAuto' });
    expect(u.remove).toEqual(['old']);
    expect(u.tags).toEqual(['user', 'new']);
    expect(u.rec.tagAuto).toEqual({ new: expect.anything() });
  });

  it('keeps tombstones and excluded tags in replace mode', () => {
    const [u] = planTagUpdates([result({ tags: ['[del]', 'pinned', 'stale'] })],
      { mode: 'replace', keep: ['pinned'] });
    expect(u.remove).toEqual(['stale']);
    expect(u.tags).toEqual(['[del]', 'pinned', 'new']);
  });

  it('skips a row with no tid and clears an empty provenance bag', () => {
    const bare = { ...result({ tags: ['user'] }), suggestions: [] };
    const [u] = planTagUpdates([bare, { ...result({}), row: { ...row(2, 't'), tid: undefined } }]);
    expect(u.tid).toBe(1);
    expect(u.rec.tagAuto).toBeUndefined();
    expect(planTagUpdates([bare]).length).toBe(1);
  });

  it('writes only the tags the caller names when `only` is set', () => {
    const conf = result({ tags: ['user'] });
    conf.suggestions = [
      { tag: 'react', score: 0.5, parts: {} as never },
      { tag: 'hooks', score: 0.4, parts: {} as never },
    ];
    const [u] = planTagUpdates([conf], { only: ['react'] });
    expect(u.tags).toEqual(['user', 'react']);
    expect(u.rec.tagAuto).toEqual({ react: expect.anything() });
  });

  it('merges tags without duplicating', () => {
    expect(mergeTags(['a', 'b'], ['b', 'c'], ['a'])).toEqual(['b', 'c']);
  });
});

describe('write ports', () => {
  it('writes tags, rec, and a local stamp through a Dexie-like table', async () => {
    const update = vi.fn(async () => 1);
    const port = dexieTagPort({ update }, () => new Date('2024-01-01T00:00:00Z'));
    const n = await commitTagUpdates(port, [{
      tid: 5, ref: 'r', add: [], remove: [], tags: ['x'], rec: { tagAuto: {} },
    }]);
    expect(n).toBe(1);
    expect(update).toHaveBeenCalledWith(5, {
      tags: ['x'], rec: { tagAuto: {} }, modAt: new Date('2024-01-01T00:00:00Z'),
    });
  });

  it('accepts a caller-supplied write recipe', async () => {
    const seen: unknown[] = [];
    await commitTagUpdates(customTagPort(async (u) => { seen.push(u.tid); }), [
      { tid: 1, ref: 'a', add: [], remove: [], tags: [], rec: {} },
      { tid: 2, ref: 'b', add: [], remove: [], tags: [], rec: {} },
    ]);
    expect(seen).toEqual([1, 2]);
  });
});

describe('network adapters', () => {
  /** One stub response per call, in order. */
  function stubFetch(...json: unknown[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, statusText: 'OK', json: async () => json[i++] };
    }));
    return calls;
  }

  it('posts to the OpenAI-compatible embeddings route and reorders by index', async () => {
    const calls = stubFetch({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
    const embed = createEmbedClient({ apiKey: 'k', model: 'm', baseUrl: 'https://api.example.com/' });
    expect(await embed(['a', 'b'])).toEqual([[1, 0], [0, 1]]);
    expect(calls[0].url).toBe('https://api.example.com/v1/embeddings');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: 'm', input: ['a', 'b'], encoding_format: 'float' });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });

  it('keeps an existing /v1 suffix from doubling', async () => {
    const calls = stubFetch({ data: [{ embedding: [1] }] });
    await createEmbedClient({ apiKey: 'k', model: 'm', baseUrl: 'https://api.example.com/v1' })(['a']);
    expect(calls[0].url).toBe('https://api.example.com/v1/embeddings');
  });

  it('reads the Cloudflare result envelope', async () => {
    const calls = stubFetch({ result: { data: [[1, 2]] } });
    const embed = createCloudflareEmbed({ apiKey: 'k', accountId: 'acct', model: '@cf/baai/bge-m3' });
    expect(await embed(['a'])).toEqual([[1, 2]]);
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/baai/bge-m3');
  });

  it('normalizes every classifier response shape', async () => {
    stubFetch({ labels: [{ label: 'react', score: 0.8 }] });
    const classify = createClassifierDevClassify();
    expect(await classify('text', ['react'])).toEqual([{ tag: 'react', score: 0.8 }]);
    stubFetch([{ label: 'vue', score: 0.4 }]);
    expect(await createClassifierDevClassify()('text', [])).toEqual([{ tag: 'vue', score: 0.4 }]);
    stubFetch({ label: 'svelte', score: 0.3 });
    expect(await createClassifierDevClassify()('text', [])).toEqual([{ tag: 'svelte', score: 0.3 }]);
  });

  it('reports a failed response instead of returning empty vectors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 429, statusText: 'Too Many Requests', text: async () => 'slow down',
    })));
    await expect(createEmbedClient({ apiKey: 'k', model: 'm', baseUrl: 'https://a.b' })(['x']))
      .rejects.toThrow(/429 Too Many Requests: slow down/);
  });

  it('chunks a batch and reports progress', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(t => [t.length]));
    const done: number[] = [];
    const out = await embedBatch(embed, ['a', 'bb', 'ccc'], { batchSize: 2, onProgress: d => done.push(d) });
    expect(out).toEqual([[1], [2], [3]]);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(done).toEqual([2, 3]);
  });

  it('embeds only the cache misses', async () => {
    const store = new Map<string, number[]>([['m|a', [1]]]);
    const cache = { get: (k: string) => store.get(k), set: (k: string, v: number[]) => { store.set(k, v); } };
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [9]));
    expect(await embedWithCache(embed, 'm', ['a', 'b'], cache)).toEqual([[1], [9]]);
    expect(embed).toHaveBeenCalledWith(['b']);
    expect(store.get('m|b')).toEqual([9]);
  });
});

describe('src-row adapters', () => {
  it('takes the adapter from a function body', async () => {
    const fn = await loadTagAdapter('return async (texts) => texts.map(t => [t.length])', 'embed', ctx);
    expect(await fn(['ab', 'abc'])).toEqual([[2], [3]]);
  });

  it('takes the adapter a module factory returns for ctx', async () => {
    const body = 'export default async (ctx) => async (texts) => texts.map(t => [t.length * 2])';
    const fn = await loadTagAdapter(body, 'embed', ctx);
    expect(await fn(['ab'])).toEqual([[4]]);
  });

  it('rejects a body that returns no adapter', async () => {
    await expect(loadTagAdapter('return 1', 'embed', ctx)).rejects.toThrow(/must result in a function/);
  });

  it('loads what the store has and skips a failing row', async () => {
    const bodies: Record<string, string> = {
      'srctag/embed.js': 'return async (t) => t.map(x => [x.length])',
      'srctag/classify.js': 'throw new Error("boom")',
    };
    const warn = vi.fn();
    const out = await loadAdaptersFromStore(
      { readScript: async (ref: string) => bodies[ref] },
      { ...ctx, console: { ...console, warn } },
    );
    expect(out.embed).toBeTypeOf('function');
    expect(out.classify).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('srctag/classify.js'));
  });

  it('publishes the api on a target object', () => {
    const target: Record<string, unknown> = {};
    expect(installSrctagGlobal(target)).toBe(target.srctag);
    expect((target.srctag as ReturnType<typeof srctagApi>).tagRows).toBe(tagRows);
  });
});

describe('option surface', () => {
  it('keeps every documented channel configurable', () => {
    const opts: TagRowsOptions = {
      score: {
        tfidf: 1, embed: 0, textRank: 0, clusterRank: 0,
        priority: 0, suggest: 0, keywordBoost: 2, topK: 3, minScore: 0.2,
      },
      window: { dim: 'dt', window: 2, burstGap: 1000 },
      priorityTags: ['a'],
      synonyms: { a: ['b'] },
      labels: ['a'],
      onlyTids: [1],
    };
    expect(opts.score?.topK).toBe(3);
  });
});

describe('score explanations', () => {
  const suggestion = (score: number, parts: Partial<TagParts>) => ({
    tag: 'react', score,
    parts: {
      tfidf: 0, embed: 0, textRank: 0, clusterRank: 0,
      priority: 0, keyword: 0, suggest: 0, ...parts,
    },
  });

  it('splits a suggestion into channel shares that add up to the score', () => {
    const e = explainTag(suggestion(0.175, { tfidf: 0.5 }));
    expect(e.top).toBe('tfidf');
    expect(e.channels.map((c) => c.channel)).toEqual(['tfidf']);
    expect(e.channels[0].contribution).toBeCloseTo(0.175, 6);
    expect(e.text).toContain('tfidf');
  });

  it('splits a trie boost into a base priority share and a turbotext share', () => {
    const e = explainTag(suggestion(0.3, { priority: 1.5, keyword: 1 }));
    expect(e.channels.reduce((n, c) => n + c.contribution, 0)).toBeCloseTo(0.3, 6);
    expect(e.channels.find((c) => c.channel === 'keyword')?.contribution).toBeCloseTo(0.1, 6);
    expect(e.text).toContain('turbotext');
  });

  it('names the window and the missing write in the hover text', () => {
    const text = explanationText(explainTag(suggestion(0.09, { suggest: 0.9 })), {
      dim: 'tid', window: { lo: 0, hi: 2, radius: 1, indices: [1, 2] },
    });
    expect(text).toContain('#react · 0.090');
    expect(text).toContain('classify');
    expect(text).toContain('window ±1 (2 rows, tid)');
    expect(text).toContain('not persisted');
  });
});

describe('tagRowReports', () => {
  it('returns explained tags with the window each row was measured in', async () => {
    const reports = await tagRowReports([
      row(1, 'react hooks'), row(2, 'react hooks guide'), row(3, 'vue'),
    ]);
    expect(reports.map((r) => r.tid)).toEqual([1, 2, 3]);
    expect(reports[1].dim).toBe('tid');
    expect(reports[1].window.indices.length).toBeGreaterThan(0);
    expect(reports[1].tags.some((t) => t.tag === 'react')).toBe(true);
  });
});
