/**
 * srcfeed.ts — one feed engine over one source registry.
 *
 * `srcfeed.md` declares every source once: its page, the row that reads it, and the
 * tags its rows carry. A feed document — any `*.feed.md` — names entries from that
 * registry and keeps only its own schedule and the blocks its reads wrote:
 *
 *   ## Setup
 *   freq: 2hr
 *   next:
 *   sources: wallstreetcn, sina
 *
 * One entry is read on one of three paths:
 *
 * | entry | how | where |
 * |---|---|---|
 * | `* Src: srcdom/x` | the row's own body | this page, or its compiled twin |
 * | `* Src: extdom/x`, `@requires tab` | the row's own body | the matching tab |
 * | no `* Src:` | the built-in web walk | api, page, mobile mirror, proxy |
 *
 * A `Src:` row does the whole read for its site and returns `{ rows, notes }`; it is
 * handed its registry entry as `ctx.args.source`. This module normalizes what it
 * returns: the entry name in `rec.feed`, the path in `rec.strategy`, a stamp, and the
 * entry's tags.
 *
 * Each source is trimmed at the oldest post the last read stored for it, matched by
 * the post's URL when it carries one — an item's text carries counts that tick
 * between reads — and every row the document already holds is dropped after that.
 * A list that keeps a pinned head at its top leaves the anchor near its own top, so
 * the trim alone would stop at the pins on every read; the second step removes what
 * sits above them. Nothing here imports Dexie or React: the write goes through
 * {@link SrcFeedStore}, so a test passes its own port and the app passes
 * `srcfeedStore.ts`.
 *
 * `srcfeed.ts` also publishes the reader helpers a `srcdom` row calls as
 * `globalThis.srcfeed` ({@link installSrcFeedGlobal}); a `data:`-URL body can import
 * nothing from this bundle.
 *
 * @see docs/srcfeed.md for the documents and the paths.
 */

import { fmtAgo } from './fc';
import { bulletKv, splitSections, subSections } from './recrMd';
import { needsTab, rowMeta } from './rowMeta';
import { runBodyWithPath, SrcUnavailableError, type BodyPath } from './runsrc';
import type { Da } from './sdb';
import {
  DEFAULT_FALLBACK, WEBFEED_REF, blockedText, capTxt, extractFromDoc, extractSource,
  fetchWithBackoff, htmlPostItems, jsonFeedItems, markdownFeedItems, parseFeedPayload,
  parseWebfeedDoc, planFeedRows, planStrategies, stripActionLine,
  type BackoffConfig, type FeedAttempt, type FeedDa, type FeedFallback,
  type FeedSource, type FeedStrategy,
} from './srcfeedWeb';

/** Row ref holding the feed's own schedule and its latest items. */
export const W_FEED_REF = 'w.feed.md';

/** Suffix every feed document's ref ends in; the dialect belongs to the suffix, not to one name. */
export const FEED_REF_SUFFIX = '.feed.md';

/**
 * Whether a ref names a feed document of this dialect.
 *
 * @param ref - a row ref, e.g. `w.feed.md`
 * @returns true for any `*.feed.md`
 */
export const isFeedRef = (ref: string): boolean => ref.toLowerCase().endsWith(FEED_REF_SUFFIX);

/** `## <name>` that opens a section. */
const HEADER_RX = /^##\s+(.+?)\s*$/;
/** `- item` line a posts block keeps. */
const ITEM_RX = /^\s*-\s+(.+?)\s*$/;
/** `key: value` line of `## Setup`. */
const KEY_RX = /^\s*([A-Za-z][\w -]*):\s*(.*)$/;
/** A stamp a `next:` line or a `Posts as of …` heading may carry. */
const STAMP_RX = /(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?)/;
/** `<number><unit>` a `freq:` line may carry. */
const FREQ_RX = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|min|mins|m|hr|hrs|hour|hours|h|d|day|days)\s*$/i;

/** Milliseconds one unit of {@link FREQ_RX} covers. */
const FREQ_UNIT: Record<string, number> = {
  ms: 1, s: 1000, sec: 1000, secs: 1000, min: 60_000, mins: 60_000, m: 60_000,
  hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000, h: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
};

/** The `## Setup` section, as the readout and the next read use it. */
export interface WFeedSetup {
  /** `freq:` in milliseconds; 0 when the document names none. */
  freqMs: number;
  /** `freq:` as written, for the readout; '' when the document names none. */
  freqText: string;
  /** `next:` as a date, when the line carries a stamp. */
  nextAt: Date | null;
  /** `next:` as written, for the readout; '' when the document names none. */
  nextText: string;
  /** `sources:` entry names of `srcfeed.md`; empty means every entry without a `Src:` row. */
  sources: string[];
  /** Every other `key: value` line, keyed by its lowercased key. */
  values: Record<string, string>;
  /** The section's other lines, in order. */
  lines: string[];
}

/** One `## Posts as of …` block: one read's new items. */
export interface WFeedPost {
  /** The heading as written, `as of …` included. */
  heading: string;
  /** The stamp the heading names, when it carries one. */
  asOf: Date | null;
  /** The block's `- item` lines as written. */
  items: string[];
}

/** A parsed feed document. */
export interface WFeedDoc {
  /** The document's own head, before the first `##` section. */
  head: string;
  setup: WFeedSetup;
  /** The posts blocks in document order, newest first as a read writes them. */
  posts: WFeedPost[];
}

/** One `##` section: its heading and the lines under it, heading excluded. */
interface FeedSection {
  name: string;
  body: string[];
  /** Line index of the heading, for a rewrite that must keep the document's order. */
  at: number;
}

/**
 * Milliseconds a `freq:` value names.
 *
 * @param text - the value as written, e.g. `4hr`
 * @returns the span in milliseconds, or 0 when the text names no duration
 */
export function parseFreq(text: string): number {
  const m = text.trim().match(FREQ_RX);
  if (!m) return 0;
  return Number(m[1]) * (FREQ_UNIT[m[2].toLowerCase()] ?? 0);
}

/**
 * The stamp a line or heading carries, when it carries one.
 *
 * A bare date is accepted, so a hand-written `## Posts as of 2026-10-16` still reads
 * as a read time; anything without a year is not a stamp, which keeps `freq: 4hr` and
 * prose out of the parse.
 *
 * @param text - the text to read a stamp out of
 * @returns the stamp, or null when the text carries none
 */
export function parseStamp(text: string): Date | null {
  const m = text.match(STAMP_RX);
  if (!m) return null;
  const at = new Date(m[1].replace(' ', 'T'));
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Split a document into its head and its `##` sections, keeping each heading's line index. */
function splitFeedSections(md: string): { head: string; sections: FeedSection[] } {
  const lines = md.replace(/\s+$/, '').split('\n');
  const sections: FeedSection[] = [];
  let open: FeedSection | undefined;
  const head: string[] = [];
  lines.forEach((line, at) => {
    const m = line.match(HEADER_RX);
    if (!m) {
      (open ? open.body : head).push(line);
      return;
    }
    open = { name: m[1], body: [], at };
    sections.push(open);
  });
  return { head: head.join('\n').trim(), sections };
}

/** The `## Setup` section, with the keys this module acts on read out of it. */
function parseSetup(body: string[]): WFeedSetup {
  const setup: WFeedSetup = {
    freqMs: 0, freqText: '', nextAt: null, nextText: '', sources: [], values: {}, lines: [],
  };
  for (const line of body) {
    const m = line.match(KEY_RX);
    if (!m) {
      if (line.trim() !== '') setup.lines.push(line);
      continue;
    }
    const key = m[1].trim().toLowerCase();
    const value = m[2].trim();
    if (key === 'freq') {
      setup.freqText = value;
      setup.freqMs = parseFreq(value);
      continue;
    }
    if (key === 'next') {
      setup.nextText = value;
      setup.nextAt = parseStamp(value);
      continue;
    }
    if (key === 'sources' || key === 'source') {
      setup.sources = value.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s !== '');
      continue;
    }
    setup.values[key] = value;
  }
  return setup;
}

/**
 * Read a feed document.
 *
 * @param md - the document text
 * @returns its head, its `## Setup` values, and its posts blocks in written order
 */
export function parseWFeedDoc(md: string): WFeedDoc {
  const { head, sections } = splitFeedSections(md);
  const setupSection = sections.find((s) => s.name.toLowerCase() === 'setup');
  const posts = sections
    .filter((s) => /^posts\b/i.test(s.name))
    .map((s) => ({
      heading: s.name,
      asOf: parseStamp(s.name.replace(/^posts\b/i, '')),
      items: s.body.map((l) => l.trim()).filter((l) => ITEM_RX.test(l)),
    }));
  return { head, setup: parseSetup(setupSection?.body ?? []), posts };
}

/**
 * The newest posts block: the last one by its own stamp, and the last written when no
 * block names a stamp.
 *
 * @param doc - a parsed document
 * @returns the block whose items are the latest read's, or undefined when there are none
 */
export function latestPosts(doc: WFeedDoc): WFeedPost | undefined {
  let best: WFeedPost | undefined;
  for (const post of doc.posts) {
    if (!best) { best = post; continue; }
    if (post.asOf && (!best.asOf || post.asOf.getTime() >= best.asOf.getTime())) best = post;
  }
  return best;
}

/**
 * When the next read is due.
 *
 * `next:` as written wins; a document that names only a `freq:` derives it from the
 * newest posts block, which is the read the span is counted from.
 *
 * @param doc - a parsed document
 * @returns the due time, or null when neither line gives one
 */
export function nextRefreshAt(doc: WFeedDoc): Date | null {
  if (doc.setup.nextAt) return doc.setup.nextAt;
  const last = latestPosts(doc)?.asOf;
  if (!last || doc.setup.freqMs <= 0) return null;
  return new Date(last.getTime() + doc.setup.freqMs);
}

/**
 * Whether the document's next read has come.
 *
 * @param doc - a parsed document
 * @param now - the time to compare against
 * @returns true when a due time is known and has passed
 */
export function dueForRefresh(doc: WFeedDoc, now: Date): boolean {
  const at = nextRefreshAt(doc);
  return at !== null && now.getTime() >= at.getTime();
}

/**
 * One item line, as the readout lists it.
 *
 * @param source - the entry the item came from
 * @param text - the item's own text
 * @param ref - the item's URL
 * @returns the `- **source** text — ref` line a posts block holds
 */
export function postItem(source: string, text: string, ref: string): string {
  const label = text.trim() === '' ? ref : text.trim();
  const from = source.trim() === '' ? '' : `**${source.trim()}** `;
  return `- ${from}${label}${ref.trim() === '' ? '' : ` — ${ref.trim()}`}`;
}

/**
 * The fields of one item line.
 *
 * @param line - an `- item` line of a posts block, as written
 * @returns its source, text and ref; the source and ref are '' when the line carries none
 */
export function parsePostItem(line: string): { source: string; text: string; ref: string } | null {
  const item = line.match(ITEM_RX);
  if (!item) return null;
  const body = item[1];
  const source = body.match(/^\*\*([^*]+)\*\*\s+/);
  let rest = source ? body.slice(source[0].length) : body;
  const dash = rest.lastIndexOf(' — ');
  let ref = '';
  if (dash > 0) {
    ref = rest.slice(dash + 3).trim();
    rest = rest.slice(0, dash);
  }
  return { source: source ? source[1].trim() : '', text: rest.trim(), ref };
}

/** A `## Posts as of <stamp>` section, as a read writes it. */
export function postsBlock(asOf: Date, items: string[]): string {
  return [`## Posts as of ${asOf.toISOString()}`, '', ...items].join('\n') + '\n';
}

/** Join blocks of lines with exactly one blank line between them, and one trailing newline. */
function joinBlocks(parts: string[][]): string {
  return parts
    .map((p) => p.join('\n').replace(/\s+$/, ''))
    .filter((p) => p.trim() !== '')
    .join('\n\n') + '\n';
}

/**
 * Put a posts block where a read belongs.
 *
 * The block opens the document's posts, so it is inserted before the first `##` header
 * that follows `## Setup` — which puts the newest read directly under the settings and
 * pushes the older ones down. A document with nothing after `Setup` takes the block at
 * its end instead.
 *
 * @param md - the document text
 * @param block - the block to insert, e.g. from {@link postsBlock}
 * @returns the document with the block in it
 */
export function insertPosts(md: string, block: string): string {
  const lines = md.replace(/\s+$/, '').split('\n');
  const { sections } = splitFeedSections(md);
  const setup = sections.find((s) => s.name.toLowerCase() === 'setup');
  const next = sections.find((s) => s.at > (setup?.at ?? -1));
  const at = next && setup ? next.at : lines.length;
  return joinBlocks([lines.slice(0, at), block.split('\n'), lines.slice(at)]);
}

/**
 * Rewrite one `## Setup` line, adding it when the section does not carry it.
 *
 * @param md - the document text
 * @param key - the key to write, e.g. `next`
 * @param value - the value to write
 * @returns the document with the key set
 */
export function setSetupValue(md: string, key: string, value: string): string {
  const lines = md.replace(/\s+$/, '').split('\n');
  const { sections } = splitFeedSections(md);
  const setup = sections.find((s) => s.name.toLowerCase() === 'setup');
  if (!setup) return joinBlocks([[`## Setup`, `${key}: ${value}`], lines]);
  const end = sections.find((s) => s.at > setup.at)?.at ?? lines.length;
  const line = `${key}: ${value}`;
  const held = lines.findIndex((l, i) => i > setup.at && i < end
    && l.match(KEY_RX)?.[1].trim().toLowerCase() === key.toLowerCase());
  if (held > 0) lines[held] = line;
  else lines.splice(setup.at + 1, 0, line);
  return joinBlocks([lines]);
}

/**
 * The text a feed document opens with while its ref has no row yet.
 *
 * Any `*.feed.md` ref is a feed of this dialect, so the title follows the ref and
 * everything under it is the seeded example — a two-hour schedule, and no named source,
 * which means every `srcfeed.md` entry that declares no `Src:` row. Nothing is written:
 * the text lands in the editor's buffer, and the row exists once the user saves it (or
 * once a read writes the first block).
 */
export const W_FEED_DOC = `# w.feed

## Setup
freq: 2hr
next:
sources:

## Notes

What lives here is the schedule and what was read; the sources themselves are
\`srcfeed.md\`'s. \`sources:\` names which of its entries this feed reads — left empty
it reads every entry without a \`Src:\` row, so the draft follows whatever
\`srcfeed.md\` holds and one place keeps every URL, adapter and tag. Every read
inserts one \`## Posts as of <stamp>\` block under \`Setup\`, newest first, and moves
\`next\` to its own stamp plus \`freq\`.

A read runs when \`next\` has passed and the feed is looked at, or from the refresh
button a pin card's \`{w.feed.md}\` token shows on hover.
`;

/**
 * The text a feed document opens with while its ref has no row yet.
 *
 * @param ref - the ref the document will take, e.g. `my.feed.md`
 * @returns the document to open the ref with
 */
export const feedDraft = (ref: string): string =>
  W_FEED_DOC.replace(/^# .*$/m, () => `# ${ref.replace(/\.md$/i, '')}`);

/** Row ref holding the one source registry. */
export const SRCFEED_REF = 'srcfeed.md';

/** Row ref of the legacy `extsrc.md` document. */
export const EXTSRC_REF = 'extsrc.md';

/** Row ref of the body the legacy `extsrc.md` entries run. */
export const EXTSRC_EXTRACT_REF = 'extsrc/extract.js';

/** One `### name` entry of the registry. */
export interface SrcFeedEntry extends FeedSource {
  /** `* Src:` row ref that reads this source end to end; '' uses the built-in web walk. */
  src: string;
  /** `* Match:` tab pattern, when the adapter's row needs one of its own. */
  match: string;
  /** `* Prompt:` manual step the page needs before it can be read. */
  prompt: string;
  /** `* Item:` selector of one history entry, for a tab adapter. */
  item: string;
  /**
   * `* Sidebar:` selector that says the page needs a manual step; the tab body
   * consults it only when `Item:` matched nothing.
   */
  sidebar: string;
  /** `* Scroll:` container to exhaust before reading, when the list is virtualized. */
  scroll: string;
  /**
   * `* Tabs:` — `all` reads every open tab the entry's `URL:` matches and merges
   * their rows; any other value reads the first match. A site that keeps one tab
   * per login (Gemini's `/u/1` … `/u/9`) holds a disjoint list in each.
   */
  tabs: string;
  /** `* Mode:` `dom` reads text and href; `html` also keeps each element's outerHTML. */
  mode: 'dom' | 'html';
  /** `* Max:` cap on the rows this source returns. */
  max: number;
}

/** The registry and the retry budget the built-in walk uses. */
export interface SrcFeedRegistry {
  entries: SrcFeedEntry[];
  fallback: FeedFallback;
  /** True when the entries came from `webfeed.md` / `extsrc.md` rather than `srcfeed.md`. */
  legacy: boolean;
}

/** The fields a `* Src:`-less registry entry leaves unset. */
const ENTRY_DEFAULTS = {
  src: '', match: '', prompt: '', item: '', sidebar: '', scroll: '', tabs: '',
  mode: 'dom' as const, max: 200,
};

/**
 * The registry entries a `## Sources` section declares, keyed by `### name`.
 *
 * @param md the document text
 * @returns the extra fields per block; blocks without one carry no entry
 */
function entryExtras(md: string): Map<string, Partial<SrcFeedEntry>> {
  const out = new Map<string, Partial<SrcFeedEntry>>();
  const sources = [...splitSections(md)].find(([name]) => name.toLowerCase() === 'sources')?.[1];
  if (sources === undefined) return out;
  for (const [name, block] of subSections(sources)) {
    const kv = bulletKv(block);
    out.set(name, {
      src: kv.src ?? '',
      match: kv.match ?? '',
      prompt: kv.prompt ?? '',
      item: kv.item ?? '',
      sidebar: kv.sidebar ?? '',
      scroll: kv.scroll ?? '',
      tabs: kv.tabs ?? '',
      mode: kv.mode === 'html' ? 'html' : 'dom',
      max: Math.max(1, Number(kv.max) || 200),
    });
  }
  return out;
}

/**
 * Read a `srcfeed.md`.
 *
 * The dialect is `webfeed.md`'s: `## Sources`, one `### name` block per source, and
 * `* Key: value` bullets, with `- value` lists under `* API:`, `* Proxy Headers:` and
 * `* Tags:`. An entry without `* URL:` is skipped, as it names nothing to read.
 *
 * @param md the document text
 * @returns the entries in written order and the `## Fallback` settings
 */
export function parseSrcFeedDoc(md: string): SrcFeedRegistry {
  const { sources, fallback } = parseWebfeedDoc(md);
  const extras = entryExtras(md);
  return {
    legacy: false,
    fallback,
    entries: sources.map((source) => ({
      ...ENTRY_DEFAULTS, ...source, ...extras.get(source.name),
    })),
  };
}

/**
 * Read a legacy `extsrc.md` as registry entries.
 *
 * The dialect is `webfeed.md`'s: `## Sources`, one `### name` block, and
 * `* Key: value` bullets. Every entry runs the seeded tab body, so its `Src:` is
 * {@link EXTSRC_EXTRACT_REF}.
 *
 * @param md the document text
 * @returns the entries in written order
 */
export function parseExtSrcDoc(md: string): SrcFeedEntry[] {
  const sources = [...splitSections(md)].find(([name]) => name.toLowerCase() === 'sources')?.[1];
  if (sources === undefined) return [];
  const out: SrcFeedEntry[] = [];
  for (const [name, block] of subSections(sources)) {
    const kv = bulletKv(block);
    if (!kv.url) continue;
    out.push({
      ...ENTRY_DEFAULTS,
      name,
      url: kv.url,
      type: 'url',
      apis: [],
      session: '',
      mobile: '',
      proxy: '',
      proxyHeaders: {},
      tags: (kv.tags ?? '').split(/[\s,]+/).filter(Boolean),
      src: EXTSRC_EXTRACT_REF,
      match: kv.url,
      prompt: kv.prompt ?? '',
      item: kv.item ?? '',
      sidebar: kv.sidebar ?? '',
      scroll: kv.scroll ?? '',
      tabs: kv.tabs ?? '',
      mode: kv.mode === 'html' ? 'html' : 'dom',
      max: Math.max(1, Number(kv.max) || 200),
    });
  }
  return out;
}

/**
 * The registry an installation that has no `srcfeed.md` yet effectively holds:
 * every `webfeed.md` block, then every `extsrc.md` block as an `extsrc/extract.js`
 * source.
 *
 * The adapter is read-only and never writes; it keeps a user's existing documents
 * working until they seed `srcfeed.md`.
 *
 * @param webfeedMd the `webfeed.md` text, or ''
 * @param extsrcMd the `extsrc.md` text, or ''
 * @returns the adapted entries and the fallback budget
 */
export function legacySrcRegistry(webfeedMd: string, extsrcMd: string): SrcFeedRegistry {
  const web = parseWebfeedDoc(webfeedMd);
  const entries: SrcFeedEntry[] = web.sources.map((source) => ({
    ...ENTRY_DEFAULTS, ...source,
  }));
  for (const source of parseExtSrcDoc(extsrcMd)) {
    if (entries.some((entry) => entry.name === source.name)) continue;
    entries.push(source);
  }
  return { legacy: true, fallback: web.fallback, entries };
}

/** The store a read reads and writes through. */
export interface SrcFeedStore {
  /** The winning live row for `ref`, or undefined when there is none. */
  read(ref: string, type?: string): Promise<Da | undefined>;
  /** Replace the document's text, creating `ref` as a `md` row when `row` is undefined. */
  save(row: Da | undefined, ref: string, txt: string): Promise<void>;
  /** Push the rows a read wrote, e.g. `greet(db.das)` in the app. */
  push(): Promise<unknown>;
  /**
   * Create a missing row from the seed catalogue and return it, when the host has one.
   * Called for a `Src:` ref that has no row, so deleting a seeded adapter heals on the
   * next read instead of failing the source.
   */
  ensure?(ref: string): Promise<Da | undefined>;
  /** Tables a `Src:` body receives as `ctx.db`; a host without a store passes none. */
  db?: unknown;
}

/**
 * The registry a store holds: `srcfeed.md` when it has one, else the legacy
 * `webfeed.md` + `extsrc.md` adapter.
 *
 * @param store the caller's port
 * @returns the registry and the fallback budget
 */
export async function loadSrcRegistry(store: SrcFeedStore): Promise<SrcFeedRegistry> {
  const own = await store.read(SRCFEED_REF, 'md');
  if (own?.txt) return parseSrcFeedDoc(own.txt);
  const web = await store.read(WEBFEED_REF, 'md');
  const ext = await store.read(EXTSRC_REF, 'md');
  return legacySrcRegistry(web?.txt ?? '', ext?.txt ?? '');
}

/** `raw` as a feed source, filling the arrays and strings a caller may leave out. */
export function feedSourceOf(raw: unknown): FeedSource {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const headers = r.proxyHeaders;
  return {
    name: String(r.name ?? ''),
    url: String(r.url ?? ''),
    type: String(r.type ?? 'url'),
    apis: list(r.apis),
    session: String(r.session ?? ''),
    mobile: String(r.mobile ?? ''),
    proxy: String(r.proxy ?? ''),
    proxyHeaders: typeof headers === 'object' && headers !== null
      ? headers as Record<string, string> : {},
    tags: list(r.tags),
  };
}

// ─── Reading one source without parsing it (a `srcdom` row's helper) ────────

/** The body that answered a source, and every attempt that led there. */
export interface SrcRead {
  /** The response body; '' when no strategy answered. */
  body: string;
  /** The URL that answered. */
  url: string;
  /** The strategy that answered; null when every one under it failed. */
  strategy: FeedStrategy | null;
  attempts: FeedAttempt[];
  /** One line per reason the body was not the first request's answer. */
  notes: string[];
}

/**
 * Walk a source's strategies and return the first body one of them answered with.
 *
 * This is the half of {@link extractSource} a site adapter needs: it parses the body
 * itself, because only the site knows which of the payload readers applies. A row
 * holds no session, so a `* Session:` source skips that strategy.
 *
 * @param source the entry, inline block or registry row to read
 * @param fallback retry budget and proxy root
 * @param opts the `fetch`/`sleep` seams and retry overrides
 * @returns the body and the attempts; `strategy` is null when nothing answered
 */
export async function readSource(
  source: FeedSource | Record<string, unknown>,
  fallback: FeedFallback = DEFAULT_FALLBACK,
  opts: BackoffConfig = {},
): Promise<SrcRead> {
  const src = feedSourceOf(source);
  const attempts: FeedAttempt[] = [];
  const notes: string[] = [];
  for (const step of planStrategies(src, fallback, false)) {
    const headers = step.headers === undefined ? opts.headers : { ...opts.headers, ...step.headers };
    const out = await fetchWithBackoff(step.url, src.name, step.strategy, { ...opts, headers });
    attempts.push(...out.attempts);
    if (!out.ok) {
      notes.push(`${step.strategy}: ${out.error}`);
      continue;
    }
    return { body: out.text, url: step.url, strategy: step.strategy, attempts, notes };
  }
  return { body: '', url: src.url, strategy: null, attempts, notes };
}

// ─── Reading one entry for a feed ──────────────────────────────────────────

/** One item a read found, as the block and the readout list it. */
export interface SrcFeedItem {
  /** Registry entry name the item came from. */
  feed: string;
  text: string;
  ref: string;
}

/** What one read did, whether it wrote or not. */
export interface SrcFeedReport {
  /** The read's own stamp; the block's heading and the base of `next`. */
  at: Date;
  /** Items written into the block, newest first. */
  items: SrcFeedItem[];
  /** Entry names the read asked for. */
  sources: string[];
  /** Entries that answered, whether or not they yielded a new item. */
  answered: string[];
  /** Per-source reasons the read is short of a full list. */
  notes: string[];
  /** Where a `Src:` row ran, when it did not run in this page by eval. */
  pathNote?: string;
  /** Set when the read failed; then nothing was written. */
  error?: string;
}

/** One source's contribution to a read. */
interface EntryRead {
  name: string;
  rows: FeedDa[];
  answered: boolean;
  notes: string[];
  path?: BodyPath;
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

/** The rows a `Src:` body reported under `rows` (a tab body) or `das` (a feed body). */
function reportedRows(out: unknown): FeedDa[] {
  const report = out as { rows?: unknown; das?: unknown } | null;
  const list = Array.isArray(report?.rows) ? report.rows
    : Array.isArray(report?.das) ? report.das : [];
  return list.map(asFeedRow).filter((row): row is FeedDa => row !== null);
}

/** An entry as the inline source block a `Src:` row receives. */
const sourceBlock = (entry: SrcFeedEntry): Record<string, unknown> => ({ ...entry });

/** The notes a `Src:` body reported, with a manual step moved to the front. */
function reportNotes(out: unknown, name: string): string[] {
  const report = out as { notes?: unknown; needsUser?: unknown } | null;
  const notes = Array.isArray(report?.notes) ? report.notes.map(String) : [];
  const needsUser = report?.needsUser;
  if (typeof needsUser === 'string' && needsUser) notes.unshift(`${name}: ${needsUser}`);
  return notes;
}

/** Whether a `Src:` body reports a manual step instead of a list. */
function needsUserOf(out: unknown): boolean {
  const needsUser = (out as { needsUser?: unknown } | null)?.needsUser;
  return typeof needsUser === 'string' && needsUser !== '';
}

/**
 * Normalize the rows a `Src:` body reported: cap the text, dedupe by ref, carry the
 * entry's tags, and record the entry name and path in `rec`.
 *
 * @param rows rows as the body reported them
 * @param entry the registry entry they belong to
 * @param how the path that ran: `src` or `tab`
 * @param at the read's stamp, for a row that names no date
 * @returns the rows a feed block can list
 */
function srcRows(rows: FeedDa[], entry: SrcFeedEntry, how: string, at: Date): FeedDa[] {
  const seen = new Set<string>();
  const out: FeedDa[] = [];
  for (const row of rows) {
    const txt = capTxt(row.txt);
    if (txt === '' || seen.has(row.ref)) continue;
    seen.add(row.ref);
    out.push({
      txt,
      ref: row.ref,
      type: entry.type || row.type || 'url',
      tags: [...new Set([...entry.tags, ...(row.tags ?? [])])],
      dt: row.dt ?? at,
      rec: { ...(row.rec ?? {}), feed: entry.name, strategy: how, src: entry.url, fetchedAt: at.toISOString() },
    });
  }
  return out;
}

/**
 * Read one entry, whichever path it names.
 *
 * @param entry the registry entry
 * @param ctx the store, the fallback budget, the read's stamp, and the log sink
 * @returns the rows, whether the entry answered, and the reasons it did not
 */
async function readEntry(
  entry: SrcFeedEntry,
  ctx: { store: SrcFeedStore; fallback: FeedFallback; at: Date; log: Console },
): Promise<EntryRead> {
  if (entry.src === '') {
    const res = await extractSource(entry, ctx.fallback, {
      /* The feed's own last post is the boundary, not rows another caller committed
         to `db.das`, and a document `* Limit:` must not cap a feed read. */
      existing: [],
      limit: 0,
      stopAtKnown: false,
      now: ctx.at,
    });
    return {
      name: entry.name,
      rows: res.das,
      answered: res.strategy !== null,
      notes: res.notes.map((note) => `${entry.name}: ${note}`),
    };
  }

  const stored = await ctx.store.read(entry.src, 'src');
  const row = stored?.txt === undefined ? await ctx.store.ensure?.(entry.src) : stored;
  if (row?.txt === undefined) {
    return { name: entry.name, rows: [], answered: false, notes: [`${entry.name}: no row ${entry.src}`] };
  }
  const how = needsTab(rowMeta(row.txt)) ? 'tab' : 'src';
  try {
    const { value, path } = await runBodyWithPath(row.txt, {
      db: ctx.store.db,
      ref: entry.src,
      args: { source: sourceBlock(entry), fallback: ctx.fallback },
      console: ctx.log,
    });
    return {
      name: entry.name,
      rows: srcRows(reportedRows(value), entry, how, ctx.at),
      answered: !needsUserOf(value),
      notes: reportNotes(value, entry.name),
      path,
    };
  } catch (e) {
    const notes = e instanceof SrcUnavailableError
      ? [`${entry.name}: ${e.message}`, ...e.steps.map((step) => `${entry.name}: ${step}`)]
      : [`${entry.name}: ${e instanceof Error ? e.message : String(e)}`];
    return { name: entry.name, rows: [], answered: false, notes };
  }
}

/**
 * The oldest post each source stored: its last line, in the newest block that names
 * it.
 *
 * A block lists only the posts its read found new, so the newest block need not
 * name a source at all; that source's last check is still its line in an earlier
 * block. A block is newest first, so its last line is the oldest post it holds, and
 * that line stays in the list on the next read even when a pinned head sits above
 * it. Keyed by the entry name {@link postItem} writes as `**name**`.
 */
function previousBoundaries(doc: WFeedDoc): Map<string, { text: string; ref: string }> {
  const stored = new Map<string, { text: string; ref: string }>();
  const stamped = doc.posts.filter((p) => p.asOf !== null);
  const unstamped = doc.posts.filter((p) => p.asOf === null);
  stamped.sort((a, b) => (b.asOf?.getTime() ?? 0) - (a.asOf?.getTime() ?? 0));
  for (const block of [...stamped, ...unstamped]) {
    /* Walking backwards keeps the last line of the first block that names a source,
       and skips every later block for that source. */
    for (const line of [...block.items].reverse()) {
      const item = parsePostItem(line);
      if (item === null || item.source === '' || stored.has(item.source)) continue;
      stored.set(item.source, item);
    }
  }
  return stored;
}

/** What one source's stored blocks already hold. */
interface StoredKeys {
  /** Every URL the source's blocks list. */
  refs: Set<string>;
  /** Every ref-less text, without the action counts that tick between reads. */
  texts: Set<string>;
}

/**
 * Every post each source has stored in any block, keyed by the entry name.
 *
 * The anchor {@link previousBoundaries} returns is a position in the live list; this
 * is the whole history of stored keys, so a row above the anchor is still dropped
 * when the document already lists it.
 */
function storedKeys(doc: WFeedDoc): Map<string, StoredKeys> {
  const out = new Map<string, StoredKeys>();
  for (const block of doc.posts) {
    for (const line of block.items) {
      const item = parsePostItem(line);
      if (item === null || item.source === '') continue;
      let keys = out.get(item.source);
      if (keys === undefined) {
        keys = { refs: new Set(), texts: new Set() };
        out.set(item.source, keys);
      }
      if (item.ref !== '') keys.refs.add(item.ref);
      else keys.texts.add(stripActionLine(item.text));
    }
  }
  return out;
}

/**
 * Whether the document already lists this row for its source.
 *
 * A row with a URL is known by it; a row without one is known by its text without
 * the action counts. A post that is only retitled or reactivated keeps its URL, so it
 * counts as stored and is not written again.
 */
function alreadyStored(keys: StoredKeys | undefined, row: FeedDa): boolean {
  if (keys === undefined) return false;
  return row.ref !== '' ? keys.refs.has(row.ref) : keys.texts.has(stripActionLine(row.txt));
}

/**
 * Everything above the boundary row; a source that does not hold it keeps its list.
 *
 * The URL is compared first because it stays fixed, while the counts an item's text
 * leads with tick between reads. A row with no URL falls back to its text, compared
 * without those counts.
 */
function trimAtBoundary(rows: FeedDa[], boundary: { text: string; ref: string } | null): FeedDa[] {
  if (boundary === null) return rows;
  let at = boundary.ref === '' ? -1 : rows.findIndex((row) => row.ref === boundary.ref);
  if (at < 0) {
    const text = stripActionLine(boundary.text);
    if (text !== '') at = rows.findIndex((row) => stripActionLine(row.txt) === text);
  }
  return at < 0 ? rows : rows.slice(0, at);
}

/** Newest first; a row with no stamp keeps the order its source returned it in. */
const newestFirst = (a: FeedDa, b: FeedDa): number =>
  (b.dt?.getTime() ?? 0) - (a.dt?.getTime() ?? 0);

/** The block a row came from, as {@link srcRows} records it. */
const feedOf = (row: FeedDa): string =>
  (typeof row.rec?.feed === 'string' ? row.rec.feed : '');

/** Whether the entry reads every matching tab, so its rows merge several lists. */
const readsEveryTab = (entry: SrcFeedEntry): boolean => entry.tabs.trim().toLowerCase() === 'all';

/** Run options for {@link runSrcFeed}. */
export interface SrcFeedRunOptions {
  /** Ref of the feed document to read and write; `w.feed.md` when omitted. */
  ref?: string;
  /** Entry names; omitted reads what `## Setup`'s `sources:` names, and with neither
   *  every entry that declares no `Src:` row. */
  sources?: string[];
  now?: Date;
  store: SrcFeedStore;
  /** Push override, e.g. a spy in a test; defaults to {@link SrcFeedStore.push}. */
  push?: () => Promise<unknown>;
  /** Where progress lines go; defaults to the ambient console. */
  console?: Console;
}

/**
 * Run one read of the sources a feed document names.
 *
 * The block is written only when the read returns a new item. A read where every
 * source refused leaves the document untouched; one where a source answered but no
 * item was newer than the previous block moves `next` without adding a block.
 *
 * @param opts the feed document to write, the entries to read, the store, and the
 *   read's stamp
 * @returns what the read found and what it wrote
 */
export async function runSrcFeed(opts: SrcFeedRunOptions): Promise<SrcFeedReport> {
  const push = opts.push ?? (() => opts.store.push());
  const log = opts.console ?? (globalThis.console as Console);
  const at = opts.now ?? new Date();
  const feedRef = opts.ref ?? W_FEED_REF;
  const row = await opts.store.read(feedRef, 'md');
  const md = row?.txt ?? feedDraft(feedRef);
  const doc = parseWFeedDoc(md);
  const registry = await loadSrcRegistry(opts.store);
  const requested = opts.sources ?? doc.setup.sources;

  if (registry.entries.length === 0) {
    return {
      at, items: [], sources: requested, answered: [], notes: [],
      error: `no ${SRCFEED_REF} row (ref=${SRCFEED_REF}, type=md)`,
    };
  }

  /* An empty `sources:` reads the entries a server answers; a tab source is never
     implicit, because running one would execute in whichever tab matches first. */
  const names = requested.length > 0
    ? [...new Set(requested)]
    : registry.entries.filter((entry) => entry.src === '').map((entry) => entry.name);

  const boundaries = previousBoundaries(doc);
  const held = storedKeys(doc);
  const results: EntryRead[] = [];
  for (const name of names) {
    const entry = registry.entries.find((e) => e.name === name);
    if (entry === undefined) {
      results.push({
        name, rows: [], answered: false,
        notes: [`${name}: not in ${registry.legacy ? `${WEBFEED_REF} / ${EXTSRC_REF}` : SRCFEED_REF}`],
      });
      continue;
    }
    const read = await readEntry(entry, { store: opts.store, fallback: registry.fallback, at, log })
      .catch((e: unknown): EntryRead => ({
        name: entry.name, rows: [], answered: false,
        notes: [`${entry.name}: ${e instanceof Error ? e.message : String(e)}`],
      }));
    log.info(`[srcfeed] ${entry.name}: ${read.rows.length} row(s)`);
    const kept = held.get(entry.name);
    /* A multi-tab source merges one newest-first list per tab. Which list comes
       first is the browser's tab order, not recency, so the positional anchor would
       drop a tab's new chats when the tabs are reordered or one closes. There the
       stored keys alone decide what is new. */
    const window = readsEveryTab(entry)
      ? read.rows
      : trimAtBoundary(read.rows, boundaries.get(entry.name) ?? null);
    const rows = window.filter((row) => !alreadyStored(kept, row));
    results.push({ ...read, rows });
  }

  const notes = [
    ...(names.length === 0
      ? ['no entry to read: name a source in sources:, or declare one without a Src: row']
      : []),
    ...results.flatMap((result) => result.notes),
  ];
  const answered = results.filter((result) => result.answered).map((result) => result.name);
  const paths = new Set(results.map((result) => result.path).filter((p): p is BodyPath => p !== undefined));
  const pathNote = paths.has('twin')
    ? 'ran a compiled body: this page cannot eval row text'
    : paths.has('tab') ? 'ran in a browser tab' : undefined;

  const items = results
    .flatMap((result) => result.rows)
    .sort(newestFirst)
    .map((r) => ({ feed: feedOf(r), text: r.txt, ref: r.ref }));
  const sources = names.length > 0 ? names : [...new Set(results.map((result) => result.name))];

  if (items.length === 0) {
    /* A source answered but there is no new block to insert: the read succeeded,
       so move next while leaving the previous posts block in place. */
    if (answered.length > 0 && row !== undefined) await opts.store.save(row, feedRef, movedNext(md, doc, at));
    return { at, items, sources, answered, notes, pathNote };
  }

  const block = insertPosts(md, postsBlock(at, items.map((i) => postItem(i.feed, i.text, i.ref))));
  await opts.store.save(row, feedRef, setSetupValue(block, 'next', nextStamp(doc, at)));
  await push();
  return { at, items, sources, answered, notes, pathNote };
}

/** `next: <read stamp + freq>`, or '' when the document names no frequency. */
function nextStamp(doc: WFeedDoc, at: Date): string {
  return doc.setup.freqMs > 0 ? new Date(at.getTime() + doc.setup.freqMs).toISOString() : '';
}

/** The document with only its `next:` line moved. */
function movedNext(md: string, doc: WFeedDoc, at: Date): string {
  return setSetupValue(md, 'next', nextStamp(doc, at));
}

/** The latest stored items of one parsed document, newest block first. */
export function storedItems(doc: WFeedDoc): SrcFeedItem[] {
  const block = latestPosts(doc);
  if (block === undefined) return [];
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
 * @returns one line naming the item count, the answered sources, the age, and any
 *   per-source note or read failure
 */
export function reportLine(report: SrcFeedReport, now: Date = new Date()): string {
  const mode = report.pathNote ? ` · ${report.pathNote}` : '';
  if (report.error) {
    const why = report.notes.length > 0 ? `${report.error} · ${report.notes.join(' · ')}` : report.error;
    return `read failed: ${why}${mode}`;
  }
  if (report.answered.length === 0 && report.items.length === 0) {
    const why = report.notes.length > 0 ? report.notes.join(' · ') : 'no source answered';
    return `read failed · ${why}${mode}`;
  }
  const named = report.answered.length > 0 ? report.answered : report.sources;
  const where = named.length > 0 ? ` from ${named.join(', ')}` : '';
  const ago = fmtAgo(report.at.getTime(), now);
  const noted = report.notes.length > 0 ? ` · ${report.notes.join(' · ')}` : '';
  if (report.items.length === 0) return `no new item(s)${where} · ${ago}${noted}${mode}`;
  return `${report.items.length} new item(s)${where} · ${ago}${noted}${mode}`;
}

// ─── Global installation for `srcdom` rows ─────────────────────────────────

/** Everything {@link installSrcFeedGlobal} publishes. */
export interface SrcFeedApi {
  read: typeof readSource;
  fetch: typeof fetchWithBackoff;
  parse: typeof parseFeedPayload;
  posts: typeof htmlPostItems;
  json: typeof jsonFeedItems;
  markdown: typeof markdownFeedItems;
  rows: typeof planFeedRows;
  plan: typeof planStrategies;
  blocked: typeof blockedText;
  registry: typeof parseSrcFeedDoc;
  extractSource: typeof extractSource;
  extractFromDoc: typeof extractFromDoc;
  DEFAULT_FALLBACK: FeedFallback;
}

/** The public surface, as a plain object. */
export function srcfeedApi(): SrcFeedApi {
  return {
    read: readSource, fetch: fetchWithBackoff, parse: parseFeedPayload,
    posts: htmlPostItems, json: jsonFeedItems, markdown: markdownFeedItems,
    rows: planFeedRows, plan: planStrategies, blocked: blockedText,
    registry: parseSrcFeedDoc, extractSource, extractFromDoc, DEFAULT_FALLBACK,
  };
}

/**
 * Publish {@link srcfeedApi} on `target.srcfeed`.
 *
 * A `type='src'` row cannot `import` this file: `runsrc` evaluates it from a
 * `data:` URL, which has no base for a relative specifier. `src/ui/routes.tsx`
 * calls this at boot, which is what lets a site adapter call
 * `await srcfeed.read(ctx.args.source)`.
 *
 * @param target object to attach to; defaults to the current global
 * @returns the api that was installed
 */
export function installSrcFeedGlobal(
  target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): SrcFeedApi {
  const api = srcfeedApi();
  target.srcfeed = api;
  return api;
}
