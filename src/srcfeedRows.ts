/**
 * srcfeedRows.ts — the `srcfeed.md` registry and the source rows the examples read.
 *
 * The engine lives apart, in `src/srcfeed.ts`, and imports nothing from the app.
 * This module holds the texts a caller seeds and the helper that writes them:
 *
 *   `srcfeed.md`           every source once: URL, `Src:` row, tags, retry budget
 *   `srcdom/sinaCNmedia`   a site adapter that reads a `sina.cn/media/<id>` page
 *   `extdom/dsc`, `extdom/ge`  tab adapters, run through `chrome.userScripts`
 *   `w.feed.md`, `y.feed.md`, `x.feed.md`  the default feed and two examples
 *   `webfeed/extract.js`   the legacy body that reads a `webfeed.md`, kept working
 *
 * A `data:`-URL module has no base URL, so an adapter body cannot import the engine:
 * it calls `globalThis.srcfeed`, which `src/ui/routes.tsx` installs at boot.
 *
 * Nothing here is written automatically: {@link seedSrcFeedRows} is the caller's
 * step, and it keeps any live row the user already has.
 */

import type { BodyTwin } from './runsrc';
import { W_FEED_DOC, W_FEED_REF, EXTSRC_EXTRACT_REF, feedSourceOf, readSource } from './srcfeed';
import {
  DEFAULT_FALLBACK, WEBFEED_REF, extractFromDoc, htmlPostItems,
  type FeedDb, type FeedDocResult, type FeedFallback,
} from './srcfeedWeb';
import type { TagSeedRow, TagSeedTable } from './srctagRows';

/** Row ref of the site adapter that reads a `sina.cn/media/<id>` page. */
export const SRCDOM_SINA_REF = 'srcdom/sinaCNmedia';

/** Row refs of the two tab adapters. Their body is the generic `extsrc` reader. */
export const EXTDOM_DSC_REF = 'extdom/dsc';
export const EXTDOM_GE_REF = 'extdom/ge';

/**
 * The legacy `extsrc.md` document, kept for the adapter test.
 *
 * A `srcfeed.md` replaces it; an installation that still has only this document is
 * read through `extsrc/extract.js`, one entry per `### name` block.
 */
export const EXTSRC_DOC = `# extsrc

## Sources

### gemini
* URL: https://gemini.google.com/*
* Sidebar: [data-test-id="chat-history"]
* Item: a[href^="/app/"]
* Mode: dom
* Max: 200
* Prompt: open the chat sidebar (☰) in the Gemini tab
* Tags: gemini chat

### deepseek
* URL: https://chat.deepseek.com/*
* Sidebar: .chat-history
* Item: a[href^="/a/chat"]
* Mode: dom
* Max: 200
* Prompt: open the history sidebar in the DeepSeek tab
* Tags: deepseek chat
`;

/**
 * Body of `extsrc/extract.js`: read one registry entry out of the tab it runs in.
 *
 * Runs inside the page, so it uses the DOM directly and has no store access. The
 * runner supplies the entry as `ctx.args.source`. The item list decides what the page
 * shows: a list rendered without the declared sidebar wrapper still reads, and an
 * empty list asks for the entry's manual step.
 */
export const EXTSRC_EXTRACT_BODY = `// @requires tab
// @requires user-scripts
const src = ctx.args.source || {};
if (!src.url) throw new Error('srcfeed: ctx.args.source.url is missing');

const scroller = src.scroll ? document.querySelector(src.scroll) : null;
for (let pass = 0; scroller && pass < 3; pass++) {
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight) break;
  scroller.scrollTop = scroller.scrollHeight;
  await new Promise(function (resolve) { setTimeout(resolve, 300); });
}

const max = Math.max(1, Number(src.max) || 200);
const nodes = src.item ? Array.from(document.querySelectorAll(src.item)) : [];
const rows = [];
for (const el of nodes.slice(0, max)) {
  const href = el.href || el.getAttribute('href') || '';
  if (!href) continue;
  const txt = (el.textContent || '').replace(/\\s+/g, ' ').trim() || el.getAttribute('title') || href;
  const row = { txt: txt, ref: href, tags: [src.name].concat(src.tags || []) };
  if (src.mode === 'html') row.rec = { html: (el.outerHTML || '').slice(0, 2000) };
  rows.push(row);
}
if (rows.length === 0 && (src.prompt || (src.sidebar && !document.querySelector(src.sidebar)))) {
  return { rows: [], notes: [], needsUser: src.prompt || 'open the history sidebar in this tab' };
}
const notes = rows.length === 0 && src.item ? ['no element matched ' + src.item] : [];
return { rows: rows, notes: notes };
`;

/** Row ref of the legacy body that extracts every source of a `webfeed.md`. */
export const WEBFEED_EXTRACT_REF = 'webfeed/extract.js';

/**
 * The legacy `webfeed.md` document, kept for the engine's own tests.
 *
 * New installations seed `srcfeed.md`; an installation that still holds this
 * document is read through `srcfeed.ts`'s legacy adapter, with the strategy walk
 * below.
 */
export const WEBFEED_DOC = `# Feeds

## Sources

An entry is read top-down, newest first, and the walk stops at the first item
the store already holds, so a second extraction returns only what is newer.

### wallstreetcn
* URL: https://wallstreetcn.com/live/global
* Type: url
* API:
  - lives: https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=30
* Tags:
  - finance
  - cn

### zhihu-fly51fly
* URL: https://www.zhihu.com/people/fly51fly
* API:
  - activities: https://www.zhihu.com/api/v4/members/fly51fly/activities?limit=20

### sina-fly51fly
* URL: https://www.sina.cn/media/1402400261
* Proxy Headers:
  - X-Return-Format: html

### weibo-fly51fly
* URL: https://weibo.com/u/2337530130
* Session: weibo
* API:
  - cards: https://m.weibo.cn/api/container/getIndex?containerid=2304132337530130&page=1&count=20

## Fallback

* Proxy URL: https://r.jina.ai/
* Retries: 2
* Base delay ms: 800
* Cap delay ms: 8000
* Timeout ms: 15000
`;

/**
 * Body of `webfeed/extract.js`: extract every source the legacy document declares
 * and return a report.
 *
 * Self-contained by necessity — a `data:`-URL body resolves no import — so the
 * only thing it calls is the global engine. `ctx.args` is forwarded whole, which
 * is what lets `{ sources: ['wallstreetcn'], limit: 5 }` narrow a run without a
 * reseed.
 */
export const WEBFEED_EXTRACT_BODY = `// The engine is reached through the global that routes.tsx installs; a data:-URL
// body has no base URL, so no import from here could resolve.
const api = (typeof globalThis !== 'undefined' && globalThis.webfeed) || null;
if (!api) throw new Error('webfeed: global API missing (installWebfeedGlobal() runs at boot)');

const args = ctx.args || {};
const out = await api.extractFromDoc({ db: ctx.db, args: args, console: ctx.console });

const sources = out.sources.map(function (r) {
  const tries = r.attempts.map(function (a) {
    const how = a.ok ? 'ok' : (a.error || 'fail');
    return a.strategy + '(' + (a.status || '-') + ' ' + how + ' ' + a.ms + 'ms)';
  }).join(' ');
  return r.source + ' -> ' + (r.strategy || 'none') + ', ' + r.das.length + ' row(s)'
    + (r.stoppedAt ? ', stopped at last check' : '') + '\\n  ' + tries;
});

return {
  ref: out.ref,
  total: out.das.length,
  sources: sources,
  answered: out.sources
    .filter(function (r) { return r.strategy !== null; })
    .map(function (r) { return r.source; }),
  notes: out.notes,
  das: out.das.slice(0, Number(args.showRows) || 10),
};`;

/** `ctx.args` of a `run_src` call, as a report reads it. */
const asArgs = (args: unknown): Record<string, unknown> =>
  (typeof args === 'object' && args !== null ? args as Record<string, unknown> : {});

/**
 * The report {@link WEBFEED_EXTRACT_BODY} returns, built from the engine's own result.
 *
 * The body formats the per-source lines, reports which sources answered, and slices
 * `das` to `showRows`; all are part of what `run_src` hands a model, so the compiled
 * path reproduces them exactly rather than returning the engine result unchanged.
 *
 * @param out result of {@link extractFromDoc}
 * @param args the body's `ctx.args`, for `showRows`
 * @returns the value the seeded body would have returned
 */
export function webFeedReport(out: FeedDocResult, args: Record<string, unknown>): unknown {
  const sources = out.sources.map((r) => {
    const tries = r.attempts.map((a) => {
      const how = a.ok ? 'ok' : (a.error || 'fail');
      return a.strategy + '(' + (a.status || '-') + ' ' + how + ' ' + a.ms + 'ms)';
    }).join(' ');
    return r.source + ' -> ' + (r.strategy || 'none') + ', ' + r.das.length + ' row(s)'
      + (r.stoppedAt ? ', stopped at last check' : '') + '\n  ' + tries;
  });
  return {
    ref: out.ref,
    total: out.das.length,
    sources,
    answered: out.sources.filter((r) => r.strategy !== null).map((r) => r.source),
    notes: out.notes,
    das: out.das.slice(0, Number(args.showRows) || 10),
  };
}

/**
 * The seeded registry.
 *
 * An entry without `Src:` is answered by a server and read by the built-in walk
 * (API, page, mobile mirror, proxy). An entry with `Src:` names the row that reads
 * it end to end; `extdom/*` rows also carry `@requires tab`, so they run only in the
 * extension, in a tab whose URL the entry matches.
 */
export const SRCFEED_DOC = `# srcfeed

## Sources

Every entry is one source, declared once. \`Src:\` names the \`type='src'\` row that
reads it; a source without one is read by the built-in web walk (\`URL\`, then its
\`API\`, mobile mirror and proxy).

### wallstreetcn
* URL: https://wallstreetcn.com/live/global
* Type: url
* API:
  - lives: https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=30
* Tags:
  - finance
  - cn

### sina
* URL: https://www.sina.cn/media/1402400261
* Src: ${SRCDOM_SINA_REF}
* Proxy Headers:
  - X-Return-Format: html
* Tags:
  - media

### dsc
* URL: https://chat.deepseek.com/*
* Src: ${EXTDOM_DSC_REF}
* Type: url
* Item: a[href^="/a/chat"]
* Prompt: open the history sidebar in the DeepSeek tab
* Tags:
  - deepseek
  - chat

### ge
* URL: https://gemini.google.com/*
* Src: ${EXTDOM_GE_REF}
* Type: url
* Sidebar: [data-test-id="chat-history"]
* Item: a[href^="/app/"]
* Prompt: open the chat sidebar (☰) in the Gemini tab
* Tags:
  - gemini
  - chat

## Fallback

* Proxy URL: https://r.jina.ai/
* Retries: 2
* Base delay ms: 800
* Cap delay ms: 8000
* Timeout ms: 15000
`;

/**
 * Body of `srcdom/sinaCNmedia`: the site adapter for a `sina.cn` media page.
 *
 * Self-contained by necessity — a `data:`-URL body resolves no import — so the only
 * thing it calls is the global engine. `srcfeed.read` walks the strategies and
 * returns the body that answered; the page's posts are already in that document.
 */
export const SRCDOM_SINA_BODY = `// The engine is reached through the global that routes.tsx installs; a data:-URL
// body has no base URL, so no import from here could resolve.
const api = (typeof globalThis !== 'undefined' && globalThis.srcfeed) || null;
if (!api) throw new Error('srcfeed: global API missing (installSrcFeedGlobal() runs at boot)');

const source = ctx.args.source || {};
const out = await api.read(source, ctx.args.fallback || undefined);
if (out.strategy === null) {
  return { rows: [], notes: out.notes.length ? out.notes : ['no strategy answered'] };
}
return { rows: api.posts(out.body, source.url), notes: out.notes };`;

/** The feed a web source answers: two items, one schedule, no chat. */
export const Y_FEED_DOC = `# y.feed

## Setup
freq: 2hr
next:
sources: wallstreetcn, sina

## Notes

One web feed: \`wallstreetcn\` is answered by its JSON API, \`sina\` by its own
\`srcdom\` reader. Both entries live in \`srcfeed.md\`; this document names them and
keeps the schedule and what each read found.
`;

/** The feed the two chat sidebars answer. */
export const X_FEED_DOC = `# x.feed

## Setup
freq: 2hr
next:
sources: dsc, ge

## Notes

Two tab sources: open the DeepSeek and Gemini tabs and their history sidebars, then
read. A tab source is never implicit, so an empty \`sources:\` here reads nothing
rather than whichever tab happens to match.
`;

/**
 * Compiled counterparts of the seeded bodies, registered at boot.
 *
 * A row the user edited is a different string, so it never matches an entry here
 * and cannot silently run code other than the text it holds.
 */
export const SRCFEED_BODY_TWINS: ReadonlyMap<string, BodyTwin> = new Map<string, BodyTwin>([
  [SRCDOM_SINA_BODY, async (ctx) => {
    const args = asArgs(ctx.args);
    const source = feedSourceOf(args.source);
    const fallback = (args.fallback ?? DEFAULT_FALLBACK) as FeedFallback;
    const out = await readSource(source, fallback);
    if (out.strategy === null) {
      return { rows: [], notes: out.notes.length > 0 ? out.notes : ['no strategy answered'] };
    }
    return { rows: htmlPostItems(out.body, source.url), notes: out.notes };
  }],
  [WEBFEED_EXTRACT_BODY, async (ctx) => {
    const args = asArgs(ctx.args);
    const out = await extractFromDoc({ db: ctx.db as FeedDb, args, console: ctx.console });
    return webFeedReport(out, args);
  }],
]);

/** Rows {@link seedSrcFeedRows} writes and {@link clearSrcFeedRows} removes. */
export const SRCFEED_ROW_SEEDS: TagSeedRow[] = [
  { ref: 'srcfeed.md', type: 'md', txt: SRCFEED_DOC, tags: ['srcfeed'] },
  { ref: SRCDOM_SINA_REF, type: 'src', txt: SRCDOM_SINA_BODY, tags: ['srcfeed'] },
  { ref: EXTDOM_DSC_REF, type: 'src', txt: EXTSRC_EXTRACT_BODY, tags: ['srcfeed'] },
  { ref: EXTDOM_GE_REF, type: 'src', txt: EXTSRC_EXTRACT_BODY, tags: ['srcfeed'] },
  /* The legacy body an old `extsrc.md` names; `ensure` recreates it when missing. */
  { ref: EXTSRC_EXTRACT_REF, type: 'src', txt: EXTSRC_EXTRACT_BODY, tags: ['extsrc'] },
  { ref: W_FEED_REF, type: 'md', txt: W_FEED_DOC, tags: ['srcfeed'] },
  { ref: 'y.feed.md', type: 'md', txt: Y_FEED_DOC, tags: ['srcfeed'] },
  { ref: 'x.feed.md', type: 'md', txt: X_FEED_DOC, tags: ['srcfeed'] },
];

/** Refs {@link seedSrcFeedRows} writes. */
export const SRCFEED_ROW_REFS = SRCFEED_ROW_SEEDS.map((seed) => seed.ref);

/** What a seed pass wrote and what it left alone. */
export interface SrcFeedSeedResult {
  written: string[];
  /** Refs that already carry a live row, so the user's own version was kept. */
  skipped: string[];
}

/** Whether `row` is one of ours and not tombstoned. */
const isLiveSeed = (row: TagSeedRow): boolean =>
  SRCFEED_ROW_REFS.includes(row.ref) && !(row.tags ?? []).includes('[del]');

/**
 * Write the seeded rows, leaving a ref that already has a live row alone.
 *
 * @param table store to write through, e.g. `db.das`
 * @returns the refs written and the refs skipped
 */
export async function seedSrcFeedRows(table: TagSeedTable): Promise<SrcFeedSeedResult> {
  const existing: TagSeedRow[] = await table.filter(isLiveSeed).toArray();
  const skipped = [...new Set(existing.map((row) => row.ref))];
  const rows = SRCFEED_ROW_SEEDS.filter((seed) => !skipped.includes(seed.ref))
    .map((seed) => ({ ref: seed.ref, type: seed.type, txt: seed.txt, tags: [...seed.tags], rec: {}, modAt: new Date() }));
  if (rows.length > 0) await table.bulkPut(rows);
  return { written: rows.map((row) => row.ref), skipped };
}

/**
 * Tombstone the seeded rows the way the store's own delete does, so the removal
 * syncs instead of leaving a remote copy to resurrect them.
 *
 * @param table store to write through
 * @returns how many rows were tombstoned
 */
export async function clearSrcFeedRows(table: TagSeedTable): Promise<number> {
  const rows: TagSeedRow[] = await table.filter(isLiveSeed).toArray();
  if (rows.length === 0) return 0;
  await table.bulkPut(rows.map((row) => ({
    ...row, tags: [...new Set([...(row.tags ?? []), '[del]'])], modAt: new Date(),
  })));
  return rows.length;
}
