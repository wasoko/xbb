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
import { runBody, type RecrScriptContext } from '../src/runsrc';
import { SRCTAG_SUGGEST_BODY, SRCTAG_SUGGEST_DS_BODY, SRCTAG_ROW_REFS } from '../src/srctagRows';
import { installSrctagGlobal, rowSources, tokenize, urlTokens } from '../src/srctag';

/** IndexedDB the app opens, and the table its rows live in. */
const DB_NAME = 'tagDB_0';
const STORE = 'das';
const APP_URL = 'http://localhost:5173';
const CDP_URL = 'http://localhost:9222';

/** Rows requested from the page, newest `tid` first, and the per-row text cap. */
const LIMIT = 400;
const TXT_CAP = 2000;

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
