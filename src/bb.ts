/**
 * bb.ts — Bilibili reads behind the seeded `bb-*` source rows.
 *
 * The rows run in the extension page, which shares the browser's Bilibili
 * cookies: every request uses `credentials: 'include'`, and this module stores or
 * forwards no token. In the webapp, `routes.tsx` installs the Supabase proxy
 * (`bbProxyInstall.ts`) as a default transport, so the same readers call
 * `cors_bb` instead of Bilibili directly. A browser that is not logged in gets
 * `needsUser` naming the passport login page or the webapp QR step, so the user
 * signs in once and reruns the row.
 *
 * The endpoints are the ones the web client uses:
 *
 *   history          /x/web-interface/history/cursor
 *   created folders  /x/v3/fav/folder/created/list-all
 *   subscriptions    /x/v3/fav/folder/collected/list   (type 11 folder, 21 season)
 *   folder items     /x/v3/fav/resource/list
 *   season items     /x/space/fav/season/list
 *
 * A subscribed list carries its owner's name in `txt`, so two folders with the same
 * title stay distinguishable in a feed block.
 */

/** API root every request is built on. */
const API = 'https://api.bilibili.com';

/** Where a logged-out browser finishes the QR login. */
export const BB_LOGIN_URL = 'https://passport.bilibili.com/login';

/** Part of a `needsUser` step that names the webapp's own Supabase sign-in. */
export const BB_SIGNIN_HINT = 'sign in to the webapp';

/** Hard ceiling for one read, so a corrupt cursor cannot spin forever. */
const MAX_ROWS = 5555;

/** The most pages one list read walks; 20 rows a page reaches the row cap. */
const MAX_PAGES = 300;

/** One request's budget before the read reports a timeout. */
const TIMEOUT_MS = 15_000;

/** One row a `bb-*` row reports, before `srcfeed` adds its own fields. */
export interface BbRow {
  txt: string;
  ref: string;
  dt?: Date;
  tags?: string[];
  rec?: Record<string, unknown>;
}

/** What a `bb-*` row returns. */
export interface BbOut {
  rows: BbRow[];
  notes: string[];
  /** One manual step; `srcfeed` marks the source unanswered and shows this first. */
  needsUser?: string;
}

/** The logged-in account, as `nav` reports it. */
export interface BbNav {
  isLogin: boolean;
  mid: string;
  uname: string;
}

/** What one list URL names. */
export type BbListRef =
  | { kind: 'fav'; mediaId: string; mid: string }
  | { kind: 'season'; seasonId: string; mid: string }
  | { kind: 'series'; seriesId: string; mid: string };

/** The slice of `fetch` this module uses, so a test passes a plain stub. */
export type BbFetch = (url: string, init: {
  credentials: 'include';
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Options a caller may override; tests pass `fetch`, the app passes nothing. */
export interface BbReadOptions {
  fetch?: BbFetch;
}

/** The transport `routes.tsx` installs for the webapp proxy, or undefined. */
let installedFetch: BbFetch | undefined;

/**
 * Install the webapp proxy as the default transport.
 *
 * An explicit `fetch` on a read still wins. The extension page leaves this unset,
 * so `bbGet` uses the browser's own `fetch` and its Bilibili cookies.
 *
 * @param fetchImpl the proxy transport, or undefined to remove it
 */
export function setBbFetch(fetchImpl: BbFetch | undefined): void {
  installedFetch = fetchImpl;
}

/** Whether a webapp proxy transport is installed. */
export function hasBbFetch(): boolean {
  return installedFetch !== undefined;
}

/** A Bilibili response whose `code` is not 0. */
export class BbApiError extends Error {
  /**
   * @param code the response's `code`
   * @param message the response's `message`
   */
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'BbApiError';
  }
}

/** The webapp has no Supabase session, so the proxy cannot be called yet. */
export class BbSignInError extends Error {
  constructor(message = `${BB_SIGNIN_HINT} to use the bilibili QR login`) {
    super(message);
    this.name = 'BbSignInError';
  }
}

/** The webapp cannot hold Bilibili cookies or make Bilibili's cross-origin calls. */
export class BbUnavailableError extends Error {
  constructor() {
    super('bilibili reads need the extension page or an installed webapp proxy');
    this.name = 'BbUnavailableError';
  }
}

/** Whether this realm is the Tab Seer extension page, which shares the browser's cookies. */
function isExtensionPage(): boolean {
  const location = (globalThis as { location?: { protocol?: string } }).location;
  const chrome = (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome;
  return location?.protocol === 'chrome-extension:' && !!chrome?.runtime?.id;
}

/** The step a webapp read returns instead of a request Bilibili would refuse. */
const webappOut = (): BbOut => ({
  rows: [],
  notes: [],
  needsUser: `bilibili reads need the extension page or the webapp proxy: the webapp has no bilibili cookies and bilibili blocks cross-origin API calls. Open options.html from the Tab Seer extension, log in at ${BB_LOGIN_URL} if needed, then rerun.`,
});

/** `value` as a plain object, or null. */
const asObj = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/** `value` as an array, or an empty array. */
const asArr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** `value` as a string; '' for null and undefined. */
const str = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value);

/** `value` as a finite number, including a numeric string. */
const num = (value: unknown): number | undefined => {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** `value` as a boolean. */
const bool = (value: unknown): boolean => value === true || value === 1 || value === '1';

/** `value` as a Date, from a seconds stamp; undefined when it carries none. */
const stamp = (value: unknown): Date | undefined => {
  const n = num(value);
  return n === undefined || n <= 0 ? undefined : new Date(n * 1000);
};

/** A duration in seconds as `m:ss` or `h:mm:ss`. */
export function mmss(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** The `ctx.args` object a seeded body forwards. */
const asArgs = (args: unknown): Record<string, unknown> =>
  typeof args === 'object' && args !== null ? args as Record<string, unknown> : {};

/** The registry entry a `Src:` row receives as `ctx.args.source`. */
const sourceOf = (args: Record<string, unknown>): Record<string, unknown> =>
  asObj(args.source) ?? {};

/**
 * The row cap one read takes.
 *
 * `args.limit` wins, then `args.max`, then a positive entry `* Max:`. An explicit
 * `0` on the call means every row the API offers, capped at {@link MAX_ROWS}; an
 * absent cap or an entry `Max: 0` leaves the reader's own default.
 *
 * @param args the body's `ctx.args`
 * @param fallback the reader's default
 * @returns a positive row cap
 */
function capOf(args: Record<string, unknown>, fallback: number): number {
  const clamp = (n: number): number => Math.max(1, Math.min(MAX_ROWS, Math.floor(n)));
  const direct = num(args.limit) ?? num(args.max);
  if (direct !== undefined) return direct === 0 ? MAX_ROWS : clamp(direct);
  const entry = num(sourceOf(args).max);
  return entry !== undefined && entry > 0 ? clamp(entry) : fallback;
}

/** A page size clamped to what the endpoint accepts. */
const pageSizeOf = (args: Record<string, unknown>, fallback: number, max: number): number =>
  Math.max(1, Math.min(max, Math.floor(num(args.ps) ?? fallback)));

/** The report a logged-out browser gets. */
const loginOut = (): BbOut => ({
  rows: [],
  notes: [],
  needsUser: `log in to bilibili (QR), then run this row again: ${BB_LOGIN_URL}`,
});

/** The report a webapp read gets before its Supabase session exists. */
const signInOut = (message: string): BbOut => ({
  rows: [],
  notes: [],
  needsUser: message.includes(BB_SIGNIN_HINT) ? message : `${BB_SIGNIN_HINT}: ${message}`,
});

/**
 * A failed read as a report.
 *
 * `-101` is the one failure a person can fix, so it becomes `needsUser`; the others
 * stay notes naming the API's own message.
 *
 * @param error what the reader threw
 * @returns the report a `bb-*` row returns
 */
function bbFailure(error: unknown): BbOut {
  if (error instanceof BbSignInError) return signInOut(error.message);
  if (error instanceof BbUnavailableError) return webappOut();
  if (error instanceof BbApiError) {
    if (error.code === -101) return loginOut();
    if (error.code === -403) {
      return { rows: [], notes: [`bb: this list is private (${error.message})`] };
    }
    if (error.code === -352 || error.code === -412) {
      return {
        rows: [],
        notes: [`bb: bilibili risk control (${error.code}); open bilibili.com in a tab and retry`],
      };
    }
    return { rows: [], notes: [`bb: ${error.message} (${error.code})`] };
  }
  return { rows: [], notes: [`bb: ${error instanceof Error ? error.message : String(error)}`] };
}

/**
 * One logged-in GET.
 *
 * @param path an API path such as `/x/web-interface/nav`
 * @param params query parameters; `undefined` and `''` are omitted
 * @param opts the test fetch seam
 * @returns the response's `data`
 * @throws BbApiError when the response's `code` is not 0
 */
async function bbGet(
  path: string,
  params: Record<string, string | number | undefined> = {},
  opts: BbReadOptions = {},
): Promise<unknown> {
  const url = new URL(path, API);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  const doFetch = opts.fetch ?? installedFetch
    ?? (isExtensionPage() ? (globalThis.fetch as unknown as BbFetch | undefined) : undefined);
  if (typeof doFetch !== 'function') throw new BbUnavailableError();
  const controller = typeof AbortController === 'undefined' ? undefined : new AbortController();
  const timer = controller === undefined
    ? undefined
    : setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(url.toString(), { credentials: 'include', signal: controller?.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.pathname}`);
    const body = asObj(await res.json());
    const code = num(body?.code) ?? -1;
    if (code !== 0) throw new BbApiError(code, str(body?.message) || `bilibili code ${code}`);
    return body?.data;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The logged-in account.
 *
 * @param opts the test fetch seam
 * @returns `isLogin` and the account id; a logged-out browser reports false
 */
export async function bbNav(opts: BbReadOptions = {}): Promise<BbNav> {
  try {
    const data = asObj(await bbGet('/x/web-interface/nav', {}, opts));
    return {
      isLogin: bool(data?.isLogin),
      mid: str(data?.mid),
      uname: str(data?.uname),
    };
  } catch (error) {
    if (error instanceof BbApiError && error.code === -101) {
      return { isLogin: false, mid: '', uname: '' };
    }
    throw error;
  }
}

/** A video row's text: title, part title, author, duration. */
function historyText(item: Record<string, unknown>): string {
  const title = str(item.title);
  const part = str(item.long_title);
  const author = str(item.author_name);
  const duration = num(item.duration) ?? 0;
  return `${title}${part && part !== title ? ` · ${part}` : ''}`
    + `${author ? ` — ${author}` : ''}${duration > 0 ? ` · ${mmss(duration)}` : ''}`;
}

/**
 * The account's recent video history, newest watched first.
 *
 * Walks the cursor until the cap or the end. Non-video history entries (live,
 * articles, PGC) are skipped: the row type is `url`, and a video ref is what a feed
 * block can open.
 *
 * @param args `ctx.args`; `limit`/`max` cap the walk, `ps` sets the page size
 * @param opts the test fetch seam
 * @returns up to the cap in watch order, with `view_at` as each row's `dt`
 */
export async function bbHistory(
  args: Record<string, unknown> = {},
  opts: BbReadOptions = {},
): Promise<BbOut> {
  const bag = asArgs(args);
  const limit = capOf(bag, 111);
  const pageSize = pageSizeOf(bag, 30, 50);
  const rows: BbRow[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  let cursorMax = '';
  let cursorView = '';
  let cursorBusiness = '';
  let pages = 0;
  try {
    while (rows.length < limit && pages < MAX_PAGES) {
      pages++;
      const take = Math.min(pageSize, limit - rows.length);
      const data = asObj(await bbGet('/x/web-interface/history/cursor', {
        ps: take,
        max: cursorMax,
        view_at: cursorView,
        business: cursorBusiness,
      }, opts));
      const list = asArr(data?.list);
      if (list.length === 0) break;
      for (const raw of list) {
        if (rows.length >= limit) break;
        const item = asObj(raw);
        if (!item) continue;
        const history = asObj(item.history);
        const business = str(history?.business);
        if (business !== '' && business !== 'archive') continue;
        const bvid = str(history?.bvid);
        const aid = str(history?.oid);
        const ref = bvid !== ''
          ? `https://www.bilibili.com/video/${bvid}`
          : aid !== '' ? `https://www.bilibili.com/video/av${aid}` : '';
        if (ref === '' || seen.has(ref)) continue;
        seen.add(ref);
        const duration = num(item.duration) ?? 0;
        rows.push({
          txt: historyText(item),
          ref,
          dt: stamp(item.view_at),
          tags: ['bilibili', 'history'],
          rec: {
            aid,
            bvid,
            author: str(item.author_name),
            business,
            duration,
            progress: num(item.progress) ?? 0,
            cover: str(item.cover),
          },
        });
      }
      const cursor = asObj(data?.cursor);
      const nextMax = str(cursor?.max);
      const nextView = str(cursor?.view_at);
      const nextBusiness = str(cursor?.business);
      if (nextMax === cursorMax && nextView === cursorView && nextBusiness === cursorBusiness) break;
      cursorMax = nextMax;
      cursorView = nextView;
      cursorBusiness = nextBusiness;
    }
  } catch (error) {
    return bbFailure(error);
  }
  if (rows.length === 0) notes.push('history: no video rows');
  if (rows.length >= limit) notes.push(`history: stopped at ${limit}`);
  else if (pages >= MAX_PAGES) notes.push(`history: stopped at ${MAX_PAGES} pages`);
  return { rows, notes };
}

/** A favorite folder's web URL, falling back to the shared `ml` route. */
const folderUrl = (mid: string, mediaId: string, ftype: 'create' | 'collect'): string =>
  mid !== ''
    ? `https://space.bilibili.com/${mid}/favlist?fid=${mediaId}&ftype=${ftype}`
    : `https://www.bilibili.com/list/ml${mediaId}`;

/** A UGC season's web URL. */
const seasonUrl = (mid: string, seasonId: string): string =>
  mid !== ''
    ? `https://space.bilibili.com/${mid}/lists/${seasonId}?type=season`
    : `https://www.bilibili.com/list/${seasonId}?type=season`;

/** The collector's page for a subscribed UGC collection. */
const collectedSeasonUrl = (mid: string, seasonId: string): string =>
  mid !== ''
    ? `https://space.bilibili.com/${mid}/favlist?fid=${seasonId}&ftype=collect&ctype=21`
    : `https://www.bilibili.com/list/${seasonId}?type=season`;

/** The text of one favorite folder row. */
const folderText = (title: string, count: number): string =>
  `${title} · ${count} 个视频`;

/**
 * The account's personal and subscribed lists.
 *
 * Created folders come from `created/list-all`; subscribed folders and UGC seasons
 * both come from `collected/list` and are told apart by `type` (11 folder, 21 season).
 * The endpoint needs `platform=web` to include collections, not just folders. A
 * subscribed row appends its owner's name and links to the collector's own favlist
 * page, so two lists called `收藏` remain two rows.
 *
 * @param args `ctx.args`; `mid` overrides the logged-in account
 * @param opts the test fetch seam
 * @returns one row per list, with the list URL as `ref`
 */
export async function bbLists(
  args: Record<string, unknown> = {},
  opts: BbReadOptions = {},
): Promise<BbOut> {
  const bag = asArgs(args);
  const limit = capOf(bag, 5555);
  try {
    const nav = await bbNav(opts);
    if (!nav.isLogin) return loginOut();
    const mid = str(bag.mid) || nav.mid;
    const rows: BbRow[] = [];
    const notes: string[] = [];
    const seen = new Set<string>();

    const created = asObj(await bbGet('/x/v3/fav/folder/created/list-all', { up_mid: mid }, opts));
    for (const raw of asArr(created?.list)) {
      if (rows.length >= limit) break;
      const item = asObj(raw);
      if (!item) continue;
      const id = str(item.id) || str(item.fid);
      if (id === '') continue;
      const owner = str(item.mid) || mid;
      const ref = folderUrl(owner, id, 'create');
      if (seen.has(ref)) continue;
      seen.add(ref);
      const title = str(item.title);
      const count = num(item.media_count) ?? 0;
      rows.push({
        txt: folderText(title, count),
        ref,
        tags: ['bilibili', 'favlist', 'created'],
        rec: { kind: 'favlist', media_id: id, mid: owner, title, media_count: count },
      });
    }

    let pn = 1;
    let hasMore = true;
    while (hasMore && rows.length < limit && pn <= MAX_PAGES) {
      const data = asObj(await bbGet('/x/v3/fav/folder/collected/list', {
        up_mid: mid, pn, ps: 20, platform: 'web',
      }, opts));
      for (const raw of asArr(data?.list)) {
        if (rows.length >= limit) break;
        const item = asObj(raw);
        if (!item) continue;
        const type = num(item.type) ?? 11;
        const id = str(item.id) || str(item.fid);
        if (id === '') continue;
        const upper = asObj(item.upper);
        const ownerName = str(upper?.name);
        const owner = str(upper?.mid) || str(item.mid) || mid;
        const collector = mid || owner;
        const kind = type === 21 ? 'season' : 'favlist';
        const ref = kind === 'season'
          ? collectedSeasonUrl(collector, id)
          : folderUrl(collector, id, 'collect');
        if (seen.has(ref)) continue;
        seen.add(ref);
        const title = str(item.title);
        const count = num(item.media_count) ?? 0;
        rows.push({
          txt: `${title}${ownerName ? ` - ${ownerName}` : ''} · ${count} 个视频`,
          ref,
          tags: ['bilibili', kind, 'collected'],
          rec: { kind, media_id: id, mid: owner, collector_mid: collector, title, media_count: count, owner: ownerName, type },
        });
      }
      hasMore = bool(data?.has_more);
      pn++;
    }
    if (rows.length >= limit) notes.push(`lists: stopped at ${limit}`);
    else if (hasMore) notes.push(`lists: stopped at ${MAX_PAGES} pages`);
    if (rows.length === 0) notes.push('lists: no list rows');
    return { rows, notes };
  } catch (error) {
    return bbFailure(error);
  }
}

/** One subscribed folder or UGC season. */
interface BbSubList {
  kind: 'favlist' | 'season';
  id: string;
  mid: string;
  title: string;
  count: number;
  owner: string;
}

/**
 * Walk the account's subscribed folders and UGC seasons.
 *
 * `collected/list` carries both kinds; `type: 11` is a folder and `type: 21` a
 * season. The owner's name and id come from `upper`.
 *
 * @param mid the logged-in account
 * @param maxLists the most subscriptions to collect
 * @param opts the test fetch seam
 * @param label the note prefix, `subs` or `feed`
 * @returns the subscriptions and the page-cap note
 */
async function collectedSubscriptions(
  mid: string,
  maxLists: number,
  opts: BbReadOptions,
  label = 'subs',
): Promise<{ lists: BbSubList[]; notes: string[] }> {
  const lists: BbSubList[] = [];
  const notes: string[] = [];
  let pn = 1;
  let hasMore = true;
  while (hasMore && lists.length < maxLists && pn <= MAX_PAGES) {
    const data = asObj(await bbGet('/x/v3/fav/folder/collected/list', {
      up_mid: mid, pn, ps: 20, platform: 'web',
    }, opts));
    for (const raw of asArr(data?.list)) {
      if (lists.length >= maxLists) break;
      const item = asObj(raw);
      if (!item) continue;
      const type = num(item.type) ?? 11;
      const id = str(item.id) || str(item.fid);
      if (id === '') continue;
      const upper = asObj(item.upper);
      lists.push({
        kind: type === 21 ? 'season' : 'favlist',
        id,
        mid: str(upper?.mid) || str(item.mid) || mid,
        title: str(item.title),
        count: num(item.media_count) ?? 0,
        owner: str(upper?.name),
      });
    }
    hasMore = bool(data?.has_more);
    pn++;
  }
  if (hasMore && lists.length >= maxLists) notes.push(`${label}: stopped at ${maxLists} list(s)`);
  else if (hasMore) notes.push(`${label}: stopped at ${MAX_PAGES} pages`);
  return { lists, notes };
}

/**
 * Videos from every subscribed folder and UGC season.
 *
 * The source discovers the subscriptions with `collected/list`, then reads each
 * list through {@link bbList}. A list contributes at most `args.perList` rows
 * (default 20, `0` reads up to the total cap); the total is the entry's `* Max:`,
 * 5555 by default. Rows carry the list title in `rec.sub` and are sorted newest
 * first, which is what lets a feed trim at its previous read.
 *
 * @param args `ctx.args`; `mid` overrides the account, `perList` caps one list
 * @param opts the test fetch seam
 * @returns the subscribed videos, deduped by URL
 */
export async function bbSubs(
  args: Record<string, unknown> = {},
  opts: BbReadOptions = {},
): Promise<BbOut> {
  const bag = asArgs(args);
  const limit = capOf(bag, 5555);
  const requested = num(bag.perList);
  const perList = requested === 0
    ? limit
    : Math.max(1, Math.min(limit, Math.floor(requested ?? 20)));
  try {
    const nav = await bbNav(opts);
    if (!nav.isLogin) return loginOut();
    const mid = str(bag.mid) || nav.mid;
    const collected = await collectedSubscriptions(mid, MAX_ROWS, opts);
    const notes = [...collected.notes];
    if (collected.lists.length === 0) {
      notes.push('subs: no subscribed lists');
      return { rows: [], notes };
    }

    const rows: BbRow[] = [];
    const seen = new Set<string>();
    for (const list of collected.lists) {
      if (rows.length >= limit) break;
      const url = list.kind === 'season'
        ? collectedSeasonUrl(mid, list.id)
        : folderUrl(mid, list.id, 'collect');
      const take = Math.min(perList, limit - rows.length);
      const out = await bbList({ url, limit: take }, opts);
      if (out.needsUser) return out;
      for (const row of out.rows) {
        if (rows.length >= limit) break;
        if (seen.has(row.ref)) continue;
        seen.add(row.ref);
        rows.push({
          ...row,
          dt: stamp(row.rec?.pubtime),
          rec: {
            ...(row.rec ?? {}),
            sub: list.title,
            sub_kind: list.kind,
            sub_id: list.id,
            sub_owner: list.owner,
          },
        });
      }
      for (const note of out.notes) {
        if (note === 'list: no video rows' || note.startsWith('list: stopped at ')) continue;
        notes.push(`subs: ${list.title || list.id}: ${note}`);
      }
    }

    rows.sort((a, b) => (b.dt?.getTime() ?? 0) - (a.dt?.getTime() ?? 0));
    if (rows.length === 0) notes.push('subs: no video rows');
    if (rows.length >= limit) notes.push(`subs: stopped at ${limit}`);
    else if (perList < limit) notes.push(`subs: up to ${perList} per list`);
    return { rows, notes };
  } catch (error) {
    return bbFailure(error);
  }
}

/** The mid a Bilibili space URL names, or ''. */
function spaceMid(raw: string): string {
  const text = raw.trim();
  if (/^\d+$/.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'space.bilibili.com' && host !== 'bilibili.com' && host !== 'www.bilibili.com') {
    return '';
  }
  return url.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1]
    ?? url.pathname.match(/^\/space\/(\d+)(?:\/|$)/)?.[1]
    ?? '';
}

/**
 * The latest video from every folder or collection a space has subscribed to.
 *
 * The input is a space URL (`https://space.bilibili.com/<mid>`), or the same
 * value under the entry's `* URL:`. Each subscribed item yields one row: the
 * video is `ref`, `rec.list` is the collector's `favlist` URL, and the text is
 * prefixed with `[title]（count）`. A collection is read with `ctype=21`, so
 * `bb-list` accepts the same URL directly.
 *
 * @param args `ctx.args`; `url` or the entry's `URL:` names the space
 * @param opts the test fetch seam
 * @returns one latest-video row per subscribed folder or collection
 */
export async function bbFeed(
  args: Record<string, unknown> = {},
  opts: BbReadOptions = {},
): Promise<BbOut> {
  const bag = asArgs(args);
  const rawUrl = str(bag.url) || str(sourceOf(bag).url);
  const mid = spaceMid(rawUrl);
  if (mid === '') {
    return {
      rows: [],
      notes: [],
      needsUser: 'bb-feed needs a space URL: set URL: in the feed\'s ## Setup, pass args.url, or set this entry\'s URL: to https://space.bilibili.com/<mid>',
    };
  }
  const limit = capOf(bag, 5555);
  try {
    const collected = await collectedSubscriptions(mid, MAX_ROWS, opts, 'feed');
    const notes = [...collected.notes];
    if (collected.lists.length === 0) {
      notes.push('feed: no subscribed lists');
      return { rows: [], notes };
    }

    const rows: BbRow[] = [];
    const seen = new Set<string>();
    for (const list of collected.lists) {
      if (rows.length >= limit) break;
      const listUrl = list.kind === 'season'
        ? collectedSeasonUrl(mid, list.id)
        : folderUrl(mid, list.id, 'collect');
      const out = await bbList({ url: listUrl, limit: 1 }, opts);
      if (out.needsUser) return out;
      for (const note of out.notes) {
        if (note === 'list: no video rows' || note.startsWith('list: stopped at ')) continue;
        notes.push(`feed: ${list.title || list.id}: ${note}`);
      }
      const row = out.rows[0];
      if (row === undefined) {
        notes.push(`feed: ${list.title || list.id}: no video`);
        continue;
      }
      if (seen.has(row.ref)) continue;
      seen.add(row.ref);
      const label = list.title || list.id;
      rows.push({
        ...row,
        txt: `[${label}]（${list.count}）${row.txt}`,
        tags: [...new Set(['bilibili', 'feed', 'subscription', ...(row.tags ?? [])])],
        dt: stamp(row.rec?.pubtime),
        rec: {
          ...(row.rec ?? {}),
          list: listUrl,
          list_id: list.id,
          list_title: list.title,
          list_count: list.count,
          list_kind: list.kind,
          collector_mid: mid,
        },
      });
    }

    rows.sort((a, b) => (b.dt?.getTime() ?? 0) - (a.dt?.getTime() ?? 0));
    if (rows.length === 0) notes.push('feed: no video rows');
    if (rows.length >= limit) notes.push(`feed: stopped at ${limit}`);
    return { rows, notes };
  } catch (error) {
    return bbFailure(error);
  }
}

/** The `mid` a Bilibili space URL path carries, or ''. */
const pathMid = (path: string): string => path.match(/^\/(\d+)\//)?.[1] ?? '';

/**
 * The list one URL names.
 *
 * Accepted forms are the ones `bb-lists` writes and the site's own routes:
 *
 *   space.bilibili.com/<mid>/favlist?fid=<id>[&ftype=create|collect][&ctype=21]
 *   bilibili.com/medialist/detail/ml<id>
 *   space.bilibili.com/<mid>/lists/<id>?type=season|series
 *   bilibili.com/list/<id>[?type=season]
 *
 * `ctype=21` is the collector's favlist form of a UGC collection, so it is read
 * through the season endpoint rather than the favorite-folder endpoint.
 *
 * @param raw a list URL, as a `bb-lists` ref or copied from the browser
 * @returns the list kind and id, or null when the URL names none
 */
export function parseListUrl(raw: string): BbListRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'bilibili.com' && !host.endsWith('.bilibili.com')) return null;
  const path = url.pathname;
  const mid = pathMid(path) || str(url.searchParams.get('mid'));

  const detail = path.match(/\/medialist\/detail\/ml(\d+)/);
  if (detail) return { kind: 'fav', mediaId: detail[1], mid };

  const lists = path.match(/\/lists\/(\d+)/);
  if (lists) {
    const type = (url.searchParams.get('type') ?? 'season').toLowerCase();
    return type === 'series'
      ? { kind: 'series', seriesId: lists[1], mid }
      : { kind: 'season', seasonId: lists[1], mid };
  }

  const sharedList = path.match(/\/list\/ml(\d+)/);
  if (sharedList) return { kind: 'fav', mediaId: sharedList[1], mid };

  const list = path.match(/\/list\/(\d+)/);
  if (list) return { kind: 'season', seasonId: list[1], mid };

  const fid = str(url.searchParams.get('fid')) || str(url.searchParams.get('media_id'));
  if (fid !== '') {
    return str(url.searchParams.get('ctype')) === '21'
      ? { kind: 'season', seasonId: fid, mid }
      : { kind: 'fav', mediaId: fid, mid };
  }

  return null;
}

/** A list ref from explicit ids, for a caller that has no URL. */
function manualListRef(args: Record<string, unknown>): BbListRef | null {
  const mid = str(args.mid);
  const mediaId = str(args.media_id) || str(args.mediaId) || str(args.fid);
  if (mediaId !== '') return { kind: 'fav', mediaId, mid };
  const seasonId = str(args.season_id) || str(args.seasonId);
  if (seasonId !== '') return { kind: 'season', seasonId, mid };
  const seriesId = str(args.series_id) || str(args.seriesId);
  if (seriesId !== '') return { kind: 'series', seriesId, mid };
  return null;
}

/** One video row from a favorite folder or a season. */
function videoRow(
  item: Record<string, unknown>,
  tags: string[],
  rec: Record<string, unknown>,
): BbRow | null {
  const title = str(item.title);
  const bvid = str(item.bvid) || str(item.bv_id);
  const aid = str(item.id);
  if (title === '已失效视频' || (bvid === '' && aid === '')) return null;
  const upper = asObj(item.upper);
  const author = str(upper?.name);
  const duration = num(item.duration) ?? 0;
  return {
    txt: `${title}${author ? ` — ${author}` : ''}${duration > 0 ? ` · ${mmss(duration)}` : ''}`,
    ref: bvid !== '' ? `https://www.bilibili.com/video/${bvid}` : `https://www.bilibili.com/video/av${aid}`,
    tags,
    rec: {
      aid,
      bvid,
      author,
      duration,
      pubtime: num(item.pubtime) ?? 0,
      cover: str(item.cover),
      ...rec,
    },
  };
}

/** A favorite folder's items, in the folder's own order. */
async function favoriteItems(
  list: Extract<BbListRef, { kind: 'fav' }>,
  limit: number,
  opts: BbReadOptions,
): Promise<BbOut> {
  const rows: BbRow[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  let pn = 1;
  let hasMore = true;
  while (hasMore && rows.length < limit && pn <= MAX_PAGES) {
    const take = Math.min(20, limit - rows.length);
    const data = asObj(await bbGet('/x/v3/fav/resource/list', {
      media_id: list.mediaId,
      pn,
      ps: take,
      keyword: '',
      order: 'mtime',
      type: 0,
      tid: 0,
      platform: 'web',
    }, opts));
    const medias = asArr(data?.medias);
    for (const raw of medias) {
      if (rows.length >= limit) break;
      const item = asObj(raw);
      if (!item) continue;
      const row = videoRow(item, ['bilibili', 'favlist'], { media_id: list.mediaId });
      if (!row || seen.has(row.ref)) continue;
      seen.add(row.ref);
      rows.push(row);
    }
    hasMore = bool(data?.has_more);
    pn++;
    if (medias.length === 0) break;
  }
  if (rows.length === 0) notes.push('list: no video rows');
  if (rows.length >= limit) notes.push(`list: stopped at ${limit}`);
  else if (hasMore && pn > MAX_PAGES) notes.push(`list: stopped at ${MAX_PAGES} pages`);
  return { rows, notes };
}

/** A UGC season's items; one response carries the whole season. */
async function seasonItems(
  list: Extract<BbListRef, { kind: 'season' }>,
  limit: number,
  opts: BbReadOptions,
): Promise<BbOut> {
  const data = asObj(await bbGet('/x/space/fav/season/list', {
    season_id: list.seasonId,
    pn: 1,
    ps: 40,
    web_location: 333.1387,
  }, opts));
  const rows: BbRow[] = [];
  const seen = new Set<string>();
  /* The season endpoint returns the season's own order, whose first media is the
     list's featured/latest entry; `bbFeed` relies on that first row. */
  for (const raw of asArr(data?.medias)) {
    if (rows.length >= limit) break;
    const item = asObj(raw);
    if (!item) continue;
    const row = videoRow(item, ['bilibili', 'season'], { season_id: list.seasonId });
    if (!row || seen.has(row.ref)) continue;
    seen.add(row.ref);
    rows.push(row);
  }
  const notes: string[] = [];
  if (rows.length === 0) notes.push('list: no video rows');
  if (rows.length >= limit) notes.push(`list: stopped at ${limit}`);
  return { rows, notes };
}

/**
 * The items of one list URL.
 *
 * A favorite folder walks `has_more`; a UGC season returns its whole `medias` list
 * in one response. The list's own order is kept: rows carry no `dt`, so a feed read
 * does not re-sort them by publish time.
 *
 * @param args `ctx.args`; `url` or the entry's `URL:` names the list
 * @param opts the test fetch seam
 * @returns the list's video rows, or `needsUser` when no list URL was given
 */
export async function bbList(
  args: Record<string, unknown> = {},
  opts: BbReadOptions = {},
): Promise<BbOut> {
  const bag = asArgs(args);
  const rawUrl = str(bag.url) || str(sourceOf(bag).url);
  const list = parseListUrl(rawUrl) ?? manualListRef(bag);
  if (!list) {
    return {
      rows: [],
      notes: [],
      needsUser: 'bb-list needs a list URL: set URL: in the feed\'s ## Setup, pass args.url, or set this entry\'s URL: to a row from bb-lists',
    };
  }
  const limit = capOf(bag, 5555);
  try {
    if (list.kind === 'fav') return await favoriteItems(list, limit, opts);
    if (list.kind === 'season') return await seasonItems(list, limit, opts);
    return { rows: [], notes: [`list: series lists are not supported yet: ${rawUrl}`] };
  } catch (error) {
    return bbFailure(error);
  }
}

/** The engine `routes.tsx` installs as `globalThis.bbapi` for a seeded body. */
export interface BbGlobal {
  history: typeof bbHistory;
  lists: typeof bbLists;
  subs: typeof bbSubs;
  feed: typeof bbFeed;
  list: typeof bbList;
  nav: typeof bbNav;
}

/**
 * Publish the readers the seeded bodies call.
 *
 * A `data:`-URL body cannot import this bundle, so it reaches the same functions
 * through this global, exactly as `srcdom/*` reaches `globalThis.srcfeed`.
 */
export function installBbApiGlobal(): void {
  (globalThis as typeof globalThis & { bbapi?: BbGlobal }).bbapi = {
    history: bbHistory,
    lists: bbLists,
    subs: bbSubs,
    feed: bbFeed,
    list: bbList,
    nav: bbNav,
  };
}
