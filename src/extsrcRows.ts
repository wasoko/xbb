/**
 * extsrcRows.ts — the `extsrc.md` document and the `type='src'` body that reads a
 * live tab.
 *
 * `webfeed.md` declares feeds a server answers; `extsrc.md` declares sources only a
 * browser tab can answer — a chat history sidebar, a rendered list behind a login.
 * The row `extsrc/extract.js` carries `// @requires tab`, so `runsrc` hands it to the
 * extension's tab runner instead of evaluating it in the page, and its `ctx` holds
 * `args` and `console` but no `db`: it runs in the target page's origin.
 *
 * Nothing here is written automatically: {@link seedExtSrcRows} is the caller's step,
 * and running a row with an inline `args.source` needs no seed at all.
 */

import type { TagSeedRow, TagSeedTable } from './srctagRows';

/** Row ref of the document that declares the sources. */
export const EXTSRC_REF = 'extsrc.md';

/** Row ref of the body that reads one source out of its tab. */
export const EXTSRC_EXTRACT_REF = 'extsrc/extract.js';

/**
 * The seeded document.
 *
 * Two examples, chosen for the two shapes the runner supports: a history sidebar that
 * must be open before the list exists, and a list read from anchors whose text is the
 * conversation title. Selectors are the site's own and will drift; the row is the
 * place to fix them.
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

## Notes

A source is read only when the row runs; this document writes nothing. \`URL\` is the
match pattern \`chrome.tabs.query\` uses. \`Sidebar\` must exist first, or the run stops
and shows \`Prompt\`. \`Item\` selects one history entry; \`Mode: html\` also keeps each
element's outerHTML under \`rec.html\`. \`Scroll\` names a container to exhaust first
when the list is virtualized. \`Max\` caps the rows returned.
`;

/**
 * Body of `extsrc/extract.js`: read one source block out of the tab it runs in.
 *
 * Runs inside the page, so it uses the DOM directly and has no store access. The
 * runner supplies the block as `ctx.args.source`; a missing `Sidebar` returns a
 * `needsUser` report instead of an empty list.
 */
export const EXTSRC_EXTRACT_BODY = `// @requires tab
// @requires user-scripts
const src = ctx.args.source || {};
if (!src.url) throw new Error('extsrc: ctx.args.source.url is missing');

if (src.sidebar && !document.querySelector(src.sidebar)) {
  return { rows: [], notes: [], needsUser: src.prompt || 'open the history sidebar in this tab' };
}

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
const notes = rows.length === 0 && src.item ? ['no element matched ' + src.item] : [];
return { rows: rows, notes: notes };
`;

/** Rows {@link seedExtSrcRows} writes and {@link clearExtSrcRows} removes. */
export const EXTSRC_ROW_SEEDS: TagSeedRow[] = [
  { ref: EXTSRC_REF, type: 'md', txt: EXTSRC_DOC, tags: ['extsrc'] },
  { ref: EXTSRC_EXTRACT_REF, type: 'src', txt: EXTSRC_EXTRACT_BODY, tags: ['extsrc'] },
];

/** Refs {@link seedExtSrcRows} writes. */
export const EXTSRC_ROW_REFS = EXTSRC_ROW_SEEDS.map(s => s.ref);

/** What a seed pass wrote and what it left alone. */
export interface ExtSrcSeedResult {
  written: string[];
  /** Refs that already carry a live row, so the user's own version was kept. */
  skipped: string[];
}

/** Whether `row` is one of ours and not tombstoned. */
const isLiveSeed = (row: TagSeedRow): boolean =>
  EXTSRC_ROW_REFS.includes(row.ref) && !(row.tags ?? []).includes('[del]');

/**
 * Write the seeded rows, leaving a ref that already has a live row alone.
 *
 * @param table store to write through, e.g. `db.das`
 * @returns the refs written and the refs skipped
 */
export async function seedExtSrcRows(table: TagSeedTable): Promise<ExtSrcSeedResult> {
  const existing: TagSeedRow[] = await table.filter(isLiveSeed).toArray();
  const skipped = [...new Set(existing.map(r => r.ref))];
  const rows = EXTSRC_ROW_SEEDS.filter(s => !skipped.includes(s.ref))
    .map(s => ({ ref: s.ref, type: s.type, txt: s.txt, tags: [...s.tags], rec: {}, modAt: new Date() }));
  if (rows.length > 0) await table.bulkPut(rows);
  return { written: rows.map(r => r.ref), skipped };
}

/**
 * Tombstone the seeded rows the way the store's own delete does, so the removal
 * syncs instead of leaving a remote copy to resurrect them.
 *
 * @param table store to write through
 * @returns how many rows were tombstoned
 */
export async function clearExtSrcRows(table: TagSeedTable): Promise<number> {
  const rows: TagSeedRow[] = await table.filter(isLiveSeed).toArray();
  if (rows.length === 0) return 0;
  await table.bulkPut(rows.map(r => ({
    ...r, tags: [...new Set([...(r.tags ?? []), '[del]'])], modAt: new Date(),
  })));
  return rows.length;
}
