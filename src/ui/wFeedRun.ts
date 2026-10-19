/**
 * wFeedRun.ts — one `w.feed.md` read: the stored config in, the written block out.
 *
 * The schedule and the record live in `w.feed.md` (`src/wFeed.ts`); what is read and
 * how lives in `webfeed.md`. This module is the step between them, and it is the only
 * place that turns a read into a `db.das` write, the way `ui/tagApply.ts` is for tags.
 *
 * The read runs `webfeed/extract.js`'s own body through `runsrc`, so the script a user
 * edits is the script that runs; a store without that row falls back to calling the
 * engine's `extractFromDoc` directly. Neither path persists the rows it returns —
 * `webfeed` leaves that to a caller — and this caller keeps them as text inside
 * `w.feed.md`: a `## Posts as of <stamp>` block of the few newest items, inserted under
 * `## Setup`, with `next` moved to `stamp + freq`.
 *
 * @see docs/webfeed.md for the document, and {@link runWFeedRefresh} for the write.
 */

import { fmtAgo } from '../fc';
import { greet } from '../greet';
import { daEdit, daRead, db, type Da } from '../sdb';
import { runBodyWithPath, SrcUnavailableError } from '../runsrc';
import {
  POST_ITEMS, W_FEED_REF, insertPosts, latestPosts, parsePostItem, parseWFeedDoc,
  postItem, postsBlock, setSetupValue,
} from '../wFeed';
import { extractFromDoc, type FeedDa } from '../webfeed';
import { WEBFEED_EXTRACT_REF, feedDraft } from '../webfeedRows';

/** One item a read found, as the block and the readout list it. */
export interface WFeedItem {
  /** The `webfeed.md` block that answered for it. */
  feed: string;
  text: string;
  ref: string;
}

/** What one read did, whether it wrote or not. */
export interface WFeedRunReport {
  /** The read's own stamp; the block's heading and the base of `next`. */
  at: Date;
  /** Items written into the block, newest first. */
  items: WFeedItem[];
  /** Block names the read asked for. */
  sources: string[];
  /** Reasons the read is short of a full list, as `webfeed` reports them. */
  notes: string[];
  /** Set when the read failed; then nothing was written. */
  error?: string;
}

/** Structural check of one row a script body reported, since that boundary is a script. */
function asFeedRow(value: unknown): FeedDa | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.txt !== 'string' || typeof r.ref !== 'string') return null;
  return {
    txt: r.txt,
    ref: r.ref,
    type: typeof r.type === 'string' ? r.type : 'url',
    tags: Array.isArray(r.tags) ? r.tags.map(String) : undefined,
    dt: r.dt instanceof Date ? r.dt : undefined,
    rec: typeof r.rec === 'object' && r.rec !== null ? r.rec as Record<string, unknown> : {},
  };
}

/** The rows a `webfeed/extract.js` report carried, and nothing else of it. */
function reportRows(out: unknown): FeedDa[] {
  const das = (out as { das?: unknown } | null)?.das;
  if (!Array.isArray(das)) return [];
  return das.map(asFeedRow).filter((r): r is FeedDa => r !== null);
}

/** The block a row came from, as `webfeed` records it. */
const feedOf = (row: FeedDa): string =>
  (typeof row.rec?.feed === 'string' ? row.rec.feed : '');

/** Newest first; a row with no stamp keeps the order its source returned it in. */
const newestFirst = (a: FeedDa, b: FeedDa): number =>
  (b.dt?.getTime() ?? 0) - (a.dt?.getTime() ?? 0);

/**
 * Run one read of the sources a feed document names.
 *
 * The block is written only when the read returns at least one item, so a source that
 * refused every strategy leaves the document — and its due time — as they were.
 *
 * @param opts - the feed document to write (any `*.feed.md`, `w.feed.md` by default),
 *   blocks to read (defaulting to the document's own), the read's stamp, and whether to
 *   push the written row
 * @returns what the read found and what it wrote
 */
export async function runWFeedRefresh(opts: {
  /** Ref of the feed document to read and write; `w.feed.md` when omitted. */
  ref?: string;
  /** Block names; omitted reads what `## Setup`'s `sources:` names, and with neither the
   *  document's whole list. */
  sources?: string[];
  now?: Date;
  push?: (table: typeof db.das) => Promise<unknown>;
} = {}): Promise<WFeedRunReport> {
  const push = opts.push ?? greet;
  const at = opts.now ?? new Date();
  const feedRef = opts.ref ?? W_FEED_REF;
  const row = await daRead(feedRef);
  const md = row?.txt ?? feedDraft(feedRef);
  const doc = parseWFeedDoc(md);
  const sources = opts.sources ?? doc.setup.sources;

  let rows: FeedDa[] = [];
  const notes: string[] = [];
  try {
    const args = sources.length > 0 ? { sources } : {};
    const body = await daRead(WEBFEED_EXTRACT_REF);
    if (body?.txt) {
      const { value: out, path } = await runBodyWithPath(body.txt, { db, ref: body.ref, args, console });
      rows = reportRows(out);
      notes.push(...notesOf(out));
      if (path === 'twin') notes.push('ran the compiled body: this page cannot eval row text');
      else if (path === 'tab') notes.push('ran in a browser tab');
    } else {
      /* No body row: the engine is the same reading without the script, and its own
         report is typed. */
      const out = await extractFromDoc({ db, args });
      rows = out.das;
      notes.push(...out.notes);
    }
  } catch (error) {
    if (error instanceof SrcUnavailableError) notes.push(...error.steps);
    return { at, items: [], sources, notes, error: error instanceof Error ? error.message : String(error) };
  }

  const picked = rows.slice().sort(newestFirst).slice(0, POST_ITEMS);
  const items = picked.map((r) => ({ feed: feedOf(r), text: r.txt, ref: r.ref }));
  /* A document that names no block reads every block `webfeed.md` declares, so the report
     names the ones that answered rather than the empty request. */
  const read = sources.length > 0 ? sources : [...new Set(rows.map(feedOf).filter((n) => n !== ''))];
  if (items.length === 0) {
    return { at, items, sources: read, notes };
  }

  const block = insertPosts(md, postsBlock(at, items.map((i) => postItem(i.feed, i.text, i.ref))));
  const next = doc.setup.freqMs > 0 ? new Date(at.getTime() + doc.setup.freqMs).toISOString() : '';
  const written = setSetupValue(block, 'next', next);
  if (row?.tid !== undefined) await db.das.update(row.tid, daEdit(row, written));
  else await db.das.add({
    ref: feedRef, type: 'md', txt: written, tags: ['webfeed'], rec: {}, modAt: new Date(),
  });
  await push(db.das);
  return { at, items, sources: read, notes };
}

/** The notes a script body's report carried. */
function notesOf(out: unknown): string[] {
  const notes = (out as { notes?: unknown } | null)?.notes;
  return Array.isArray(notes) ? notes.map(String) : [];
}

/** The latest stored items of one parsed document, newest block first. */
export function storedItems(doc: ReturnType<typeof parseWFeedDoc>): WFeedItem[] {
  const block = latestPosts(doc);
  if (!block) return [];
  return block.items
    .map((line) => parsePostItem(line))
    .filter((i): i is NonNullable<typeof i> => i !== null)
    .map((i) => ({ feed: i.source, text: i.text, ref: i.ref }));
}

/**
 * A span of milliseconds as a short forward interval, for a due time that has not come.
 *
 * @param ms - milliseconds until the moment
 * @returns the span, e.g. `3h 20m`, or `now` when it has passed
 */
export function untilText(ms: number): string {
  if (ms <= 0) return 'now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 > 0 ? `${hours}h ${mins % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * The readout of what one read found, as the preview's own line.
 *
 * @param report - the read to describe
 * @param now - the time the line is written at
 * @returns one line naming the item count, the sources, the age and the notes
 */
export function reportLine(report: WFeedRunReport, now: Date = new Date()): string {
  if (report.error) return `read failed: ${report.error}`;
  const where = report.sources.length > 0 ? ` from ${report.sources.join(', ')}` : '';
  const found = `${report.items.length} item(s)${where} · ${fmtAgo(report.at.getTime(), now)}`;
  return report.notes.length > 0 ? `${found} · ${report.notes.join(' · ')}` : found;
}
