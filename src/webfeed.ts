/**
 * webfeed.ts — extract the dynamic, unpersisted rows a `webfeed.md` row declares.
 *
 * A feed's items exist only on the wire, so every extracted row carries
 * `tid === undefined`: nothing is written until a caller pins, tags or clicks a
 * row and commits it through {@link commitFeedRows}. That is the split `srctag`
 * uses — the engine owns the reading, the caller owns the write.
 *
 * One source is reached by several strategies, tried in the written order, each
 * with its own exponential backoff ({@link fetchWithBackoff}) and each giving up
 * before the next is tried:
 *
 * | Strategy | Request | Read as |
 * |---|---|---|
 * | `api` | a URL the block declares under `* API:` | JSON |
 * | `cookied` | a caller-supplied reader, declared as `* Session:` | text |
 * | `direct` | the page itself | JSON, else HTML posts, else Markdown |
 * | `mobile` | the page's mobile mirror, `* Mobile:` or derived by {@link mobileUrl} | JSON, else HTML posts, else Markdown |
 * | `proxy` | `<proxy>/<page>` (`https://r.jina.ai/` by default) | Markdown, or HTML posts when the block asks the proxy for HTML |
 *
 * A body is read for what it is: JSON when it parses, the `<a class="post-link">`
 * posts when it is an HTML document ({@link htmlPostItems} — which reads a
 * `sina.cn/media/<id>` page for any id, because the posts are already in the
 * document the page serves), else Markdown.
 *
 * A 200 that carries a login wall or a CAPTCHA counts as a failure
 * ({@link blockedText}), so an extraction walks the remaining strategies instead
 * of reporting a visitor-system page as content. The four seeded sources answer
 * differently: the wallstreetcn JSON API and the `sina.cn` page both return rows,
 * while `zhihu.com` and `weibo.com` refuse every session-less strategy — the
 * mobile mirror and the render proxy included — and the attempts log says which,
 * per source.
 *
 * Like `srctag.ts` this file imports nothing from the app: no `sdb`, no Dexie, no
 * DOM. The `webfeed.md` row, the `type='src'` body that drives it, and the seed
 * helper that writes both live in `src/webfeedRows.ts`, and the browser's global
 * is publishing {@link webfeedApi} (`installWebfeedGlobal`).
 */

// ─── The `webfeed.md` dialect ──────────────────────────────────────────────

/** Row ref holding the feed document. */
export const WEBFEED_REF = 'webfeed.md';

/** Proxy root the `proxy` strategy prefixes when a block overrides none. */
export const DEFAULT_PROXY = 'https://r.jina.ai/';

/** One feed block, `### <name>` under `## Sources`. */
export interface FeedSource {
  /** The `###` heading, also the `rec.feed` an extracted row carries. */
  name: string;
  /** Page the block is about, and the `direct` strategy's request. */
  url: string;
  /** Row `type` the extracted rows take. */
  type: string;
  /** Request URLs tried before the page, in written order. */
  apis: string[];
  /** `* Session:` label handed to the caller's cookied reader; '' means none. */
  session: string;
  /** `* Mobile:` mirror to request; '' derives one with {@link mobileUrl}. */
  mobile: string;
  /** Per-source proxy override; '' falls back to {@link FeedFallback.proxy}. */
  proxy: string;
  /**
   * Request headers the `proxy` strategy adds, e.g. `X-Return-Format: html` for a
   * reader proxy whose Markdown loses the markup this file reads.
   */
  proxyHeaders: Record<string, string>;
  /** Tags every extracted row carries, before the caller's own. */
  tags: string[];
  /** Cap on rows kept from this source. */
  limit: number;
}

/** The `## Fallback` block: retry budget and the default proxy. */
export interface FeedFallback {
  proxy: string;
  /** Extra tries after the first, per request. */
  retries: number;
  baseDelayMs: number;
  capDelayMs: number;
  timeoutMs: number;
  /** Rows kept per source when the block names no `* Limit:`. */
  limit: number;
}

/** Retry budget and proxy root used when the document omits `## Fallback`. */
export const DEFAULT_FALLBACK: FeedFallback = {
  proxy: DEFAULT_PROXY,
  retries: 2,
  baseDelayMs: 800,
  capDelayMs: 8000,
  timeoutMs: 15000,
  limit: 0,
};

/** A parsed `webfeed.md`. */
export interface WebfeedDoc {
  sources: FeedSource[];
  fallback: FeedFallback;
}

/** One `- label: value` line under a bullet. */
const LISTED_LINE = /^\s+-\s*([^:]+):\s*(.+)$/;
/** One bare `- value` line under a bullet. */
const ITEM_LINE = /^\s+-\s*(.+)$/;

/**
 * Read the `## Sources` blocks of a `webfeed.md` and its `## Fallback` settings.
 *
 * The dialect is the one `secret.md` uses (`srctagRows.ts` reads it the same
 * way): `##` opens a section, `###` opens a block, `* Label:` starts a list, and
 * the `- x: y` / `- y` lines under it continue it. An unknown `* Label:` is
 * ignored rather than fatal, so a hand-edited document still parses.
 *
 * @param md the document text
 * @returns the sources in written order and the fallback settings
 */
export function parseWebfeedDoc(md: string): WebfeedDoc {
  const fallback: FeedFallback = { ...DEFAULT_FALLBACK };
  const sources: FeedSource[] = [];
  let section = '';
  let src: FeedSource | undefined;
  let list = '';

  const closeSource = () => {
    if (src && src.url) sources.push(src);
    src = undefined;
  };

  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      closeSource();
      src = {
        name: h3[1], url: '', type: 'url', apis: [], session: '',
        mobile: '', proxy: '', proxyHeaders: {}, tags: ['feed'], limit: 0,
      };
      list = '';
      continue;
    }
    if (/^##\s+/.test(line)) {
      closeSource();
      section = line.replace(/^##\s+/, '').trim().toLowerCase();
      list = '';
      continue;
    }
    const bullet = line.match(/^\*\s*([^:]+):\s*(.*)$/);
    if (bullet) {
      const label = bullet[1].trim().toLowerCase();
      const value = bullet[2].trim();
      list = label;
      if (section === 'sources' && src) {
        if (label === 'url') src.url = value;
        else if (label === 'type') src.type = value || src.type;
        else if (label === 'proxy') src.proxy = value;
        else if (label === 'mobile') src.mobile = value;
        else if (label === 'session') src.session = value;
        else if (label === 'limit') src.limit = Number(value) || 0;
        // A `* Tags:` list adds to the row's own tag rather than replacing it, so
        // every extracted row stays findable by `feed`.
      } else if (section === 'fallback' || !section) {
        const n = Number(value);
        if (label === 'proxy url' || label === 'proxy') fallback.proxy = value;
        else if (label === 'retries' && Number.isFinite(n)) fallback.retries = n;
        else if (label === 'base delay ms' && Number.isFinite(n)) fallback.baseDelayMs = n;
        else if (label === 'cap delay ms' && Number.isFinite(n)) fallback.capDelayMs = n;
        else if (label === 'timeout ms' && Number.isFinite(n)) fallback.timeoutMs = n;
        else if (label === 'limit' && Number.isFinite(n)) fallback.limit = n;
      }
      continue;
    }
    const entry = line.match(LISTED_LINE);
    if (entry && section === 'sources' && src && (list === 'api' || list === 'proxy headers')) {
      if (list === 'api') src.apis.push(entry[2].trim());
      else src.proxyHeaders[entry[1].trim()] = entry[2].trim();
      continue;
    }
    const item = line.match(ITEM_LINE);
    if (item && section === 'sources' && src && list === 'tags') {
      src.tags.push(item[1].trim());
    }
  }
  closeSource();
  return { sources, fallback };
}

// ─── Attempts and backoff ──────────────────────────────────────────────────

/** How a request reached the wire. */
export type FeedStrategy = 'api' | 'cookied' | 'direct' | 'mobile' | 'proxy';

/**
 * The mobile mirror of a page, carried over from the id its URL already names.
 *
 * `weibo.com/u/<id>` and `sina.cn/media/<id>` are the same account, and
 * `m.weibo.cn/u/<id>` is the copy a phone reads — which is why the derivation is
 * an id carry-over rather than a host substitution: the two pages do not share a
 * hostname. A URL with no id in it yields '', so the strategy is skipped for a
 * site this rule says nothing about.
 *
 * @param url the block's page
 * @returns the mobile URL, or '' when the URL carries no id to carry over
 */
export function mobileUrl(url: string): string {
  const id = url.match(/(?:\/u\/|\/media\/|[?&]value=)(\d{5,})/)?.[1];
  return id ? `https://m.weibo.cn/u/${id}` : '';
}

/** One HTTP attempt, as the findings table reports it. */
export interface FeedAttempt {
  source: string;
  strategy: FeedStrategy;
  url: string;
  /** Wait before this attempt, in ms; 0 on the first try of a request. */
  delayMs: number;
  ok: boolean;
  status: number;
  bytes: number;
  ms: number;
  /** Why the attempt failed; '' when it did not. */
  error: string;
}

/** The slice of `Response` this module reads, so a test can stub one. */
export interface FeedResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** The slice of `fetch` this module calls. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<FeedResponse>;

/** Retry budget, timeouts, and the seams a test replaces. */
export interface BackoffConfig {
  fetch?: FetchLike;
  /** Extra tries after the first. */
  retries?: number;
  baseDelayMs?: number;
  capDelayMs?: number;
  timeoutMs?: number;
  /** Wait between tries. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source; 1 disables jitter and makes the delay sequence exact. */
  random?: () => number;
  headers?: Record<string, string>;
}

/** How one request ended after its retries. */
export interface FetchOutcome {
  ok: boolean;
  status: number;
  text: string;
  /** One entry per try, in order. */
  attempts: FeedAttempt[];
  error: string;
}

/**
 * Wait before a retry: `base * 2^attempt`, capped, with at most half the value
 * taken back as jitter.
 *
 * @param attempt 0 for the wait before the second try
 * @param base first wait in ms
 * @param cap ceiling on the un-jittered wait
 * @param random jitter source in `[0, 1]`; pass `() => 1` for exact doubling
 * @returns the wait in ms
 */
export function backoffMs(
  attempt: number,
  base: number = DEFAULT_FALLBACK.baseDelayMs,
  cap: number = DEFAULT_FALLBACK.capDelayMs,
  random: () => number = Math.random,
): number {
  const growth = Math.min(cap, base * 2 ** Math.max(0, attempt));
  return Math.round(growth * (0.5 + 0.5 * random()));
}

/** Whether a status is worth another try: a timeout, a throttle, or a server fault. */
const retryableStatus = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status >= 500;

/** Text a wall or a challenge page is recognised by, checked on the first 600 chars. */
const BLOCK_MARKS: RegExp[] = [
  /Sina Visitor System/i,
  /安全验证/,
  /CAPTCHA/i,
  /访问过于频繁/,
  /Just a moment/i,
  /Enable JavaScript/i,
  /请开启 JavaScript/i,
];

/**
 * Why an answered body is not the content asked for.
 *
 * A site that refuses a session-less reader answers 200 with a challenge page,
 * so a status check alone would read the wall as the feed.
 *
 * @param text the response body
 * @returns the matched wall, `empty body`, or '' when the body looks real
 */
export function blockedText(text: string): string {
  const head = text.slice(0, 600);
  for (const rx of BLOCK_MARKS) if (rx.test(head)) return rx.source;
  return text.trim().length < 40 ? 'empty body' : '';
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch one URL, retrying with exponential backoff and giving up on what a retry
 * cannot fix.
 *
 * A thrown error and a `retryableStatus` are retried; a wall, a 403, a redirect
 * to a login page and an empty body are not, because the next strategy is the
 * answer to those, not another try at the same URL.
 *
 * @param url request URL
 * @param source source name, for the attempt log
 * @param strategy which strategy is asking
 * @param cfg retry budget and the `fetch`/`sleep` seams
 * @returns what answered and every attempt that led there
 */
export async function fetchWithBackoff(
  url: string,
  source: string,
  strategy: FeedStrategy,
  cfg: BackoffConfig = {},
): Promise<FetchOutcome> {
  const doFetch = cfg.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const retries = cfg.retries ?? DEFAULT_FALLBACK.retries;
  const base = cfg.baseDelayMs ?? DEFAULT_FALLBACK.baseDelayMs;
  const cap = cfg.capDelayMs ?? DEFAULT_FALLBACK.capDelayMs;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_FALLBACK.timeoutMs;
  const sleep = cfg.sleep ?? defaultSleep;
  const random = cfg.random ?? Math.random;
  const attempts: FeedAttempt[] = [];

  let last: FetchOutcome = { ok: false, status: 0, text: '', attempts, error: 'not attempted' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const delayMs = attempt === 0 ? 0 : backoffMs(attempt - 1, base, cap, random);
    if (delayMs > 0) await sleep(delayMs);
    const start = Date.now();
    const log: FeedAttempt = {
      source, strategy, url, delayMs, ok: false, status: 0, bytes: 0,
      ms: 0, error: '',
    };
    attempts.push(log);

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = typeof AbortController === 'undefined' ? undefined : new AbortController();
      if (controller && timeoutMs > 0) {
        timer = setTimeout(() => controller.abort(), timeoutMs);
      }
      const res = await doFetch(url, { headers: cfg.headers, signal: controller?.signal });
      const text = await res.text();
      log.status = res.status;
      log.bytes = text.length;
      log.ms = Date.now() - start;
      const wall = res.ok ? blockedText(text) : '';
      const failure = !res.ok ? `HTTP ${res.status}` : wall ? `blocked: ${wall}` : '';
      log.error = failure;
      log.ok = failure === '';
      last = { ok: log.ok, status: res.status, text: log.ok ? text : '', attempts, error: failure };
      if (log.ok || !retryableStatus(res.status)) return last;
    } catch (e) {
      log.ms = Date.now() - start;
      log.error = e instanceof Error ? e.message : String(e);
      last = { ok: false, status: 0, text: '', attempts, error: log.error };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return last;
}

// ─── Payload readers ───────────────────────────────────────────────────────

/** One item read off the wire, before it becomes a row. */
export interface FeedItem {
  /** Stable identity, used as the row's `ref`. */
  ref: string;
  txt: string;
  dt?: Date;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};

/** Strip tags, decode the entities a feed emits, and collapse whitespace. */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&[#\w]+;/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** `obj` as a record, or null when it is not one. */
const asObj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** `v` as an array, or an empty one. */
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** A `Date` for seconds-or-milliseconds stamps and for `ISO` strings; undefined when unreadable. */
function asDate(v: unknown): Date | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v < 1e11 ? v * 1000 : v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

/** Follow a path of object keys, stopping at the first miss. */
function at(root: unknown, ...keys: (string | number)[]): unknown {
  let cur: unknown = root;
  for (const key of keys) {
    const obj = asObj(cur);
    if (obj === null) return undefined;
    cur = obj[key];
  }
  return cur;
}

/** `weibo`'s `m.weibo.cn/api/container/getIndex` cards, one post per card. */
function readWeiboCards(js: unknown): FeedItem[] {
  return asArr(at(js, 'data', 'cards')).flatMap((card) => {
    const c = asObj(card);
    const mblog = asObj(c?.mblog);
    if (!mblog) return [];
    const id = str(mblog.id);
    const txt = plainText(str(mblog.text) || str(mblog.longText) || str(c?.title));
    if (!id || !txt) return [];
    return [{ ref: `https://m.weibo.cn/detail/${id}`, txt, dt: asDate(mblog.created_at) }];
  });
}

/** `wallstreetcn`'s `apiv1/content/lives` items. */
function readWallstcnItems(js: unknown): FeedItem[] {
  return asArr(at(js, 'data', 'items')).flatMap((item) => {
    const it = asObj(item);
    if (!it) return [];
    const txt = plainText(str(it.content_text) || str(it.title) || str(it.content));
    const id = str(it.id);
    if (!txt || !id) return [];
    return [{
      ref: `${str(it.uri) || `https://wallstreetcn.com/livenews/${id}`}`,
      txt,
      dt: asDate(it.display_time) ?? asDate(it.created_at),
    }];
  });
}

/** `zhihu`'s `api/v4/members/<id>/activities` entries. */
function readZhihuActivities(js: unknown): FeedItem[] {
  return asArr(at(js, 'data')).flatMap((entry) => {
    const e = asObj(entry);
    const target = asObj(e?.target);
    if (!target) return [];
    const txt = plainText(str(target.title) || str(target.excerpt) || str(e?.action_text));
    const url = str(target.url).replace('://api.zhihu.com/', '://www.zhihu.com/');
    if (!txt || !url) return [];
    return [{ ref: url, txt, dt: asDate(e?.created_time) ?? asDate(target.created_time) }];
  });
}

/**
 * Last resort for a JSON feed this module has no reader for: walk the tree and
 * take every object that carries both an identity and some text.
 *
 * @param js the parsed body
 * @returns the items found, in document order
 */
function readGenericJson(js: unknown): FeedItem[] {
  const out: FeedItem[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > 8 || out.length > 200) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    const obj = asObj(node);
    if (obj === null || seen.has(obj)) return;
    seen.add(obj);
    const txt = plainText(str(obj.title) || str(obj.text) || str(obj.content) || str(obj.content_text));
    const id = str(obj.id) || str(obj.url) || str(obj.uri);
    if (txt.length >= 8 && id) {
      out.push({ ref: /^https?:/.test(id) ? id : `#${id}`, txt, dt: asDate(obj.created_at) ?? asDate(obj.display_time) });
      return;
    }
    for (const value of Object.values(obj)) visit(value, depth + 1);
  };
  visit(js, 0);
  return out;
}

/**
 * Items in a parsed JSON body, whichever of the known feeds it is.
 *
 * The readers are chosen by shape, not by host: a proxy may answer with the same
 * JSON the API would have.
 *
 * @param js the parsed body
 * @returns the items found, newest first as the feed ordered them
 */
export function jsonFeedItems(js: unknown): FeedItem[] {
  for (const read of [readWeiboCards, readWallstcnItems, readZhihuActivities]) {
    const items = read(js);
    if (items.length > 0) return items;
  }
  return readGenericJson(js);
}

/** FNV-1a over the text, hex — a content identity for a body with no id of its own. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Drop the `Title:`/`URL Source:`/`Markdown Content:` header a reader proxy prepends. */
function stripReaderHeader(text: string): string {
  const at = text.indexOf('Markdown Content:');
  return at >= 0 ? text.slice(at + 'Markdown Content:'.length) : text;
}

/** One `![alt](src)` image inside a Markdown block, alt text included. */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;

/**
 * Items in a Markdown body: its link list when it has one, else one row per
 * block of prose.
 *
 * A prose block has no URL of its own, so its `ref` is the page plus a hash of
 * the text — the same block keeps the same identity across two extractions,
 * which is what the "stop at the last check" rule needs. Images are dropped
 * before the links are matched, because a reader proxy wraps a post around its
 * picture: matched image-first, the picture would become the item's own URL.
 *
 * @param text the response body
 * @param url the page it came from
 * @returns the items found, in document order
 */
export function markdownFeedItems(text: string, url: string): FeedItem[] {
  const body = stripReaderHeader(text).replace(MARKDOWN_IMAGE, ' ');
  const links: FeedItem[] = [];
  for (const m of body.matchAll(/\[([^\]]{4,300})\]\((https?:\/\/[^)\s]+)\)/g)) {
    const txt = plainText(m[1]);
    if (txt.length >= 4) links.push({ ref: m[2].replace(/\\\]\(/g, ']('), txt });
  }
  if (links.length >= 3) return links;

  return body
    .split(/\n{2,}/)
    .map((block) => plainText(block))
    .filter((txt) => txt.length >= 16)
    .map((txt) => ({ ref: `${url}#${shortHash(txt)}`, txt }));
}

// ─── HTML documents ─────────────────────────────────────────────────────────

/** One `<a class="post-link">` opening tag: the anchor a `sina.cn/media` page wraps a post in. */
const POST_LINK_RX = /<a\b[^>]*\bclass="[^"]*\bpost-link\b[^"]*"[^>]*>/gi;

/** The same anchor, without the `g` flag so testing a body for the markup keeps no state. */
const POST_LINK_CLASS = /<a\b[^>]*\bclass="[^"]*\bpost-link\b/i;

/** The labels of the numbers `post-actions` shows, in the order the page shows them. */
const ACTION_LABELS = ['转发', '评论', '赞'];

/** Index just past the opening `<div class="… cls …">` of the first block with that class. */
function divOpenEnd(html: string, cls: string): number | null {
  const m = html.match(new RegExp(`<div\\b[^>]*\\bclass="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, 'i'));
  return m === null || m.index === undefined ? null : m.index + m[0].length;
}

/**
 * The text of the first `<div class="cls">` of `html`, up to its closing tag.
 *
 * The blocks this reads (`post-text`, `post-repost`) hold inline markup only, so
 * the first `</div>` is the one that closes them.
 */
function divText(html: string, cls: string): string {
  const open = divOpenEnd(html, cls);
  if (open === null) return '';
  const body = html.slice(open);
  const end = body.indexOf('</div>');
  return plainText(end >= 0 ? body.slice(0, end) : body);
}

/** The numbers `post-actions` shows under a post: reposts, comments and likes, in that order. */
function actionCounts(html: string): string[] {
  const open = divOpenEnd(html, 'post-actions');
  if (open === null) return [];
  const scope = html.slice(open);
  const end = scope.indexOf('</article>');
  return (end >= 0 ? scope.slice(0, end) : scope)
    .split(/<div\b[^>]*\bclass="[^"]*\baction\b[^"]*"[^>]*>/gi)
    .slice(1)
    .map((action) => plainText(action.match(/<span\b[^>]*>([^<]*)<\/span>/i)?.[1] ?? ''));
}

/** The numbers under a post as the `[转发 2 · 评论 0 · 赞 9] ` line its row leads with. */
function actionLine(counts: string[]): string {
  const parts = counts
    .map((count, i) => (count === '' ? '' : `${ACTION_LABELS[i] ?? ''} ${count}`.trim()))
    .filter((part) => part !== '');
  return parts.length === 0 ? '' : `[${parts.join(' · ')}] `;
}

/**
 * The stamp a `2026-10-16 12:43` post writes, as the page renders its own clock.
 *
 * The page is a Chinese site, so the stamp is Beijing time; the machine reading
 * the feed is not assumed to be in that zone.
 */
function postTime(text: string): Date | undefined {
  const m = text.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (m === null) return undefined;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 8 * 3_600_000);
}

/**
 * Items in the HTML document a `sina.cn/media/<id>` page serves.
 *
 * The posts are already in the document — no API and no session — so one item is
 * one `<a class="post-link">`, and the page's own classes carry the rest: the
 * post's text, the quote it forwards, the numbers `post-actions` shows (reposts,
 * comments and likes, in that order), the stamp in `time`, and the post's own URL,
 * taken from the anchor's `href` and resolved against the page it was read from.
 * Nothing here is keyed on an account id, so one reader serves any media page.
 *
 * The row's text leads with the numbers, because a capped row would otherwise cut
 * them off the end of a post.
 *
 * @param html the page as it was served
 * @param url the page's URL, the base its `href` is resolved against
 * @returns the items found, in the page's order
 */
export function htmlPostItems(html: string, url: string): FeedItem[] {
  const marks = [...html.matchAll(POST_LINK_RX)];
  return marks.flatMap((mark, i) => {
    const block = html.slice((mark.index ?? 0) + mark[0].length, marks[i + 1]?.index ?? html.length);
    const text = divText(block, 'post-text');
    const quote = divText(block, 'post-repost');
    if (text === '' && quote === '') return [];
    const body = [text, quote === '' ? '' : `转发自 ${quote}`].filter((part) => part !== '').join(' ');
    const txt = `${actionLine(actionCounts(block))}${body}`;
    const href = mark[0].match(/\bhref="([^"]*)"/i)?.[1] ?? '';
    return [{ ref: href === '' ? `${url}#${shortHash(txt)}` : new URL(href, url).href, txt, dt: postTime(divText(block, 'time')) }];
  });
}

/** Whether a body is an HTML document rather than JSON or Markdown. */
const looksLikeHtml = (text: string): boolean =>
  /<(?:!doctype|html|body)\b/i.test(text) || POST_LINK_CLASS.test(text);

/**
 * Items in a response body: JSON when it parses, the posts of an HTML document,
 * else Markdown.
 *
 * An HTML body is read only for its posts, so a page with no post markup yields no
 * items: the walk then tries the next strategy instead of reading the page's
 * stylesheet as prose.
 *
 * @param text the response body
 * @param url the URL it came from
 * @returns the items found
 */
export function parseFeedPayload(text: string, url: string): FeedItem[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const items = jsonFeedItems(JSON.parse(trimmed));
      if (items.length > 0) return items;
    } catch {
      // A body that does not parse is read as Markdown below, which is what a
      // reader proxy returns for a page whose script tags made it look like JSON.
    }
  }
  return looksLikeHtml(text) ? htmlPostItems(text, url) : markdownFeedItems(text, url);
}

// ─── Rows ──────────────────────────────────────────────────────────────────

/**
 * A `db.das` row as this module sees it. Structurally compatible with `Da` from
 * `sdb` without importing it, the way `srctag.TagRow` is.
 */
export interface FeedDa {
  tid?: number;
  txt: string;
  ref: string;
  type: string;
  tags?: string[];
  dt?: Date;
  rec: Record<string, unknown>;
}

/** What {@link planFeedRows} did with one source's items. */
export interface FeedRowPlan {
  das: FeedDa[];
  /** Items dropped because an existing row already held them. */
  dropped: number;
  /** The known `ref` the walk stopped at, when it stopped before the list ended. */
  stoppedAt?: string;
}

/** How many characters of an item's text a row keeps. */
export const FEED_TXT_CAP = 400;

/** Collapse whitespace and cap the length, so one long post cannot dominate a row. */
function capTxt(txt: string): string {
  const one = txt.replace(/\s+/g, ' ').trim();
  return one.length > FEED_TXT_CAP ? `${one.slice(0, FEED_TXT_CAP - 1)}…` : one;
}

/**
 * Turn items into `tid`-less rows, stopping where the store already knows a row.
 *
 * A feed is read top-down, newest first, so the first item the store already
 * holds is the last check: everything above it is new, everything from it down
 * was read before. That is the "scroll up to the last check" rule, and
 * `stopAtKnown: false` turns it off for a caller that wants the whole list.
 *
 * @param items the items read, newest first
 * @param source the block they came from
 * @param strategy how they were read, kept in `rec` for the findings table
 * @param opts known rows, the cap, and whether to stop at the first known `ref`
 * @returns the rows to hand to a caller, and what the walk skipped
 */
export function planFeedRows(
  items: FeedItem[],
  source: FeedSource,
  strategy: FeedStrategy,
  opts: { existing?: FeedDa[]; limit?: number; stopAtKnown?: boolean; now?: Date } = {},
): FeedRowPlan {
  const limit = opts.limit ?? source.limit ?? 0;
  const known = new Set((opts.existing ?? []).map((r) => r.ref));
  const taken = new Set<string>();
  const now = opts.now ?? new Date();
  const das: FeedDa[] = [];
  let dropped = 0;
  let stoppedAt: string | undefined;

  for (const item of items) {
    const txt = capTxt(item.txt);
    if (!txt) continue;
    if (known.has(item.ref)) {
      if (opts.stopAtKnown !== false) {
        stoppedAt = item.ref;
        break;
      }
      dropped++;
      continue;
    }
    if (taken.has(item.ref)) {
      dropped++;
      continue;
    }
    taken.add(item.ref);
    das.push({
      txt,
      ref: item.ref,
      type: source.type || 'url',
      tags: [...source.tags],
      dt: item.dt ?? now,
      rec: { feed: source.name, strategy, src: source.url, fetchedAt: now.toISOString() },
    });
    if (limit > 0 && das.length >= limit) break;
  }
  return { das, dropped, stoppedAt };
}

// ─── Extraction ────────────────────────────────────────────────────────────

/** One request an extraction will try. */
export interface FeedPlanStep {
  strategy: FeedStrategy;
  url: string;
  /** Headers this step adds, e.g. what a reader proxy needs to answer with HTML. */
  headers?: Record<string, string>;
}

/** What one source's extraction produced. */
export interface FeedExtractResult {
  source: string;
  url: string;
  type: string;
  /** The strategy that answered; null when every one under it failed. */
  strategy: FeedStrategy | null;
  das: FeedDa[];
  attempts: FeedAttempt[];
  /** The known `ref` the walk stopped at. */
  stoppedAt?: string;
  /** One line per reason the result is short of a full list. */
  notes: string[];
}

/** Options for {@link extractSource}. */
export interface FeedExtractOptions extends BackoffConfig {
  /** Rows the store already holds for this source; the walk stops at the first one. */
  existing?: FeedDa[];
  limit?: number;
  stopAtKnown?: boolean;
  now?: Date;
  /**
   * Reader for a source that declares `* Session:` — the caller's session-aware
   * path, e.g. `fc.get_weibo_posts`. It returns a response body to parse or the
   * items themselves, for a reader that already parsed them.
   *
   * Absent, the strategy is skipped rather than attempted: this module holds no
   * session of its own.
   */
  cookied?: (source: FeedSource) => Promise<string | FeedItem[]>;
}

/**
 * The requests {@link extractSource} tries, in order.
 *
 * @param source the block
 * @param fallback the document's `## Fallback` settings
 * @param hasCookied whether the caller supplied a session-aware reader
 * @returns the steps, in the order they will be tried
 */
export function planStrategies(
  source: FeedSource,
  fallback: FeedFallback = DEFAULT_FALLBACK,
  hasCookied = false,
): FeedPlanStep[] {
  const steps: FeedPlanStep[] = source.apis.map((url) => ({ strategy: 'api' as const, url }));
  if (hasCookied && source.session) steps.push({ strategy: 'cookied', url: source.url });
  if (source.url) steps.push({ strategy: 'direct', url: source.url });
  const mobile = source.mobile || mobileUrl(source.url);
  if (mobile) steps.push({ strategy: 'mobile', url: mobile });
  const proxy = source.proxy || fallback.proxy;
  if (source.url && proxy) {
    steps.push({
      strategy: 'proxy',
      url: proxy.replace(/\/+$/, '') + '/' + source.url,
      headers: source.proxyHeaders,
    });
  }
  return steps;
}

/**
 * Items a session-aware reader returned: a plain string list (what
 * `fc.get_weibo_posts` yields) keeps a content-hashed `ref`, so the same post
 * read twice is one row.
 *
 * @param read the reader's result
 * @param url the source's page, the hash's prefix
 * @returns the items, ready for {@link planFeedRows}
 */
function cookiedItems(read: string | FeedItem[], url: string): FeedItem[] {
  if (!Array.isArray(read)) return [{ ref: `${url}#${shortHash(read)}`, txt: read }];
  return read.map((v) => (typeof v === 'string' ? { ref: `${url}#${shortHash(v)}`, txt: v } : v));
}

/**
 * Read one source, walking the strategies until one answers with items.
 *
 * @param source the block to read
 * @param fallback the document's `## Fallback` settings
 * @param opts retry budget, the known rows, and the session-aware reader
 * @returns the rows, the attempts, and the reasons any strategy was abandoned
 */
export async function extractSource(
  source: FeedSource,
  fallback: FeedFallback = DEFAULT_FALLBACK,
  opts: FeedExtractOptions = {},
): Promise<FeedExtractResult> {
  const steps = planStrategies(source, fallback, opts.cookied !== undefined);
  const attempts: FeedAttempt[] = [];
  const notes: string[] = [];

  for (const step of steps) {
    let items: FeedItem[];
    if (step.strategy === 'cookied') {
      const start = Date.now();
      let read: string | FeedItem[];
      try {
        read = await (opts.cookied as (s: FeedSource) => Promise<string | FeedItem[]>)(source);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        attempts.push({ source: source.name, strategy: 'cookied', url: step.url, delayMs: 0, ok: false, status: 0, bytes: 0, ms: Date.now() - start, error });
        continue;
      }
      const body = Array.isArray(read) ? '' : read;
      const wall = Array.isArray(read) ? '' : blockedText(read);
      attempts.push({ source: source.name, strategy: 'cookied', url: step.url, delayMs: 0, ok: wall === '', status: 200, bytes: body.length, ms: Date.now() - start, error: wall ? `blocked: ${wall}` : '' });
      if (wall) continue;
      items = Array.isArray(read) ? cookiedItems(read, step.url) : parseFeedPayload(body, step.url);
    } else {
      /* A step's own headers (what a reader proxy needs) join the caller's; a step
         without any passes the caller's through untouched. */
      const headers = step.headers === undefined ? opts.headers : { ...opts.headers, ...step.headers };
      const out = await fetchWithBackoff(step.url, source.name, step.strategy, { ...opts, headers });
      attempts.push(...out.attempts);
      if (!out.ok) {
        notes.push(`${step.strategy}: ${out.error}`);
        continue;
      }
      items = parseFeedPayload(out.text, step.url);
    }

    if (items.length === 0) {
      notes.push(`${step.strategy}: no items`);
      continue;
    }
    const plan = planFeedRows(items, source, step.strategy, {
      existing: opts.existing,
      limit: opts.limit,
      stopAtKnown: opts.stopAtKnown,
      now: opts.now,
    });
    return {
      source: source.name, url: source.url, type: source.type,
      strategy: step.strategy, das: plan.das, attempts,
      stoppedAt: plan.stoppedAt, notes,
    };
  }

  return {
    source: source.name, url: source.url, type: source.type,
    strategy: null, das: [], attempts, notes,
  };
}

// ─── The document and its callers ──────────────────────────────────────────

/** The slice of a Dexie table {@link extractFromDoc} needs. */
export interface FeedTable {
  where(key: string): { equals(value: unknown): { toArray(): Promise<FeedDa[]> } };
  filter(pred: (row: FeedDa) => boolean): { toArray(): Promise<FeedDa[]> };
  toArray(): Promise<FeedDa[]>;
}

/** The slice of the page tables a body receives. */
export interface FeedDb {
  das: FeedTable;
}

/** What {@link extractFromDoc} was handed. */
export interface FeedDocInput {
  db: FeedDb;
  /** `ctx.args` of the `run_src` call: `sources`, `url`, `existing`, retry overrides. */
  args?: Record<string, unknown>;
  /** Where progress lines go; defaults to the ambient console. */
  console?: Console;
}

/** One document's extraction. */
export interface FeedDocResult {
  ref: string;
  sources: FeedExtractResult[];
  /** Every row from every source, newest first within its source. */
  das: FeedDa[];
  /** Every attempt in the order it was made, the findings table's input. */
  attempts: FeedAttempt[];
  notes: string[];
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/**
 * Rows the store already holds for one source.
 *
 * The `rec.feed` test is done in JS rather than in an index, because `rec` is a
 * plain object column and only `type` is indexed; a table that refuses the query
 * (a shim in a test, a version whose index list differs) falls back to a full
 * read rather than failing the extraction.
 */
async function existingRows(db: FeedDb, source: FeedSource): Promise<FeedDa[]> {
  const mine = (row: FeedDa): boolean => asObj(row.rec)?.feed === source.name;
  try {
    return (await db.das.where('type').equals(source.type || 'url').toArray()).filter(mine);
  } catch {
    return (await db.das.toArray()).filter(mine);
  }
}

/**
 * Read the `webfeed.md` row, extract every source it declares, and return the
 * rows without writing any of them.
 *
 * `ctx.args` overrides the document: `sources` picks blocks by name, `url` reads
 * an ad-hoc source the document does not hold, `existing` supplies the known rows
 * directly (a caller that already has them need not hand over `db`), and
 * `retries` / `baseDelayMs` / `timeoutMs` / `proxy` move the fallback settings.
 *
 * A missing document is a normal state — it throws here, because a caller asked
 * for feeds it did not seed, and `seedWebfeedRows` is the step that fixes it.
 *
 * @param input the tables to read, the `run_src` args, and a log sink
 * @returns every source's rows, every attempt, and the notes
 */
export async function extractFromDoc(input: FeedDocInput): Promise<FeedDocResult> {
  const args = input.args ?? {};
  const log = input.console ?? (globalThis.console as Console);
  const rows = await input.db.das.where('[ref+type]').equals([WEBFEED_REF, 'md']).toArray();
  const live = rows.filter((r) => !(r.tags ?? []).includes('[del]'));
  const row = live[live.length - 1] ?? rows[rows.length - 1];
  if (!row?.txt) throw new Error(`no ${WEBFEED_REF} row (ref=${WEBFEED_REF}, type=md)`);

  const doc = parseWebfeedDoc(row.txt);
  const fallback: FeedFallback = {
    ...doc.fallback,
    proxy: typeof args.proxy === 'string' ? args.proxy : doc.fallback.proxy,
    retries: typeof args.retries === 'number' ? args.retries : doc.fallback.retries,
    baseDelayMs: typeof args.baseDelayMs === 'number' ? args.baseDelayMs : doc.fallback.baseDelayMs,
    timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : doc.fallback.timeoutMs,
    limit: typeof args.limit === 'number' ? args.limit : doc.fallback.limit,
  };

  const wanted = arr(args.sources);
  const adhoc = typeof args.url === 'string' && args.url
    ? {
      name: typeof args.name === 'string' ? args.name : 'adhoc',
      url: args.url, type: typeof args.type === 'string' ? args.type : 'url',
      apis: [], session: '', mobile: '', proxy: '', proxyHeaders: {}, tags: ['feed'], limit: 0,
    } satisfies FeedSource
    : undefined;
  const sources = doc.sources
    .filter((s) => wanted.length === 0 || wanted.includes(s.name))
    .concat(adhoc ? [adhoc] : []);
  if (sources.length === 0) {
    throw new Error(`${WEBFEED_REF} declares no source${wanted.length ? ` named ${wanted.join(', ')}` : ''}`);
  }

  const given = Array.isArray(args.existing) ? args.existing as FeedDa[] : undefined;
  const results: FeedExtractResult[] = [];
  for (const source of sources) {
    const existing = given ?? (input.db ? await existingRows(input.db, source) : []);
    const res = await extractSource(source, fallback, { ...args, existing, limit: fallback.limit });
    log.info(`[webfeed] ${source.name}: ${res.strategy ?? 'no strategy'} -> ${res.das.length} row(s)`);
    results.push(res);
  }

  const attempts = results.flatMap((r) => r.attempts);
  const notes = results.flatMap((r) => r.notes.map((n) => `${r.source} ${n}`));
  return {
    ref: WEBFEED_REF,
    sources: results,
    das: results.flatMap((r) => r.das),
    attempts,
    notes,
  };
}

// ─── Commit ────────────────────────────────────────────────────────────────

/** Where {@link commitFeedRows} writes a row: `db.das` in the app, a spy in a test. */
export interface FeedWritePort {
  write(row: FeedDa): Promise<unknown>;
}

/**
 * Write the rows a caller decided to keep.
 *
 * Nothing in this module calls it. Persisting is the caller's step, taken when a
 * user pins, tags or clicks a row — the same separation `srctag`'s
 * `commitTagUpdates` keeps from its own scoring.
 *
 * @param port the writing end, e.g. `sdb`'s `db.das`
 * @param das the rows to write; each takes a fresh `tid` from the store
 * @returns how many rows were written
 */
export async function commitFeedRows(port: FeedWritePort, das: FeedDa[]): Promise<number> {
  let n = 0;
  for (const row of das) {
    const { tid: _drop, ...rest } = row;
    await port.write(rest as FeedDa);
    n++;
  }
  return n;
}

// ─── Global installation for `run_src` ─────────────────────────────────────

/** Everything {@link installWebfeedGlobal} publishes. */
export interface WebfeedApi {
  parseWebfeedDoc: typeof parseWebfeedDoc;
  planStrategies: typeof planStrategies;
  mobileUrl: typeof mobileUrl;
  backoffMs: typeof backoffMs;
  blockedText: typeof blockedText;
  fetchWithBackoff: typeof fetchWithBackoff;
  jsonFeedItems: typeof jsonFeedItems;
  markdownFeedItems: typeof markdownFeedItems;
  htmlPostItems: typeof htmlPostItems;
  parseFeedPayload: typeof parseFeedPayload;
  planFeedRows: typeof planFeedRows;
  extractSource: typeof extractSource;
  extractFromDoc: typeof extractFromDoc;
  commitFeedRows: typeof commitFeedRows;
  /** Default retry budget and proxy root, for a caller that prints them. */
  DEFAULT_FALLBACK: FeedFallback;
}

/** The public surface, as a plain object. */
export function webfeedApi(): WebfeedApi {
  return {
    parseWebfeedDoc, planStrategies, mobileUrl, backoffMs, blockedText, fetchWithBackoff,
    jsonFeedItems, markdownFeedItems, htmlPostItems, parseFeedPayload, planFeedRows, extractSource,
    extractFromDoc, commitFeedRows, DEFAULT_FALLBACK,
  };
}

/**
 * Publish {@link webfeedApi} on `target.webfeed`.
 *
 * A `type='src'` row cannot `import` this file: `runsrc` evaluates it from a
 * `data:` URL, which has no base for a relative specifier. `src/ui/routes.tsx`
 * calls this at boot, which is what lets a row call
 * `await webfeed.extractFromDoc({ db: ctx.db, args: ctx.args })`.
 *
 * @param target object to attach to; defaults to the current global
 * @returns the api that was installed
 */
export function installWebfeedGlobal(
  target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): WebfeedApi {
  const api = webfeedApi();
  target.webfeed = api;
  return api;
}
