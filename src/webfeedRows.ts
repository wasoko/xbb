/**
 * webfeedRows.ts — the `webfeed.md` document and the `type='src'` body that
 * drives `webfeed`'s extraction.
 *
 * The engine lives apart, in `src/webfeed.ts`, and imports nothing from the app.
 * This module holds the texts a caller seeds and the helper that writes them:
 *
 *   `webfeed.md`        the sources to read and the fallback budget
 *   `webfeed/extract.js` a body that reads the document out of `ctx.db` and
 *                        returns a report beside the rows it extracted
 *   `w.feed.md`         one feed's own `## Setup` (freq, next, sources) and the
 *                        `## Posts as of …` blocks a read writes into it
 *
 * A `data:`-URL module has no base URL, so the body cannot import the engine: it
 * calls `globalThis.webfeed`, which `src/ui/routes.tsx` installs at boot — the
 * same route `srctag`'s rows take to `globalThis.srctag`.
 *
 * Nothing here is written automatically: {@link seedWebfeedRows} is the caller's
 * step, and it keeps any live row the user already has.
 */

import { W_FEED_REF } from './wFeed';
import { WEBFEED_REF } from './webfeed';
import type { TagSeedRow, TagSeedTable } from './srctagRows';

/** Row ref of the body that drives an extraction from the document. */
export const WEBFEED_EXTRACT_REF = 'webfeed/extract.js';

/**
 * The seeded document.
 *
 * The four blocks are the examples the extraction was measured on: a site whose
 * JSON API answers without a session, an aggregator page only a rendering proxy
 * can read, and two sites that refuse every session-less strategy — which is
 * what `test/webfeed.test.ts`'s findings table reports, source by source. The
 * `sina.cn` block reads the posts its own document carries, whatever media id
 * the URL names; the proxy is asked for that document's HTML because the
 * proxy's Markdown drops the markup the posts are read from.
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
* Limit: 30
`;

/**
 * Body of `webfeed/extract.js`: extract every source the document declares and
 * return a report.
 *
 * Self-contained by necessity — a `data:`-URL body resolves no import — so the
 * only thing it calls is the global engine. `ctx.args` is forwarded whole, which
 * is what lets `{ sources: ['wallstreetcn'], limit: 5 }` narrow a run without a
 * reseed. Rows come back with `tid` unset: a `run_src` call reads the feed, it
 * does not persist anything.
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
  notes: out.notes,
  das: out.das.slice(0, Number(args.showRows) || 10),
};`;

/**
 * The seeded feed schedule: one feed's own settings and the blocks its reads write.
 *
 * It is seeded empty — no read has happened, so there is no `## Posts as of` block —
 * with a two-hour schedule and no named source, so it follows every block `webfeed.md`
 * declares. The sources are not repeated here: they are `webfeed.md`'s, which is what
 * `sources:` names, and what keeps one URL or API in one place. A read moves `next:` and
 * puts its block under `Setup`, directly above `Notes`.
 */
export const W_FEED_DOC = `# w.feed

## Setup
freq: 2hr
next:
sources:

## Notes

What lives here is the schedule and what was read; the sources themselves are
\`webfeed.md\`'s. \`sources:\` names which of its blocks this feed reads — left empty
it reads every block it declares, so the draft follows whatever \`webfeed.md\` holds
and one place keeps every URL, API and tag. Every read inserts one
\`## Posts as of <stamp>\` block under \`Setup\`, newest first, and moves \`next\` to
its own stamp plus \`freq\`.

A read runs when \`next\` has passed and the feed is looked at, or from the refresh
button a pin card's \`{w.feed.md}\` token shows on hover.
`;
/**
 * The text a feed document opens with while its ref has no row yet.
 *
 * Any `*.feed.md` ref is a feed of this dialect, so the title follows the ref and
 * everything under it is the seeded example — a two-hour schedule, and no named source,
 * which means every block `webfeed.md` declares. Nothing is written: the text lands in
 * the editor's buffer, and the row exists once the user saves it (or once a read writes
 * the first block).
 *
 * @param ref - the ref the document will take, e.g. `my.feed.md`
 * @returns the document to open the ref with
 */
export const feedDraft = (ref: string): string =>
  W_FEED_DOC.replace(/^# .*$/m, () => `# ${ref.replace(/\.md$/i, '')}`);

/** Rows {@link seedWebfeedRows} writes and {@link clearWebfeedRows} removes. */
export const WEBFEED_ROW_SEEDS: TagSeedRow[] = [
  { ref: WEBFEED_REF, type: 'md', txt: WEBFEED_DOC, tags: ['webfeed'] },
  { ref: WEBFEED_EXTRACT_REF, type: 'src', txt: WEBFEED_EXTRACT_BODY, tags: ['webfeed'] },
  { ref: W_FEED_REF, type: 'md', txt: W_FEED_DOC, tags: ['webfeed'] },
];

/** Refs {@link seedWebfeedRows} writes. */
export const WEBFEED_ROW_REFS = WEBFEED_ROW_SEEDS.map((s) => s.ref);

/** What a seed pass wrote and what it left alone. */
export interface WebfeedSeedResult {
  written: string[];
  /** Refs that already carry a live row, so the user's own version was kept. */
  skipped: string[];
}

/** Whether `row` is one of ours and not tombstoned. */
const isLiveSeed = (row: TagSeedRow): boolean =>
  WEBFEED_ROW_REFS.includes(row.ref) && !(row.tags ?? []).includes('[del]');

/**
 * Write the seeded rows, leaving a ref that already has a live row alone.
 *
 * @param table store to write through, e.g. `db.das`
 * @returns the refs written and the refs skipped
 */
export async function seedWebfeedRows(table: TagSeedTable): Promise<WebfeedSeedResult> {
  const existing: TagSeedRow[] = await table.filter(isLiveSeed).toArray();
  const skipped = [...new Set(existing.map((r) => r.ref))];
  const rows = WEBFEED_ROW_SEEDS.filter((s) => !skipped.includes(s.ref))
    .map((s) => ({ ref: s.ref, type: s.type, txt: s.txt, tags: [...s.tags], rec: {}, modAt: new Date() }));
  if (rows.length > 0) await table.bulkPut(rows);
  return { written: rows.map((r) => r.ref), skipped };
}

/**
 * Tombstone the seeded rows the way the store's own delete does, so the removal
 * syncs instead of leaving a remote copy to resurrect them.
 *
 * @param table store to write through
 * @returns how many rows were tombstoned
 */
export async function clearWebfeedRows(table: TagSeedTable): Promise<number> {
  const rows: TagSeedRow[] = await table.filter(isLiveSeed).toArray();
  if (rows.length === 0) return 0;
  await table.bulkPut(rows.map((r) => ({
    ...r, tags: [...new Set([...(r.tags ?? []), '[del]'])], modAt: new Date(),
  })));
  return rows.length;
}
