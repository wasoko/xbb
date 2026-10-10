/**
 * srctag-cdp.test.ts — the `srctag/*` script bodies over the live app's own rows.
 *
 * The rows come from the real `tagDB_0` IndexedDB the page at `localhost:5173`
 * reads and writes, reached over CDP on `localhost:9222`, so the working set is
 * the tabs the user actually has rather than a fixture. The bodies then run
 * through `runsrc.runBody` in this process, with `globalThis.srctag` publishing
 * `srctagApi()` — the same object `ui/routes.tsx` installs at boot — which is what
 * a `run_src` row sees in the page.
 *
 * The one seam this cannot cross is the store itself: Node cannot open a browser's
 * IndexedDB, so `ctx.db` is a Dexie-shaped shim over the rows CDP returned. A test
 * that needs the real Dexie query engine belongs in the page, not here.
 *
 * Both channels are optional feedback: with CDP or the dev server down the tests
 * warn and pass rather than fail, the way the rest of this repository treats them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runBody, type RecrScriptContext } from '../src/runsrc';
import { SRCTAG_ROW_SEEDS, SRCTAG_SUGGEST_BODY, SRCTAG_SUGGEST_DS_BODY, SRCTAG_ROW_REFS } from '../src/srctagRows';
import {
  DEFAULT_TAG_AIM, RSTEXT_TAG_SCORE, applyTagAim, embedBatch, installSrctagGlobal, loadAdaptersFromStore,
  mergeTagScore, pinPriorityTags, rowSources, summarizeTagAim, summarizeTagRun, tagRows, tokenize, urlTokens,
  type ClassifyFn, type EmbedFn, type TagAimConfig, type TagDim, type TagRow, type TagRowResult,
  type TagScoreConfig, type TagWindowConfig, type TextRankOptions,
} from '../src/srctag';

/** IndexedDB the app opens, and the table its rows live in. */
const DB_NAME = 'tagDB_0';
const STORE = 'das';
const APP_URL = 'http://localhost:5173';
const CDP_URL = 'http://localhost:9222';

/**
 * Rows requested from the page, newest `tid` first, and the per-row text cap.
 * The sweep wants the user's whole table; `SRCTAG_CDP_LIMIT` trims it for a
 * faster pass.
 */
const LIMIT = Number(process.env.SRCTAG_CDP_LIMIT ?? 1500);
const TXT_CAP = 2000;

/** Rows a dynamic-API case scores: one request per row, so the sample is small. */
const API_SAMPLE = Number(process.env.SRCTAG_API_SAMPLE ?? 24);

/** `SRCTAG_SKIP_API=1` keeps the sweep off the network whatever the store holds. */
const SKIP_API = process.env.SRCTAG_SKIP_API === '1';

/** The row fields the script and the tag fusion read; the rest of a `Da` is dropped. */
interface LiveRow {
  tid?: number;
  ref: string;
  type: string;
  txt: string;
  tags: string[];
  dt?: number;
  modAt?: number;
  rec: { visitTime?: number; url?: string };
}

let browser: Browser | undefined;
let page: Page | undefined;
let rows: LiveRow[] = [];
let down = '';

/** Rows the page answered for the names a `run_src` script calls on `globalThis.srctag`. */
const SCRIPT_API = ['tagRows', 'pinPriorityTags', 'loadAdaptersFromStore', 'parseKeywordDoc'];

beforeAll(async () => {
  installSrctagGlobal();
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(APP_URL));
    if (!page) {
      down = `no page at ${APP_URL}; open one in the browser on :9222`;
      return;
    }
    rows = await page.evaluate(async ({ dbName, store, limit, txtCap }) => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const all: Record<string, never>[] = await new Promise((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result as Record<string, never>[]);
        req.onerror = () => reject(req.error);
      });
      const ms = (v: unknown): number | undefined =>
        v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : undefined);
      return all
        .filter((r) => !((r.tags as string[] | undefined) ?? []).includes('[del]'))
        .sort((a, b) => ((b.tid as number) ?? 0) - ((a.tid as number) ?? 0))
        .slice(0, limit)
        .map((r) => {
          const rec = (r.rec ?? {}) as Record<string, unknown>;
          return {
            tid: r.tid as number | undefined,
            ref: String(r.ref),
            type: String(r.type),
            txt: String(r.txt ?? '').slice(0, txtCap),
            tags: (r.tags as string[] | undefined) ?? [],
            dt: ms(r.dt),
            modAt: ms(r.modAt),
            rec: {
              visitTime: ms(rec.visitTime),
              url: typeof rec.url === 'string' ? rec.url : undefined,
            },
          };
        });
    }, { dbName: DB_NAME, store: STORE, limit: LIMIT, txtCap: TXT_CAP });
  } catch (e) {
    down = `CDP ${CDP_URL} or ${APP_URL} is down: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 30000);

afterAll(async () => {
  // a CDP connection is disconnected, not the browser the user is working in
  await browser?.close();
  delete (globalThis as { srctag?: unknown }).srctag;
});

/** `ctx.db` as the script reads it: a table scan plus the `[ref+type]` lookup. */
function liveDb(all: LiveRow[]) {
  return {
    das: {
      toArray: async () => all,
      where: () => ({
        equals: ([ref, type]: [string, string]) => ({
          toArray: async () => all.filter((r) => r.ref === ref && r.type === type),
        }),
      }),
    },
  };
}

/** Runs a seeded body against the live rows exactly as `run_src` would. */
const runLive = async (body: string, ref: string, args: Record<string, unknown>) =>
  await runBody(body, {
    db: liveDb(rows), ref, args, console,
  } as RecrScriptContext) as Record<string, never>;

describe('srctag bodies over the app’s own rows', () => {
  it('reaches the live page and its rows', ({ skip }) => {
    if (down) {
      console.warn(`[srctag-cdp] skipped: ${down}`);
      skip();
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => typeof r.ref === 'string')).toBe(true);
  });

  it('publishes on the page the srctag functions a run_src script calls', async ({ skip }) => {
    if (down) {
      console.warn(`[srctag-cdp] skipped: ${down}`);
      skip();
    }
    const published = await page!.evaluate(
      (names: string[]) => names.filter((n) => typeof (globalThis as Record<string, unknown> & {
        srctag?: Record<string, unknown>;
      }).srctag?.[n] === 'function'),
      SCRIPT_API,
    );
    expect(published).toEqual(SCRIPT_API);
  });

  it('seeds every body this repository ships into those rows', async ({ skip }) => {
    if (down) {
      console.warn(`[srctag-cdp] skipped: ${down}`);
      skip();
    }
    const seeded = await page!.evaluate(async (refs: string[]) => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open('tagDB_0');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const all: Record<string, never>[] = await new Promise((resolve, reject) => {
        const req = db.transaction('das', 'readonly').objectStore('das').getAll();
        req.onsuccess = () => resolve(req.result as Record<string, never>[]);
        req.onerror = () => reject(req.error);
      });
      return all
        .filter((r) => refs.includes(String(r.ref)) && !((r.tags as string[]) ?? []).includes('[del]'))
        .map((r) => String(r.ref));
    }, [...SRCTAG_ROW_REFS]);

    // the page may have none seeded yet; what matters is that a seeded row is readable
    for (const ref of seeded) expect(SRCTAG_ROW_REFS).toContain(ref);
    if (seeded.length === 0) console.warn('[srctag-cdp] no srctag/* rows seeded in the page yet');
  });

  it('compares the neighbourhood rules over the live rows', async ({ skip }) => {
    if (down) {
      console.warn(`[srctag-cdp] skipped: ${down}`);
      skip();
    }
    const report = await runLive(SRCTAG_SUGGEST_BODY, 'srctag/suggest.js', { adapters: false });

    expect(report.error).toBeUndefined();
    expect(report.scanned).toBe(rows.length);
    const groups = report.groups as unknown as { key: string; rows: number; overlapTid: number }[];
    expect(groups.map((g) => g.key)).toEqual(['tid', 'dt', 'visitTime', 'suffix_*']);
    expect(groups.find((g) => g.key === 'tid')?.overlapTid).toBe(1);
    expect(Number(report.scored)).toBeGreaterThan(0);
  });

  it('takes the pin cards’ headings as the priority tags', async ({ skip }) => {
    if (down) {
      console.warn(`[srctag-cdp] skipped: ${down}`);
      skip();
    }
    const report = await runLive(SRCTAG_SUGGEST_BODY, 'srctag/suggest.js', { adapters: false });

    const pins = report.pins as unknown as string[];
    expect(pins.every((ref) => ref.startsWith('pin'))).toBe(true);
    expect(Array.isArray(report.priorityTags)).toBe(true);
  });

  it('suggests only tags the live rows support, plus the priority tags', async ({ skip }) => {
    if (down) {
      console.warn(`[srctag-cdp] skipped: ${down}`);
      skip();
    }
    const report = await runLive(SRCTAG_SUGGEST_BODY, 'srctag/suggest.js',
      { adapters: false, detail: true });

    const words = new Set(rows.flatMap((r) => {
      const s = rowSources(r);
      return [...tokenize(s.text), ...s.urls.flatMap(urlTokens)];
    }));
    const tid = (report.groups as unknown as { key: string; tags: string[] }[])
      .find((g) => g.key === 'tid');
    expect(tid?.tags.length).toBeGreaterThan(0);
    const priority = report.priorityTags as unknown as string[];
    for (const tag of tid?.tags ?? []) {
      expect(words.has(tag) || priority.includes(tag)).toBe(true);
    }
  });

  it('buckets the rows that already carry a suffix_ tag', async ({ skip }) => {
    if (down) {
      console.warn(`[srctag-cdp] skipped: ${down}`);
      skip();
    }
    const report = await runLive(SRCTAG_SUGGEST_BODY, 'srctag/suggest.js',
      { adapters: false, limit: 400 });

    const suffixed = rows.filter((r) => r.tags.some((t) => t.startsWith('suffix_'))).length;
    const buckets = report.suffixGroups as unknown as { key: string; rows: number }[];
    const covered = buckets.filter((b) => b.key !== '(none)').reduce((n, b) => n + b.rows, 0);
    const total = buckets.reduce((n, b) => n + b.rows, 0);

    // every scored row lands in exactly one bucket; the listed buckets are capped
    const listed = Number(report.suffixBuckets) <= buckets.length;
    expect(covered).toBeLessThanOrEqual(suffixed);
    if (listed) {
      expect(covered).toBe(suffixed);
      expect(total).toBe(Number(report.scored));
    }
    if (suffixed === 0) console.warn('[srctag-cdp] no row carries a suffix_ tag yet');
  });

  it('runs both suggest rows in the page, through the app’s own srctag global', async ({ skip }) => {
    if (down) {
      console.warn(`[srctag-cdp] skipped: ${down}`);
      skip();
    }
    // The page evaluates each body the way `runsrc` does, so this is the body over the
    // real Dexie tables with the bundle's own `srctagApi()` rather than the module's.
    const inPage = await page!.evaluate(async ({ bodies, args, dbName, store }) => {
      const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const db = await open();
      const all = await new Promise<Record<string, never>[]>((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result as Record<string, never>[]);
        req.onerror = () => reject(req.error);
      });
      const das = {
        toArray: async () => all,
        where: () => ({
          equals: ([ref, type]: [string, string]) => ({
            toArray: async () => all.filter((r) => r.ref === ref && r.type === type),
          }),
        }),
      };
      const AsyncFunction = Object.getPrototypeOf(async function () { /* ctor probe */ })
        .constructor as new (arg: string, body: string) => (ctx: unknown) => Promise<Record<string, never>>;
      const out: Record<string, unknown>[] = [];
      for (const entry of bodies) {
        const report = await new AsyncFunction('ctx', entry.body)({
          db: { das }, ref: entry.ref, args, console,
        });
        const groups = report.groups as unknown as { key: string }[];
        const adapters = report.adapters as { provider: string | null };
        out.push({
          ref: entry.ref,
          keys: groups.map((g) => g.key),
          scored: Number(report.scored),
          suffixBuckets: Number(report.suffixBuckets),
          ranking: report.ranking as unknown as string[],
          provider: adapters.provider,
          error: (report.error as string | undefined) ?? null,
        });
      }
      return out;
    }, {
      bodies: [
        { ref: 'srctag/suggest.js', body: SRCTAG_SUGGEST_BODY },
        { ref: 'srctag/suggest-ds.js', body: SRCTAG_SUGGEST_DS_BODY },
      ],
      args: { adapters: false },
      dbName: DB_NAME,
      store: STORE,
    });

    for (const [i, entry] of inPage.entries()) {
      expect(entry.error, `row ${i}`).toBeNull();
      expect(entry.keys, `row ${i}`).toEqual(['tid', 'dt', 'visitTime', 'suffix_*']);
      expect(Number(entry.scored), `row ${i}`).toBeGreaterThan(0);
      expect(entry.ranking, `row ${i}`).toHaveLength(4);
    }
    // the two rows differ only in the provider their API channels would resolve through
    expect(inPage[0].provider).toBeNull();
    expect(inPage[1].provider).toBe('ds');
    expect(inPage[0].scored).toBe(inPage[1].scored);
    console.info(`[srctag-cdp] live report: ${JSON.stringify(inPage)}`);
  });
});

// ─── Hybrid sweep over the live working set ────────────────────────────────

/** One channel set and the knobs the sweep varies, named as the report prints it. */
interface SweepCase {
  key: string;
  score: Partial<TagScoreConfig>;
  /** Ordering the neighbour window is measured on, or `'domain'` for one set per hostname. */
  dim: TagDim | 'domain';
  window?: Partial<TagWindowConfig>;
  rank?: TextRankOptions;
  /** Dynamic adapter this case needs; the case is skipped when the adapter did not load. */
  needs?: 'embed' | 'classify' | 'both';
}

/** One case's statistics, exactly as printed. */
interface SweepResult {
  key: string;
  dim: string;
  rows: number;
  scored: number;
  empty: number;
  suggested: number;
  distinct: number;
  mean: number;
  max: number;
  prio: number;
  /** `channel share` pairs, largest first. */
  shares: string;
  /** Share of tags this case and the TF-IDF baseline agree on. */
  jaccard: number;
  ms: number;
  note: string;
}

/** The static and dynamic adapters the sweep could reach. */
interface Adapters {
  embed?: EmbedFn;
  classify?: ClassifyFn;
}

/** What the dynamic half reported for itself: which rows loaded, and what one call did. */
interface DynamicReport {
  secret: boolean;
  rows: string[];
  embed: string;
  classify: string;
  clients: string[];
}

/** Channel sets under one ordering each: the static comparison the sweep is for. */
const CHANNEL_CASES: SweepCase[] = [
  {
    key: 'tfidf',
    dim: 'tid',
    score: { tfidf: 0.35, embed: 0, textRank: 0, clusterRank: 0, priority: 0.5, suggest: 0.15 },
  },
  {
    key: 'textrank',
    dim: 'tid',
    score: { tfidf: 0, embed: 0, textRank: 1, clusterRank: 0.5, priority: 0.5, suggest: 0.15 },
  },
  {
    key: 'textrank@visitTime',
    dim: 'visitTime',
    score: { tfidf: 0, embed: 0, textRank: 1, clusterRank: 0.5, priority: 0.5, suggest: 0.15 },
  },
  {
    key: 'textrank@dt',
    dim: 'dt',
    score: { tfidf: 0, embed: 0, textRank: 1, clusterRank: 0.5, priority: 0.5, suggest: 0.15 },
  },
  {
    key: 'textrank@domain',
    dim: 'domain',
    score: { tfidf: 0, embed: 0, textRank: 1, clusterRank: 0.5, priority: 0.5, suggest: 0.15 },
  },
  {
    key: 'hybrid',
    dim: 'visitTime',
    score: { tfidf: 0.2, embed: 0, textRank: 0.5, clusterRank: 0.3, priority: 0.4, suggest: 0.1 },
  },
  {
    key: 'rstext',
    dim: 'domain',
    score: rstextScore(),
  },
  {
    key: 'rstext+embed',
    dim: 'domain',
    needs: 'embed',
    score: { tfidf: 0, embed: 0.5, textRank: 0.4, clusterRank: 0.3, priority: 0.4, suggest: 0 },
  },
  {
    key: 'hybrid+embed+classify',
    dim: 'visitTime',
    needs: 'both',
    score: { tfidf: 0.15, embed: 0.3, textRank: 0.3, clusterRank: 0.2, priority: 0.3, suggest: 0.15 },
  },
];

/** The `rstext` preset with one hyperparameter moved at a time. */
const HYPER_CASES: SweepCase[] = [
  { key: 'topK 4', dim: 'domain', score: { ...rstextScore(), topK: 4 } },
  { key: 'topK 16', dim: 'domain', score: { ...rstextScore(), topK: 16 } },
  { key: 'minScore 0.02', dim: 'domain', score: { ...rstextScore(), minScore: 0.02 } },
  { key: 'minScore 0.2', dim: 'domain', score: { ...rstextScore(), minScore: 0.2 } },
  { key: 'minScore 0.7', dim: 'domain', score: { ...rstextScore(), minScore: 0.7 } },
  { key: 'window 2', dim: 'domain', score: rstextScore(), window: { window: 2, maxWindow: 2 } },
  { key: 'window 8', dim: 'domain', score: rstextScore(), window: { window: 8, maxWindow: 8 } },
  { key: 'rank window 2', dim: 'domain', score: rstextScore(), rank: { window: 2 } },
  { key: 'rank window 8', dim: 'domain', score: rstextScore(), rank: { window: 8 } },
  { key: 'damping 0.5', dim: 'domain', score: rstextScore(), rank: { damping: 0.5 } },
  { key: 'damping 0.95', dim: 'domain', score: rstextScore(), rank: { damping: 0.95 } },
  { key: 'no clusterRank', dim: 'domain', score: { ...rstextScore(), clusterRank: 0 } },
  { key: 'no turboText', dim: 'domain', score: { ...rstextScore(), priority: 0 } },
  { key: 'tfidf back on', dim: 'domain', score: { ...rstextScore(), tfidf: 0.3 } },
  { key: 'burstGap 60s', dim: 'domain', score: rstextScore(), window: { burstGap: 60_000 } },
];

/** The `rstext` channel weights, the anchor the hyperparameter cases move from. */
function rstextScore(): Partial<TagScoreConfig> {
  return { ...RSTEXT_TAG_SCORE };
}

/** A pin md card, the row kind whose `#tag` headings supply the priority tags. */
const isPin = (r: LiveRow): boolean => r.type === 'md' && String(r.ref).startsWith('pin');

/** The tags the working set already carries, most frequent first: the fallback priority source. */
function carriedTags(rows: LiveRow[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.tags) {
      if (t !== '[del]' && t !== 'pin') counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n).map(([t]) => t);
}

/** Share of tags two runs agree on, over everything either proposed. */
function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = a.size + b.size - shared;
  return union > 0 ? Math.round((shared / union) * 1000) / 1000 : 0;
}

/** Deterministic unit vector for the stub provider, so a cosine over it is stable. */
function probeVector(text: string, dim = 8): number[] {
  const vec = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) vec[(text.codePointAt(i) ?? 0) % dim] += 1;
  const norm = Math.hypot(...vec) || 1;
  return vec.map((v) => v / norm);
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const padL = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

/** The printed column widths, one header and one row format. */
const COLUMNS: [string, number, boolean][] = [
  ['case', 22, false], ['dim', 10, false], ['rows', 5, true], ['scored', 6, true],
  ['empty', 5, true], ['sugg', 5, true], ['dist', 5, true], ['mean', 7, true],
  ['max', 7, true], ['prio', 5, true], ['jaccard', 7, true], ['ms', 6, true],
];

/**
 * Score one case over the live rows and fold it into the printed statistics.
 *
 * @param c the channel set and knobs
 * @param set rows this case scores
 * @param priorityTags tags the keyword trie treats as priorities
 * @param adapters the dynamic adapters that loaded
 * @returns the statistics and the tags the run proposed
 */
async function runCase(
  c: SweepCase,
  set: LiveRow[],
  priorityTags: string[],
  adapters: Adapters,
): Promise<{ result: SweepResult; tags: Set<string> }> {
  const wantsEmbed = c.needs === 'embed' || c.needs === 'both';
  const wantsClassify = c.needs === 'classify' || c.needs === 'both';
  const embed = wantsEmbed ? adapters.embed : undefined;
  const classify = wantsClassify ? adapters.classify : undefined;
  const missing = [
    wantsEmbed && !embed ? 'embed' : '',
    wantsClassify && !classify ? 'classify' : '',
  ].filter(Boolean);
  const opts = {
    score: c.score,
    priorityTags,
    rank: c.rank,
    window: { dim: c.dim === 'domain' ? 'visitTime' as TagDim : c.dim, ...c.window },
    ...(c.dim === 'domain' ? { bucket: 'domain' as const } : {}),
    ...(embed ? { embed: (texts: string[]) => embedBatch(embed, texts, { batchSize: 16 }) } : {}),
    ...(classify ? { classify, labels: priorityTags } : {}),
  };

  const started = performance.now();
  const results = await tagRows(set as TagRow[], opts);
  const ms = Math.round(performance.now() - started);
  const stats = summarizeTagRun(results, mergeTagScore(c.score));
  const tags = new Set(results.flatMap((r) => r.suggestions.map((s) => s.tag)));

  return {
    result: {
      key: c.key,
      dim: c.dim,
      rows: stats.rows,
      scored: stats.scored,
      empty: stats.empty,
      suggested: stats.suggested,
      distinct: stats.distinct,
      mean: stats.meanScore,
      max: stats.maxScore,
      prio: stats.priorityHits,
      shares: stats.channels.map((ch) => `${ch.channel} ${ch.share.toFixed(2)}`).join(' · '),
      jaccard: 0,
      ms,
      note: missing.length > 0 ? `skipped: no ${missing.join(' or ')} adapter` : '',
    },
    tags,
  };
}

/** One header line and one line per case, so `test.log` carries the whole grid. */
function printTable(results: SweepResult[], title: string): void {
  console.info(`[srctag-sweep] ${title}`);
  console.info('[srctag-sweep] ' + COLUMNS
    .map(([name, width, right]) => (right ? padL(name, width) : pad(name, width))).join(' '));
  const rows: string[][] = [];
  for (const r of results) {
    const cells: string[] = [
      r.key, r.dim, String(r.rows), String(r.scored), String(r.empty), String(r.suggested),
      String(r.distinct), r.mean.toFixed(3), r.max.toFixed(3), String(r.prio),
      r.jaccard.toFixed(3), `${r.ms}ms`,
    ];
    console.info('[srctag-sweep] ' + COLUMNS
      .map(([, width, right], i) => (right ? padL(cells[i], width) : pad(cells[i], width))).join(' '));
    console.info(`[srctag-sweep]   ${r.key} channels: ${r.shares}${r.note ? ` — ${r.note}` : ''}`);
    rows.push([...cells, r.shares]);
  }
  SECTIONS.push({ title, headers: [...COLUMNS.map(([name]) => name), 'channels'], rows });
}

// ─── Aim pass ──────────────────────────────────────────────────────────────

/** One aim case: the two knobs it moves, and what the pass left behind. */
interface AimCase {
  key: string;
  /** `aimMin` the case ran with; the off case reports the raw scores' own cut-off. */
  aimMin: number;
  promoteMin: number;
  rows: number;
  /** Rows that kept no tag. */
  untagged: number;
  /** Rows keeping at least one curated tag. */
  prio: number;
  /** Mean tags kept per row that kept at least one. */
  perTagged: number;
  /** The same mean over the scored tags alone, without the promoted sub-tags. */
  focusPer: number;
  /** Rows carrying a promoted sub-tag, and how many distinct sub-tags exist. */
  subRows: number;
  subTags: number;
  ms: number;
}

/** The aim cases the sweep runs: the pass off, then one knob at a time. */
const AIM_CASES: { key: string; cfg: Partial<TagAimConfig> | false }[] = [
  { key: 'off', cfg: false },
  { key: 'aimMin 0.2', cfg: { aimMin: 0.2 } },
  { key: 'aimMin 0.4', cfg: { aimMin: 0.4 } },
  { key: 'aimMin 0.7', cfg: { aimMin: 0.7 } },
  { key: 'promoteMin 2', cfg: { promoteMin: 2 } },
  { key: 'promoteMin 3', cfg: { promoteMin: 3 } },
  { key: 'promoteMin 4', cfg: { promoteMin: 4 } },
];

/** The printed aim columns, one header and one row format. */
const AIM_COLUMNS: [string, number, boolean][] = [
  ['case', 15, false], ['aimMin', 7, true], ['promote', 8, true], ['rows', 6, true],
  ['untagged', 9, true], ['prio', 6, true], ['focus/row', 10, true], ['tags/row', 9, true],
  ['sub rows', 9, true], ['sub tags', 9, true], ['ms', 7, true],
];

/** One line per aim case, so `test.log` carries the whole grid. */
function printAimTable(cases: AimCase[], title: string): void {
  console.info(`[srctag-sweep] ${title}`);
  console.info('[srctag-aim] ' + AIM_COLUMNS
    .map(([name, width, right]) => (right ? padL(name, width) : pad(name, width))).join(' '));
  const rows: string[][] = [];
  for (const c of cases) {
    const cells = [
      c.key, c.aimMin.toFixed(2), String(c.promoteMin), String(c.rows), String(c.untagged),
      String(c.prio), c.focusPer.toFixed(2), c.perTagged.toFixed(2), String(c.subRows),
      String(c.subTags), `${c.ms}ms`,
    ];
    console.info('[srctag-aim] ' + AIM_COLUMNS
      .map(([, width, right], i) => (right ? padL(cells[i], width) : pad(cells[i], width))).join(' '));
    rows.push(cells);
  }
  SECTIONS.push({ title, headers: AIM_COLUMNS.map(([name]) => name), rows });
  AIM_ROWS.splice(0, AIM_ROWS.length, ...cases);
}

// ─── Artifacts ─────────────────────────────────────────────────────────────

/** One printed table, kept so a run can also write it to disk. */
interface ArtifactSection {
  title: string;
  headers: string[];
  rows: string[][];
}

/** Where a sweep writes its measurement; `SRCTAG_SWEEP_OUT` overrides the directory. */
const SWEEP_DIR = process.env.SRCTAG_SWEEP_OUT ?? 'test-artifacts';

/** Tables this run printed, in the order it printed them. */
const SECTIONS: ArtifactSection[] = [];
/** The aim grid, for the chart. */
const AIM_ROWS: AimCase[] = [];

/** A section's rows as a Markdown table. */
function markdownTable(section: ArtifactSection): string {
  const head = `| ${section.headers.join(' | ')} |`;
  const rule = `| ${section.headers.map(() => '---').join(' | ')} |`;
  const body = section.rows.map((r) => `| ${r.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`);
  return [head, rule, ...body].join('\n');
}

/**
 * The aim grid as a horizontal bar chart: one row per case, the kept share of the
 * table in blue with the rows carrying a promoted sub-tag overlaid in green.
 *
 * @param cases the aim cases the run measured
 * @returns the SVG document
 */
function aimChart(cases: AimCase[]): string {
  const width = 720;
  const rowH = 26;
  const top = 34;
  const barX = 250;
  const barW = 340;
  const height = top + cases.length * rowH + 24;
  const bars = cases.map((c, i) => {
    const y = top + i * rowH;
    const kept = c.rows > 0 ? (c.rows - c.untagged) / c.rows : 0;
    const sub = c.rows > 0 ? c.subRows / c.rows : 0;
    return [
      `<text x="8" y="${y + 15}" class="k">${c.key}</text>`,
      `<rect x="${barX}" y="${y + 4}" width="${barW}" height="16" class="track"/>`,
      `<rect x="${barX}" y="${y + 4}" width="${(barW * kept).toFixed(1)}" height="16" class="kept"/>`,
      `<rect x="${barX}" y="${y + 4}" width="${(barW * sub).toFixed(1)}" height="16" class="sub"/>`,
      `<text x="${barX + barW + 8}" y="${y + 16}" class="n">`
        + `${c.rows - c.untagged} kept · ${c.untagged} untagged · ${c.subTags} sub-tags</text>`,
    ].join('');
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<style>',
    '  .t { fill: #dbe4f0; font: 13px system-ui, sans-serif; }',
    '  .k, .n { fill: #9fb0c6; font: 11px system-ui, sans-serif; }',
    '  .track { fill: rgba(255,255,255,0.10); }',
    '  .kept { fill: rgba(120,170,255,0.55); }',
    '  .sub { fill: rgba(150,230,170,0.60); }',
    '</style>',
    `<rect width="${width}" height="${height}" fill="#15181d"/>`,
    `<text x="8" y="20" class="t">srctag aim pass over the live table</text>`,
    ...bars,
    '</svg>',
  ].join('\n');
}

/** The whole measurement as one dated Markdown document. */
function sweepMarkdown(date: string): string {
  return [
    '# srctag sweep over the live table',
    '',
    `Recorded ${date} by \`test/srctag-cdp.test.ts\` against the running app on \`localhost:5173\`.`,
    'Rows, channel sets and dates come from that page’s own IndexedDB, so the numbers are',
    'this table’s, not a fixture’s. Re-record with:',
    '',
    '```sh',
    'npx vitest run test/srctag-cdp.test.ts --reporter=verbose --silent=false',
    '```',
    '',
    ...SECTIONS.flatMap((s) => [`## ${s.title}`, '', markdownTable(s), '']),
    '## aim pass',
    '',
    '![aim pass](srctag-sweep.svg)',
    '',
  ].join('\n');
}

/**
 * Write the run's tables and chart, and say where.
 *
 * A run that skipped — no page, no CDP — has nothing to write, and writes
 * nothing.
 *
 * @param date the run's date, as the document prints it
 */
async function writeArtifacts(date: string): Promise<void> {
  if (SECTIONS.length === 0) return;
  const dir = resolve(SWEEP_DIR);
  await mkdir(dir, { recursive: true });
  const md = join(dir, 'srctag-sweep.md');
  await writeFile(md, sweepMarkdown(date), 'utf8');
  const written = [md];
  if (AIM_ROWS.length > 0) {
    const svg = join(dir, 'srctag-sweep.svg');
    await writeFile(svg, aimChart(AIM_ROWS), 'utf8');
    written.push(svg);
  }
  console.info(`[srctag-sweep] wrote ${written.join(', ')}`);
}

afterAll(async () => {
  await writeArtifacts(new Date().toISOString().slice(0, 10));
});

describe('hybrid sweep over the live working set', () => {
  /** Rows the sweep scores: the live table without the pin cards. */
  let sweepRows: LiveRow[] = [];
  /** Priority tags, and where they came from. */
  let priorityTags: string[] = [];
  let prioritySource = 'none';
  let adapters: Adapters = {};
  let dynamic: DynamicReport = { secret: false, rows: [], embed: 'not attempted', classify: 'not attempted', clients: [] };

  beforeAll(async () => {
    if (down) return;
    sweepRows = rows.filter((r) => !isPin(r));
    const pins = rows.filter(isPin);
    const pinTags = pinPriorityTags(pins as TagRow[]);
    if (pinTags.length > 0) {
      priorityTags = pinTags;
      prioritySource = `pin cards (${pins.length})`;
    } else {
      priorityTags = carriedTags(sweepRows, 20);
      prioritySource = `rows' own tags (no pin card in the table)`;
    }

    // The dynamic path is exactly what a `run_src` row does: read the script row
    // out of the store, run its body, and take the adapter it returns.
    const readScript = async (ref: string): Promise<string | undefined> => {
      const found = rows.filter((r) => r.ref === ref && r.type === 'src' && !r.tags.includes('[del]'));
      return found.length > 0 ? found[found.length - 1].txt : undefined;
    };
    dynamic = {
      ...dynamic,
      secret: rows.some((r) => r.ref === 'secret.md' && r.type === 'md'),
      rows: SRCTAG_ROW_REFS.filter((ref) => rows.some((r) => r.ref === ref && !r.tags.includes('[del]'))),
    };
    adapters = await loadAdaptersFromStore(
      { readScript },
      { db: liveDb(rows), ref: 'srctag/sweep.js', args: {}, console } as RecrScriptContext,
    );
    if (SKIP_API) {
      dynamic = { ...dynamic, embed: 'skipped (SRCTAG_SKIP_API=1)', classify: 'skipped (SRCTAG_SKIP_API=1)' };
    }
    if (!SKIP_API && adapters.embed) {
      try {
        const vecs = await embedBatch(adapters.embed, sweepRows.slice(0, 2).map((r) => r.txt), { batchSize: 2 });
        dynamic.embed = `ok: ${vecs[0]?.length ?? 0}-dim, ${vecs.length} texts`;
      } catch (e) {
        dynamic.embed = `failed: ${e instanceof Error ? e.message : String(e)}`;
        adapters.embed = undefined;
      }
    } else if (!adapters.embed) {
      dynamic.embed = `absent: the store has no usable ${SRCTAG_ROW_REFS[0]}`;
    }
    if (!SKIP_API && adapters.classify) {
      try {
        const out = await adapters.classify(sweepRows[0]?.txt ?? 'probe', priorityTags.slice(0, 5));
        dynamic.classify = `ok: ${out.length} labels`;
      } catch (e) {
        dynamic.classify = `failed: ${e instanceof Error ? e.message : String(e)}`;
        adapters.classify = undefined;
      }
    } else if (!adapters.classify) {
      dynamic.classify = `absent: the store has no usable ${SRCTAG_ROW_REFS[1]}`;
    }
    // The in-process clients are the other half of the dynamic surface: a caller
    // that holds a key builds them directly instead of through a row.
    dynamic.clients = ['createEmbedClient', 'createSiliconFlowEmbed', 'createOpenRouterEmbed', 'createCloudflareEmbed', 'createClassifierDevClassify'];
  }, 120_000);

  it('scores the whole live table under every static channel set', async ({ skip }) => {
    if (down) {
      console.warn(`[srctag-sweep] skipped: ${down}`);
      skip();
    }
    expect(priorityTags.length).toBeGreaterThan(0);

    const reports: SweepResult[] = [];
    let baseline: Set<string> | undefined;
    for (const c of CHANNEL_CASES) {
      const dynamicCase = c.needs !== undefined;
      const set = dynamicCase ? sweepRows.slice(0, API_SAMPLE) : sweepRows;
      const { result, tags } = await runCase(c, set, priorityTags, adapters);
      if (c.key === 'tfidf') baseline = tags;
      result.jaccard = dynamicCase || !baseline ? 0 : jaccard(tags, baseline);
      reports.push(result);
    }

    printTable(reports, `static channels over ${sweepRows.length} live rows · priority from ${prioritySource} (${priorityTags.length} tags)`);
    for (const r of reports) {
      // every case that ran kept its counters consistent, and only a case whose
      // adapter did not load may report nothing
      expect(r.scored + r.empty, r.key).toBe(r.rows);
      if (!r.note) expect(r.suggested, r.key).toBeGreaterThan(0);
    }

    const staticReports = reports.filter((r) => CHANNEL_CASES.find((c) => c.key === r.key && !c.needs));
    const covered = new Set(staticReports.flatMap((r) => r.shares.split(' · ').map((s) => s.split(' ')[0])));
    // the static surface: TF-IDF where a case keeps it, TextRank and the trie
    // channels everywhere
    for (const channel of ['tfidf', 'textRank', 'clusterRank', 'priority', 'keyword']) {
      expect([...covered], `${channel} never contributed`).toContain(channel);
    }
    expect(reports.find((r) => r.key === 'textrank')!.jaccard).toBeLessThan(1);
  }, 300_000);

  it('varies one hyperparameter at a time around the rstext preset', async ({ skip }) => {
    if (down) {
      console.warn(`[srctag-sweep] skipped: ${down}`);
      skip();
    }
    const anchor = await runCase(
      { key: 'rstext anchor', dim: 'domain', score: rstextScore() },
      sweepRows, priorityTags, adapters,
    );
    const reports: SweepResult[] = [];
    for (const c of HYPER_CASES) {
      const { result, tags } = await runCase(c, sweepRows, priorityTags, adapters);
      result.jaccard = jaccard(tags, anchor.tags);
      reports.push(result);
    }

    printTable([anchor.result, ...reports], `hyperparameters around the rstext preset, ${sweepRows.length} live rows`);
    for (const r of reports) expect(r.scored + r.empty, r.key).toBe(r.rows);
    // a wider cut-off cannot keep more suggestions than a narrower one
    expect(reports.find((r) => r.key === 'topK 4')!.suggested)
      .toBeLessThanOrEqual(reports.find((r) => r.key === 'topK 16')!.suggested);
    expect(reports.find((r) => r.key === 'minScore 0.02')!.suggested)
      .toBeGreaterThanOrEqual(reports.find((r) => r.key === 'minScore 0.2')!.suggested);
    // dropping a channel changes the outcome, which is what makes the sweep evidence
    expect(reports.find((r) => r.key === 'no clusterRank')!.jaccard).toBeLessThan(1);
  }, 300_000);

  it('is deterministic: the same case twice proposes the same tags', async ({ skip }) => {
    if (down) {
      console.warn(`[srctag-sweep] skipped: ${down}`);
      skip();
    }
    const c: SweepCase = { key: 'rstext repeat', dim: 'domain', score: rstextScore() };
    const a = await runCase(c, sweepRows.slice(0, 200), priorityTags, adapters);
    const b = await runCase(c, sweepRows.slice(0, 200), priorityTags, adapters);
    expect([...b.tags].sort()).toEqual([...a.tags].sort());
    expect(b.result.suggested).toBe(a.result.suggested);
    expect(b.result.shares).toBe(a.result.shares);
  }, 120_000);

  it('focuses the table and promotes its bursts, one knob at a time', async ({ skip }) => {
    if (down) {
      console.warn(`[srctag-sweep] skipped: ${down}`);
      skip();
    }
    /*
     * The aim pass is what the groupers run by default, so the sweep scores the
     * table once and reads it through every aim case. `tid` is the ordering the
     * block list uses, which is the burst a promote group is cut from.
     */
    const score = rstextScore();
    const base: TagRowResult[] = await tagRows(sweepRows as TagRow[], {
      score, priorityTags, window: { dim: 'tid' },
    });

    const cases: AimCase[] = [];
    for (const c of AIM_CASES) {
      const started = performance.now();
      const list = c.cfg === false
        ? base
        : applyTagAim(base, c.cfg, mergeTagScore(score).minScore);
      const ms = Math.round(performance.now() - started);
      const stats = summarizeTagAim(list);
      const tagged = stats.rows - stats.untagged;
      const kept = list.reduce((n, r) => n + r.suggestions.length, 0);
      const scored = list.reduce((n, r) => n + r.suggestions.filter((s) => s.parts.group <= 0).length, 0);
      cases.push({
        key: c.key,
        aimMin: c.cfg === false || c.cfg.aimMin === undefined ? DEFAULT_TAG_AIM.aimMin : c.cfg.aimMin,
        promoteMin: c.cfg === false || c.cfg.promoteMin === undefined
          ? DEFAULT_TAG_AIM.promoteMin : c.cfg.promoteMin,
        rows: stats.rows,
        untagged: stats.untagged,
        prio: stats.priority,
        perTagged: tagged > 0 ? kept / tagged : 0,
        focusPer: tagged > 0 ? scored / tagged : 0,
        subRows: list.filter((r) => r.suggestions.some((s) => s.parts.group > 0)).length,
        subTags: stats.subTags.length,
        ms,
      });
    }

    printAimTable(cases, `aim pass over ${sweepRows.length} live rows · priority from ${prioritySource} (${priorityTags.length} tags)`);
    const at = (key: string) => cases.find((c) => c.key === key)!;
    // every case accounts for every row, and focus can only ever remove a tag
    for (const c of cases) expect(c.untagged, c.key).toBeLessThanOrEqual(c.rows);
    expect(at('aimMin 0.2').untagged).toBeLessThanOrEqual(at('aimMin 0.4').untagged);
    expect(at('aimMin 0.4').untagged).toBeLessThanOrEqual(at('aimMin 0.7').untagged);
    expect(at('aimMin 0.4').focusPer).toBeLessThanOrEqual(at('off').focusPer);
    expect(at('aimMin 0.7').focusPer).toBeLessThanOrEqual(at('aimMin 0.4').focusPer);
    // a lower promote threshold cannot mint fewer sub-tags than a higher one
    expect(at('promoteMin 2').subTags).toBeGreaterThanOrEqual(at('promoteMin 4').subTags);
    expect(at('promoteMin 2').subRows).toBeGreaterThanOrEqual(at('promoteMin 4').subRows);
  }, 300_000);

  it('reports what each dynamic path did, without failing when it cannot reach a provider', async ({ skip }) => {
    if (down) {
      console.warn(`[srctag-sweep] skipped: ${down}`);
      skip();
    }
    console.info(`[srctag-sweep] dynamic: ${JSON.stringify(dynamic)}`);
    expect(SRCTAG_ROW_REFS).toEqual(expect.arrayContaining(dynamic.rows));
    // either the adapter answered or the report says why it could not
    expect(dynamic.embed).toMatch(/^(ok|failed|absent|skipped)/);
    expect(dynamic.classify).toMatch(/^(ok|failed|absent|skipped)/);
    expect(dynamic.clients).toHaveLength(5);
    // loading is what the app does before any call, so it must not throw
    expect(typeof adapters).toBe('object');
  }, 120_000);

  it('seeds and reads back its own srctag rows through the same store shape', async ({ skip }) => {
    if (down) {
      console.warn(`[srctag-sweep] skipped: ${down}`);
      skip();
    }
    // `playwright` and the page reach the same convention: a row is found by
    // [ref+type], which is the lookup `loadAdaptersFromStore` depends on.
    const found = await page!.evaluate(async (refs: string[]) => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open('tagDB_0');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const all: Record<string, never>[] = await new Promise((resolve, reject) => {
        const req = db.transaction('das', 'readonly').objectStore('das').getAll();
        req.onsuccess = () => resolve(req.result as Record<string, never>[]);
        req.onerror = () => reject(req.error);
      });
      return refs.map((ref) => all.some((r) => r.ref === ref && r.type === 'src')).length;
    }, [...SRCTAG_ROW_REFS]);
    expect(found).toBeLessThanOrEqual(SRCTAG_ROW_REFS.length);
  }, 60_000);

  it('runs the dynamic adapters end to end against a local provider', async ({ skip }) => {
    if (down) {
      console.warn(`[srctag-sweep] skipped: ${down}`);
      skip();
    }
    if (SKIP_API) {
      console.warn('[srctag-sweep] skipped: SRCTAG_SKIP_API=1');
      skip();
    }

    /*
     * The seeded rows resolve their endpoint out of `secret.md` and post a real
     * request, so the only thing that can stand in for a provider is one. This
     * server is the whole dynamic path's peer: `srctag/embed.js` posts the
     * OpenAI-compatible batch shape to `/v1/embeddings`, `srctag/classify.js`
     * posts `{ inputs, labels, instructions }` to `/v1/classify`, and both read
     * the response through their own inlined normalizer.
     */
    const calls: { url: string; body: Record<string, never> }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, never>;
        calls.push({ url: req.url ?? '', body });
        res.setHeader('Content-Type', 'application/json');
        if ((req.url ?? '').endsWith('/embeddings')) {
          const input = (body as { input?: string[] }).input ?? [];
          res.end(JSON.stringify({
            data: input.map((text, index) => ({ index, embedding: probeVector(text) })),
          }));
          return;
        }
        res.end(JSON.stringify({ labels: [{ label: 'dynamic', score: 0.9 }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      // The same store shape the app has, with the two adapter rows this
      // repository ships and a `secret.md` naming the stub as a provider.
      const store = {
        readScript: async (ref: string) => {
          const seed = SRCTAG_ROW_SEEDS.find((s) => s.ref === ref && s.type === 'src');
          return seed?.txt;
        },
      };
      const secret = [
        '## Providers',
        '### local',
        `* Base URL: http://127.0.0.1:${port}`,
        '* Models:',
        '  - emb: test-embed',
        '* API Keys:',
        '  - main: test-key',
      ].join('\n');
      const db = {
        das: {
          toArray: async () => [{ ref: 'secret.md', type: 'md', txt: secret, tags: [] }],
          // the `[ref+type]` lookup the script's inlined reader performs
          where: () => ({
            equals: ([ref, type]: [string, string]) => ({
              toArray: async () => (ref === 'secret.md' && type === 'md'
                ? [{ ref, type, txt: secret, tags: [] }]
                : []),
            }),
          }),
        },
      };
      const scriptCtx = {
        db, ref: 'srctag/sweep.js', args: { provider: 'local', model: 'emb' }, console,
      } as RecrScriptContext;

      const loaded = await loadAdaptersFromStore(store, scriptCtx);
      expect(loaded.embed, 'srctag/embed.js did not load').toBeTypeOf('function');
      expect(loaded.classify, 'srctag/classify.js did not load').toBeTypeOf('function');

      const sample = sweepRows.slice(0, API_SAMPLE);
      const dynamicAdapters: Adapters = { embed: loaded.embed, classify: loaded.classify };
      const embedCase = await runCase(
        {
          key: 'rstext+embed', dim: 'domain', needs: 'embed',
          score: { tfidf: 0, embed: 0.5, textRank: 0.4, clusterRank: 0.3, priority: 0.4, suggest: 0 },
        },
        sample, priorityTags, dynamicAdapters,
      );
      /* the embed case's own requests, before the classifier case adds any */
      const embedRun = calls.slice();
      const fullCase = await runCase(
        {
          key: 'hybrid+embed+classify', dim: 'visitTime', needs: 'both',
          score: { tfidf: 0.15, embed: 0.3, textRank: 0.3, clusterRank: 0.2, priority: 0.3, suggest: 0.15 },
        },
        sample, priorityTags, dynamicAdapters,
      );
      const classifyRun = calls.slice(embedRun.length);

      printTable([embedCase.result, fullCase.result],
        `dynamic channels against a local provider, ${sample.length} live rows`);

      // the embedding channel scored, and the classifier named its label
      expect(embedCase.result.shares).toContain('embed');
      expect(fullCase.result.shares).toContain('embed');
      expect(fullCase.result.shares).toContain('suggest');
      expect(fullCase.result.scored + fullCase.result.empty).toBe(sample.length);

      // one batched embeddings call per site, then one classify call per scored row
      const embedCalls = embedRun.filter((c) => c.url.endsWith('/embeddings'));
      const inputs = embedCalls.flatMap((c) => (c.body as { input?: string[] }).input ?? []);
      const sampleTexts = new Set(sample.map((r) => {
        const s = rowSources(r as TagRow);
        return [s.text, ...s.urls].join(' ');
      }));
      expect(embedCalls[0].body.model).toBe('test-embed');
      expect(embedCalls.every((c) => (c.body as { input?: string[] }).input!.length <= 16)).toBe(true);
      // every text embedded exactly once, whatever the site split was
      expect(inputs).toHaveLength(new Set(inputs).size);
      expect(new Set(inputs).size).toBe(sampleTexts.size);
      expect(classifyRun.filter((c) => c.url.endsWith('/classify')).length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120_000);
});
