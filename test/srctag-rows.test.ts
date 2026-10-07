/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/sdb';
import {
  SRCTAG_KEYWORDS_DOC, SRCTAG_ROW_REFS, SRCTAG_SUGGEST_BODY, SRCTAG_SUGGEST_DS_BODY,
  clearTagRows, seedTagRows,
} from '../src/srctagRows';
import {
  loadAdaptersFromStore, rowSources, srctagApi, tagRows, tokenize, urlTokens,
  type ClassifyFn, type EmbedFn,
} from '../src/srctag';
import { runBody, type RecrScriptContext } from '../src/runsrc';
import { loadAdapterSet, smokeAdapters } from '../src/ui/srctagSmoke';
import type { Da } from '../src/sdb';

/** `secret.md` in the dialect `recr.parseSecrets` and the adapter bodies both read. */
const SECRET = `# Secrets

## Default
* Provider: cfw
* Model: bge

## Providers
### cfw
* Base URL: https://api.cloudflare.com/client/v4/accounts/acct/ai/run
* Models:
  - bge: @cf/baai/bge-m3
* API Keys:
  - main: cf-token

### ere
* Base URL: https://openrouter.ai/api/v1
* Models:
  - nbed: nvidia/nemotron-3-embed-1b:free
* API Keys:
  - main: or-token

### cjev
* Base URL: https://classifier.dev
* Models:
  - jev: jev-1
* API Keys:
  - main: cj-token
`;

const row = (tid: number, txt: string, over: Partial<Da> = {}): Da =>
  ({ tid, ref: `https://example.com/${tid}`, txt, type: 'url', tags: [], rec: {}, ...over });

async function putSecret(): Promise<void> {
  await db.das.put({ ref: 'secret.md', type: 'md', txt: SECRET, tags: [], rec: {}, modAt: new Date() } as Da);
}

/** `loadAdaptersFromStore` reads `type='src'` rows; this is the app's reader, reduced. */
const storeOf = () => ({
  readScript: async (ref: string) =>
    (await db.das.where('[ref+type]').equals([ref, 'src']).first())?.txt,
});

const embedCtx = (args: Record<string, unknown> = {}) =>
  ({ db, ref: 'srctag/embed.js', args, console });
const classifyCtx = (args: Record<string, unknown> = {}) =>
  ({ db, ref: 'srctag/classify.js', args, console });

/** One stub response per URL substring, recording every call. */
function routeFetch(...routes: [match: string, json: unknown][]) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const hit = routes.find(([m]) => url.includes(m));
    if (!hit) throw new Error(`no stub for ${url}`);
    return { ok: true, status: 200, statusText: 'OK', json: async () => hit[1] };
  }));
  return calls;
}

const bodyOf = (call: { init: RequestInit }) => JSON.parse(String(call.init.body));
const headersOf = (call: { init: RequestInit }) => call.init.headers as Record<string, string>;

beforeEach(async () => {
  vi.unstubAllGlobals();
  await db.das.clear();
});

describe('seedTagRows', () => {
  it('writes the five rows the srctag bodies live in', async () => {
    const res = await seedTagRows(db.das);

    expect(res).toEqual({ written: SRCTAG_ROW_REFS, skipped: [] });
    const rows = await db.das.where('type').equals('src').toArray();
    expect(rows.map((r) => r.ref).sort()).toEqual([
      'srctag/classify.js', 'srctag/embed.js', 'srctag/suggest-ds.js', 'srctag/suggest.js',
    ]);
    expect(rows.every((r) => r.tags?.includes('srctag'))).toBe(true);
    expect((await db.das.where('[ref+type]').equals(['srctag/keywords.md', 'md']).first())?.txt)
      .toBe(SRCTAG_KEYWORDS_DOC);
  });

  it('keeps a live row the user already has', async () => {
    await db.das.put({ ref: 'srctag/keywords.md', type: 'md', txt: '## mine\n- own', tags: [], rec: {} } as Da);

    const res = await seedTagRows(db.das);

    expect(res.written).toEqual([
      'srctag/embed.js', 'srctag/classify.js', 'srctag/suggest.js', 'srctag/suggest-ds.js',
    ]);
    expect(res.skipped).toEqual(['srctag/keywords.md']);
  });

  it('tombstones on clear, and seeds again afterwards', async () => {
    await seedTagRows(db.das);

    expect(await clearTagRows(db.das)).toBe(5);
    const live = await db.das.where('[ref+type]').equals(['srctag/embed.js', 'src']).toArray();
    expect(live.every((r) => r.tags?.includes('[del]'))).toBe(true);

    // a tombstoned row is not a live one, so the next seed writes it back
    expect((await seedTagRows(db.das)).written).toEqual(SRCTAG_ROW_REFS);
  });
});

describe('adapter rows, end to end', () => {
  it('fails at call time, naming secret.md, when it is absent', async () => {
    await seedTagRows(db.das);

    // the row loads either way: only the call knows whether a key is resolvable
    const { embed } = await loadAdaptersFromStore(storeOf(), embedCtx()) as { embed: EmbedFn };
    await expect(embed(['a'])).rejects.toThrow(/no secret\.md/);
  });

  it('reads a Cloudflare provider and posts its text batch', async () => {
    await seedTagRows(db.das);
    await putSecret();
    const calls = routeFetch(['/ai/run/', { result: { data: [[0.1, 0.2], [0.3, 0.4]] } }]);

    const { embed } = await loadAdaptersFromStore(storeOf(), embedCtx()) as { embed: EmbedFn };
    const vectors = await embed(['中文标题示例', 'English title example']);

    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/baai/bge-m3');
    expect(bodyOf(calls[0])).toEqual({ text: ['中文标题示例', 'English title example'] });
    expect(headersOf(calls[0]).Authorization).toBe('Bearer cf-token');
    expect(vectors).toEqual([[0.1, 0.2], [0.3, 0.4]]);
  });

  it('switches to the OpenAI-compatible shape from ctx.args', async () => {
    await seedTagRows(db.das);
    await putSecret();
    // a batch answered out of order: the adapter sorts by index
    const calls = routeFetch(['/embeddings',
      { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }]);

    const { embed } = await loadAdaptersFromStore(
      storeOf(), embedCtx({ provider: 'ere', model: 'nbed' }),
    ) as { embed: EmbedFn };
    const vectors = await embed(['a', 'b']);

    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(bodyOf(calls[0])).toEqual({
      model: 'nvidia/nemotron-3-embed-1b:free', input: ['a', 'b'], encoding_format: 'float',
    });
    expect(vectors).toEqual([[1, 0], [0, 1]]);
  });

  it('reports an unknown provider by name', async () => {
    await seedTagRows(db.das);
    await putSecret();

    const { embed } = await loadAdaptersFromStore(
      storeOf(), embedCtx({ provider: 'nope', model: 'x' }),
    ) as { embed: EmbedFn };
    await expect(embed(['a'])).rejects.toThrow(/provider "nope" not in secret\.md/);
  });

  it('classifies through classifier.dev\'s inputs/labels body', async () => {
    await seedTagRows(db.das);
    await putSecret();
    const calls = routeFetch(['/v1/classify', { labels: [{ label: 'react', score: 0.83 }] }]);

    const { classify } = await loadAdaptersFromStore(storeOf(), classifyCtx()) as { classify: ClassifyFn };
    const hits = await classify('react hooks tutorial', ['react', 'vue']);

    expect(calls[0].url).toBe('https://classifier.dev/v1/classify');
    const body = bodyOf(calls[0]);
    expect(body.inputs).toEqual(['react hooks tutorial']);
    expect(body.labels).toEqual(['react', 'vue']);
    expect(typeof body.instructions).toBe('string');
    expect(headersOf(calls[0]).Authorization).toBe('Bearer cj-token');
    expect(hits).toEqual([{ tag: 'react', score: 0.83 }]);
  });

  it('feeds both adapters into a scored row', async () => {
    await seedTagRows(db.das);
    await putSecret();
    routeFetch(
      ['/embeddings', { data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0.9, 0.1] }] }],
      ['/v1/classify', { labels: [{ label: 'react', score: 0.9 }] }],
    );

    const { embed } = await loadAdaptersFromStore(
      storeOf(), embedCtx({ provider: 'ere', model: 'nbed' }),
    ) as { embed: EmbedFn };
    const { classify } = await loadAdaptersFromStore(storeOf(), classifyCtx()) as { classify: ClassifyFn };
    const results = await tagRows([row(1, 'react hooks tutorial'), row(2, 'react state patterns')], {
      embed, classify, labels: ['react'],
    });

    const suggest = results.flatMap((r) => r.suggestions).find((s) => s.tag === 'react');
    expect(suggest?.parts.suggest).toBeCloseTo(0.9);
    expect(results.some((r) => r.suggestions.some((s) => s.parts.embed > 0))).toBe(true);
  });

  it('loads the keywords doc as the synonyms tagRows takes', async () => {
    await seedTagRows(db.das);

    const set = await loadAdapterSet();

    expect(Object.keys(set.synonyms)).toContain('machine learning');
    expect(set.synonyms['machine learning']).toEqual(['ml', '机器学习']);
  });
});

describe('smokeAdapters', () => {
  it('reports one live answer per adapter', async () => {
    await putSecret();
    routeFetch(
      ['/ai/run/', { result: { data: [[0.5, 0.5]] } }],
      ['/v1/classify', { labels: [{ label: 'react', score: 0.7 }] }],
    );

    const report = await smokeAdapters({ labels: ['react', 'vue'] });

    expect(report.ok).toBe(2);
    expect(report.title).toBe('tag adapters: 2/2 answered');
    expect(report.lines.some((l) => l.startsWith('embed: 2 texts → 2-dim'))).toBe(true);
    expect(report.lines.some((l) => l.startsWith('classify: #react 0.70'))).toBe(true);
    expect(report.lines.some((l) => l.startsWith('keywords:'))).toBe(true);
  });

  it('names the failure instead of throwing when secret.md is missing', async () => {
    const report = await smokeAdapters();

    expect(report.ok).toBe(0);
    expect(report.seeded).toEqual(SRCTAG_ROW_REFS);
    expect(report.lines.filter((l) => l.includes('no secret.md')).length).toBe(2);
  });
});

describe('srctag/suggest.js', () => {
  /** `ctx.db` as the suggest body reads it: a full scan plus the `[ref+type]` lookup. */
  const tagDb = (rows: Da[]) => ({
    das: {
      toArray: async () => rows,
      where: () => ({
        equals: ([ref, type]: [string, string]) => ({
          toArray: async () => rows.filter((r) => r.ref === ref && r.type === type),
        }),
      }),
    },
  });

  /** A pin card's `#tag` headings are where the priority tags come from. */
  const PIN = row(0, '# 阅读 #machine-learning\n\n## 待办 #qwen\n', { ref: 'pin1', type: 'md', tags: ['pin'] });

  const ROWS: Da[] = [
    PIN,
    row(1, 'Qwen 3.5 release notes - 知乎', { tags: ['suffix_知乎'] }),
    row(2, 'Qwen 3.5 实测 - 知乎', { tags: ['suffix_知乎'] }),
    row(3, 'react hooks tutorial', { tags: ['react'] }),
    row(4, 'vue composition api', { tags: ['vue', 'suffix_Vuejs'] }),
  ];

  const run = async (args: Record<string, unknown> = {}, rows: Da[] = ROWS) =>
    await runBody(SRCTAG_SUGGEST_BODY, {
      db: tagDb(rows), ref: 'srctag/suggest.js', args, console,
    } as RecrScriptContext) as Record<string, never>;

  beforeEach(() => {
    vi.stubGlobal('srctag', srctagApi());
  });

  it('reports the installed global as missing rather than throwing', async () => {
    vi.stubGlobal('srctag', undefined);

    const report = await run();

    expect(String(report.error)).toContain('installSrctagGlobal');
  });

  it('compares the four neighbourhood rules over one row set', async () => {
    const report = await run({ adapters: false });

    const groups = report.groups as unknown as { key: string; overlapTid: number }[];
    expect(groups.map((g) => g.key)).toEqual(['tid', 'dt', 'visitTime', 'suffix_*']);
    expect(groups.find((g) => g.key === 'tid')?.overlapTid).toBe(1);
    // the pin card supplies the priority tags and is not itself scored
    expect(report.scored).toBe(ROWS.length - 1);
    expect(report.adapters).toEqual({
      embed: false,
      classify: false,
      provider: null,
      model: null,
      notes: ['adapters: false in args: lexical channels only, no provider called'],
    });
  });

  it('takes the priority tags from the pin card headings', async () => {
    const report = await run({ adapters: false });

    expect(report.pins).toEqual(['pin1']);
    // `#machine-learning` matches the same way `cs1.tsx` renders it: the tag ends at the
    // hyphen, which the hashtag pattern does not include.
    expect(report.priorityTags).toEqual(['machine', 'qwen']);
    // a pin card is a source of tags, not a row to tag
    const groups = (report.groups as unknown as { key: string; rows: number }[]);
    expect(groups.find((g) => g.key === 'tid')?.rows).toBe(ROWS.length - 1);
  });

  it('groups rows by their suffix_ tag and keeps the rest in one bucket', async () => {
    const report = await run({ adapters: false });

    const buckets = report.suffixGroups as unknown as { key: string; rows: number }[];
    expect(buckets.map((b) => [b.key, b.rows])).toEqual([
      ['(none)', 1], ['suffix_Vuejs', 1], ['suffix_知乎', 2],
    ]);
  });

  it('restricts the working set to the tids it is given', async () => {
    const report = await run({ adapters: false, tids: [1, 2] });

    expect(report.scored).toBe(2);
    const buckets = report.suffixGroups as unknown as { key: string }[];
    expect(buckets.map((b) => b.key)).toEqual(['suffix_知乎']);
  });

  it('caps the rows scanned from the newest tid', async () => {
    const report = await run({ adapters: false, limit: 2 });

    expect(report.scanned).toBe(ROWS.length);
    expect(report.scored).toBe(2);
  });

  it('suggests only tags a row text supports, plus the priority tags', async () => {
    const report = await run({ adapters: false, detail: true });

    // the same token sources tagRows builds its documents from: text plus URLs
    const words = new Set(ROWS.flatMap((r) => {
      const s = rowSources(r);
      return [...tokenize(s.text), ...s.urls.flatMap(urlTokens)];
    }));
    const tid = (report.groups as unknown as { key: string; tags: string[] }[])
      .find((g) => g.key === 'tid');
    expect(tid?.tags.length).toBeGreaterThan(0);
    for (const tag of tid?.tags ?? []) {
      expect(words.has(tag) || (report.priorityTags as unknown as string[]).includes(tag)).toBe(true);
    }
  });
});

describe('srctag/suggest-ds.js', () => {
  /** `ctx.db` as the suggest body reads it, over the same rows the generic test uses. */
  const liveDb = (rows: Da[]) => ({
    das: {
      toArray: async () => rows,
      where: () => ({
        equals: ([ref, type]: [string, string]) => ({
          toArray: async () => rows.filter((r) => r.ref === ref && r.type === type),
        }),
      }),
    },
  });

  /** Runs the ds body and captures the args its adapter load was handed. */
  async function runDs(args: Record<string, unknown> = {}) {
    const loaded: Record<string, unknown>[] = [];
    const api = srctagApi();
    const spy = {
      ...api,
      loadAdaptersFromStore: async (store: unknown, ctx: { args: Record<string, unknown> }) => {
        loaded.push(ctx.args);
        return {};
      },
    };
    vi.stubGlobal('srctag', spy);
    const report = await runBody(SRCTAG_SUGGEST_DS_BODY, {
      db: liveDb([row(1, 'react hooks tutorial')]),
      ref: 'srctag/suggest-ds.js',
      args,
      console,
    } as RecrScriptContext) as Record<string, never>;
    return { report, loaded };
  }

  it('is the same comparison as the generic row, plus a provider default', () => {
    expect(SRCTAG_SUGGEST_DS_BODY).not.toBe(SRCTAG_SUGGEST_BODY);
    expect(SRCTAG_SUGGEST_DS_BODY).toContain('const DEFAULTS = {"provider":"ds"}');
    expect(SRCTAG_SUGGEST_BODY).toContain('const DEFAULTS = {}');
    // the comparison itself is shared, so a change to one reaches both rows
    expect(SRCTAG_SUGGEST_DS_BODY.replace('{"provider":"ds"}', '{}')).toBe(SRCTAG_SUGGEST_BODY);
  });

  it('defaults its API channels to the ds provider', async () => {
    const { report, loaded } = await runDs();

    expect(report.adapters).toMatchObject({ provider: 'ds', model: null });
    expect(loaded[0]).toMatchObject({ provider: 'ds' });
    expect(report.notes as unknown as string[])
      .toContain('API channels resolve through provider "ds"');
  });

  it('lets ctx.args name another provider instead', async () => {
    const { report, loaded } = await runDs({ provider: 'ere', model: 'nbed' });

    expect(report.adapters).toMatchObject({ provider: 'ere', model: 'nbed' });
    expect(loaded[0]).toMatchObject({ provider: 'ere', model: 'nbed' });
  });

  it('states no provider when the caller switches the adapters off', async () => {
    const { report, loaded } = await runDs({ adapters: false });

    expect(loaded).toEqual([]);
    expect(report.adapters).toMatchObject({ embed: false, provider: 'ds' });
  });
});
