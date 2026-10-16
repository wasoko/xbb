/**
 * wFeed.ts — the `w.feed.md` document: the `## Setup` a read obeys and the
 * `## Posts as of …` blocks a read writes into it.
 *
 * `webfeed.md` holds everything a feed needs in order to be read at all: the source
 * blocks, their URLs, APIs and tags, and the retry budget. `w.feed.md` holds the
 * other half — when the next read is due, which blocks it reads, and the few newest
 * items each read found — so a pin card can point at one ref and read both.
 *
 * The dialect is the one `webfeed.md` uses, read the other way round: `##` opens a
 * section, and the section's own lines are what carry the values.
 *
 *   ## Setup
 *   freq: 4hr
 *   next: 2026-10-16T11:30:00Z
 *   sources: wallstreetcn, sina-fly51fly
 *
 *   ## Notes
 *   whatever the user wrote here
 *
 *   ## Posts as of 2026-10-16T07:30:00Z
 *   - **wallstreetcn** 央行… — https://wallstreetcn.com/livenews/42
 *
 * `## Setup` is a `key: value` list and any other table-backed section opening with
 * `Posts` is one read's output. A read inserts its block directly under `Setup` —
 * the newest first, older blocks below it — or at the end of the document when the
 * document holds no posts yet.
 *
 * Nothing here reaches the network, and nothing here imports the app: the read that
 * writes a block lives in `src/ui/wFeedRun.ts`, so a test can read this dialect the
 * way `test/webfeed.test.ts` reads `webfeed.md`'s.
 */

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

/** Items one read keeps in its `## Posts as of` block, newest first across sources. */
export const POST_ITEMS = 6;

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
  /** `sources:` block names of `webfeed.md`; empty means every block it declares. */
  sources: string[];
  /** Every other `key: value` line, keyed by its lowercased key. */
  values: Record<string, string>;
  /** The section's other lines, in order. */
  lines: string[];
}

/** One `## Posts as of …` block: one read's few newest items. */
export interface WFeedPost {
  /** The heading as written, `as of …` included. */
  heading: string;
  /** The stamp the heading names, when it carries one. */
  asOf: Date | null;
  /** The block's `- item` lines as written. */
  items: string[];
}

/** A parsed `w.feed.md`. */
export interface WFeedDoc {
  /** The document's own head, before the first `##` section. */
  head: string;
  setup: WFeedSetup;
  /** The posts blocks in document order, newest first as a read writes them. */
  posts: WFeedPost[];
}

/** One `##` section: its heading and the lines under it, heading excluded. */
interface Section {
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
function splitSections(md: string): { head: string; sections: Section[] } {
  const lines = md.replace(/\s+$/, '').split('\n');
  const sections: Section[] = [];
  let open: Section | undefined;
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
      setup.sources = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
      continue;
    }
    setup.values[key] = value;
  }
  return setup;
}

/**
 * Read a `w.feed.md`.
 *
 * @param md - the document text
 * @returns its head, its `## Setup` values, and its posts blocks in written order
 */
export function parseWFeedDoc(md: string): WFeedDoc {
  const { head, sections } = splitSections(md);
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
 * @param source - the `webfeed.md` block the item came from
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
  const { sections } = splitSections(md);
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
  const { sections } = splitSections(md);
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
