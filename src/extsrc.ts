/**
 * extsrc.ts — the extension-only case of `run_src`.
 *
 * A row whose header says `// @requires tab` reads a live page: the history
 * sidebar, the rendered post list, anything only a browser tab holds. Such a row
 * cannot run in the caller's realm — an MV3 extension page forbids eval, and a
 * webapp has no tab access — so this module runs the body through
 * `chrome.userScripts.execute` in the matching tab. Chrome compiles the code, the
 * extension never does, and the body's `ctx` is `{ ref, args, console }`: it has no
 * Dexie handle, because it runs in the page's origin.
 *
 * Everything that can fail is checked before the row runs, and reported with the
 * steps that fix it: not the extension, `chrome.userScripts` withheld, no tab
 * matching the source URL, or a manual step the page needs first (the source's
 * `Prompt`).
 *
 * Adopted from ScriptCat's `checkUserScriptsAvailable` and its user-script path
 * (`src/pkg/utils/utils.ts`, `src/app/service/service_worker/runtime.ts`); see
 * `docs/script-post.md`.
 */

import { bulletKv, splitSections, subSections } from './recrMd';
import type { RowMeta } from './rowMeta';
import {
  registerTabBodyRunner, SrcUnavailableError,
  type RecrScriptContext, type SrcUnavailableCode,
} from './runsrc';
import type { Da } from './sdb';
import { EXTSRC_REF } from './extsrcRows';

/** One `### name` block of `extsrc.md`. */
export interface ExtSource {
  /** Block name, also the tag each returned row carries. */
  name: string;
  /** Tab URL pattern, in `chrome.tabs.query` match-pattern form. */
  url: string;
  /** Selector of one history entry. */
  item: string;
  /** Selector that must exist before the list can be read. */
  sidebar: string;
  /** Scrolling container to exhaust before reading, when the list is virtualized. */
  scroll: string;
  /** `dom` reads text and href; `html` also carries each element's outerHTML. */
  mode: 'dom' | 'html';
  /** Most rows to return. */
  max: number;
  /** What to tell the user when {@link sidebar} is missing. */
  prompt: string;
  /** Tags beside the source name. */
  tags: string[];
}

/** The parts of `chrome` this module uses; declared locally so no extension types are required. */
interface ExtTab {
  id?: number;
  title?: string;
  url?: string;
}

interface ExtChrome {
  runtime?: { id?: string };
  tabs?: { query(query: { url?: string }): Promise<ExtTab[]> };
  userScripts?: {
    getScripts(filter?: { ids?: string[] }): Promise<Array<{ id?: string }>>;
    register(scripts: unknown[]): Promise<void>;
    unregister(filter: { ids: string[] }): Promise<void>;
    execute(injection: {
      target: { tabId: number };
      js: Array<{ code: string }>;
    }): Promise<Array<{ result?: unknown }>>;
  };
}

/** The browser global, if this realm is a browser page at all. */
const extChrome = (): ExtChrome | undefined =>
  (globalThis as { chrome?: ExtChrome }).chrome;

/** Protocol of the page, or '' where there is no `location` (a worker, a test). */
const pageProtocol = (): string =>
  (globalThis as { location?: { protocol?: string } }).location?.protocol ?? '';

/** Whether this page was loaded from the extension's own origin. */
export function isExtensionPage(): boolean {
  return pageProtocol() === 'chrome-extension:' && !!extChrome()?.runtime?.id;
}

/** What this host can do for a row that needs a tab. */
export interface ExtEnv {
  /** True when the page is an extension page. */
  extension: boolean;
  /** True when `chrome.userScripts` answers a register/unregister round-trip. */
  userScripts: boolean;
  /** Why {@link userScripts} is false, for the report. */
  reason?: string;
}

let envCache: Promise<ExtEnv> | undefined;

/**
 * Probe the extension capability once per page.
 *
 * The probe follows ScriptCat's: property access, a `getScripts` call, then a
 * register/unregister round-trip, because some Chromium builds expose the API while
 * withholding the permission it needs.
 *
 * @returns the capability verdict, cached after the first call
 */
export function extEnv(): Promise<ExtEnv> {
  return (envCache ??= probeExtEnv());
}

/** Drop the cached verdict, so the next {@link extEnv} probes again. */
export function resetExtEnv(): void {
  envCache = undefined;
}

/**
 * Probe `chrome.userScripts` without assumptions.
 *
 * @returns the verdict and the first error that made it false
 */
async function probeExtEnv(): Promise<ExtEnv> {
  if (!isExtensionPage()) return { extension: false, userScripts: false, reason: 'not an extension page' };
  const api = extChrome()?.userScripts;
  if (!api || typeof api.getScripts !== 'function') {
    return { extension: true, userScripts: false, reason: 'chrome.userScripts is unavailable' };
  }
  try {
    const registered = await api.getScripts();
    if (!Array.isArray(registered)) {
      return { extension: true, userScripts: false, reason: 'chrome.userScripts returned no list' };
    }
    if (registered.length > 0) return { extension: true, userScripts: true };
    const id = `extsrc-probe-${Date.now()}`;
    await api.register([{ id, js: [{ code: 'void 0;' }], matches: ['https://not-found.example/*'], world: 'USER_SCRIPT' }]);
    await api.unregister({ ids: [id] });
    return { extension: true, userScripts: true };
  } catch (e) {
    return { extension: true, userScripts: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The message and steps for one refusal.
 *
 * Kept separate from the throwing sites so every caller prints the same instructions
 * and the text can be asserted verbatim.
 *
 * @param code which precondition failed
 * @param detail the row, URL, prompt or probe reason the message names
 * @returns one message and the user's next steps, in order
 */
export function extFailure(
  code: SrcUnavailableCode,
  detail: { ref: string; url?: string; prompt?: string; reason?: string },
): { message: string; steps: string[] } {
  switch (code) {
    case 'user-scripts-off':
      return {
        message: detail.reason
          ? `Allow User Scripts is off for this extension (${detail.reason})`
          : 'Allow User Scripts is off for this extension',
        steps: [
          'Open chrome://extensions and open this extension\'s Details.',
          'Turn on "Allow User Scripts". Chrome 138+ keeps that switch under Developer mode.',
          'Reload the extension, reopen this page, and run the row again.',
          'Reference: https://developer.chrome.com/docs/extensions/reference/api/userScripts',
        ],
      };
    case 'no-tab':
      return {
        message: detail.url ? `no open tab matches ${detail.url}` : `${detail.ref} has no tab to read`,
        steps: detail.url
          ? [`Open ${detail.url} in a tab, then run the row again.`]
          : ['Pass args.source, or declare `// @match <url pattern>` in the row header.'],
      };
    case 'needs-user':
      return {
        message: detail.prompt || 'the page needs one manual step before it can be read',
        steps: ['Focus the matching tab, finish that step, then run the row again.'],
      };
    case 'not-extension':
      return {
        message: `${detail.ref} reads a live browser tab and needs the extension`,
        steps: ['Open the app from the Tab Seer extension page and run the row again.'],
      };
    case 'missing-source':
      return {
        message: detail.reason ?? `${detail.ref} names a source that is not in ${EXTSRC_REF}`,
        steps: [`Seed ${EXTSRC_REF}, or pass args.source as an inline block.`],
      };
    case 'eval-blocked':
      return {
        message: `${detail.ref} cannot run here: this page forbids eval`,
        steps: ['Run the row from the app opened at its own origin.'],
      };
    default:
      return { message: `${detail.ref} cannot run here`, steps: [] };
  }
}

/**
 * Parse an `extsrc.md` document.
 *
 * The dialect is `webfeed.md`'s: `## Sources`, one `### name` block per source, and
 * `* Key: value` bullets. A block without `* URL:` is skipped.
 *
 * @param md document text
 * @returns the sources in document order
 */
export function parseExtSrcDoc(md: string): ExtSource[] {
  const section = splitSections(md).get('Sources');
  if (!section) return [];
  const out: ExtSource[] = [];
  for (const [name, block] of subSections(section)) {
    const kv = bulletKv(block);
    if (!kv.url) continue;
    out.push({
      name,
      url: kv.url,
      item: kv.item ?? '',
      sidebar: kv.sidebar ?? '',
      scroll: kv.scroll ?? '',
      mode: kv.mode === 'html' ? 'html' : 'dom',
      max: Math.max(1, Number(kv.max) || 200),
      prompt: kv.prompt ?? '',
      tags: (kv.tags ?? '').split(/[\s,]+/).filter(Boolean),
    });
  }
  return out;
}

/** `ctx.args` as an object, for the source block and `showRows`-style options. */
const asArgs = (args: unknown): Record<string, unknown> =>
  (typeof args === 'object' && args !== null ? args as Record<string, unknown> : {});

/**
 * One source block, filling the fields the body expects.
 *
 * @param raw inline block from `ctx.args.source`
 * @returns the normalized source
 */
function normalizeSource(raw: Record<string, unknown>): ExtSource {
  return {
    name: String(raw.name ?? raw.source ?? ''),
    url: String(raw.url ?? ''),
    item: String(raw.item ?? ''),
    sidebar: String(raw.sidebar ?? ''),
    scroll: String(raw.scroll ?? ''),
    mode: raw.mode === 'html' ? 'html' : 'dom',
    max: Math.max(1, Number(raw.max) || 200),
    prompt: String(raw.prompt ?? ''),
    tags: Array.isArray(raw.tags)
      ? raw.tags.map(String)
      : String(raw.tags ?? '').split(/[\s,]+/).filter(Boolean),
  };
}

/** The slice of the page tables this module reads. */
interface ExtDb {
  das: { where(index: string): { equals(key: unknown): { toArray(): Promise<Da[]> } } };
}

/**
 * The live `extsrc.md` text, or '' when the store has no such row.
 *
 * @param db the caller's tables, as `ctx.db`
 * @returns document text
 */
async function readExtDoc(db: unknown): Promise<string> {
  const table = (db as Partial<ExtDb> | undefined)?.das;
  if (!table?.where) return '';
  const rows = await table.where('[ref+type]').equals([EXTSRC_REF, 'md']).toArray();
  const live = rows.filter(r => !(r.tags ?? []).includes('[del]'));
  const row = live[live.length - 1] ?? rows[rows.length - 1];
  return row?.txt ?? '';
}

/**
 * The source a row should read: `ctx.args.source` when it is a block, the named block
 * of `extsrc.md` when it is a string, and the row's `@match` header otherwise.
 *
 * @param ctx value of the `run_src` call
 * @param meta the row's parsed header
 * @returns the source block
 * @throws SrcUnavailableError when no source can be resolved
 */
async function resolveSource(ctx: RecrScriptContext, meta: RowMeta): Promise<ExtSource> {
  const args = asArgs(ctx.args);
  const inline = args.source;
  if (typeof inline === 'object' && inline !== null) return normalizeSource(inline as Record<string, unknown>);
  if (typeof inline === 'string') {
    const sources = parseExtSrcDoc(await readExtDoc(ctx.db));
    const hit = sources.find(s => s.name === inline);
    if (!hit) {
      const f = extFailure('missing-source', { ref: ctx.ref, reason: `no source named "${inline}" in ${EXTSRC_REF}` });
      throw new SrcUnavailableError('missing-source', f.message, f.steps);
    }
    return hit;
  }
  if (meta.match) return normalizeSource({ url: meta.match, max: meta.max, prompt: meta.prompt });
  const f = extFailure('missing-source', { ref: ctx.ref });
  throw new SrcUnavailableError('missing-source', f.message, f.steps);
}

/**
 * The first open tab whose URL matches `pattern`.
 *
 * @param pattern match pattern from the source block
 * @returns the tab, or undefined when none matches or the pattern is invalid
 */
async function queryTab(pattern: string): Promise<ExtTab | undefined> {
  const tabs = extChrome()?.tabs;
  if (!tabs) return undefined;
  try {
    return (await tabs.query({ url: pattern }))[0];
  } catch {
    return undefined;
  }
}

/** What the injected wrapper returns. */
interface TabResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  logs?: string[];
}

/**
 * Wrap one row body for `chrome.userScripts.execute`.
 *
 * The wrapper builds the body's `ctx` inside the tab — functions do not cross a
 * structured clone — and turns `console` into a capped log list. Chrome compiles
 * this string; the extension never evaluates it.
 *
 * @param body exact row text
 * @param ctx the ref and arguments to hand the body
 * @returns one expression whose value is a promise of {@link TabResult}
 */
export function wrapTabBody(body: string, ctx: { ref: string; args: unknown }): string {
  const ref = JSON.stringify(ctx.ref);
  const args = JSON.stringify(ctx.args ?? {});
  return `(async () => {
  const logs = [];
  const sink = (level) => (...a) => {
    if (logs.length >= 200) return;
    logs.push(level + ': ' + a.map((x) => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { return String(x); } }).join(' '));
  };
  const ctx = { ref: ${ref}, args: ${args}, console: { log: sink('log'), info: sink('info'), warn: sink('warn'), error: sink('error'), debug: sink('debug') } };
  try {
    const value = await (async (ctx) => { ${body} })(ctx);
    return { ok: true, value, logs };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), logs };
  }
})()`;
}

/**
 * Run one row in its matching tab.
 *
 * @param body exact row text
 * @param ctx value of the `run_src` call
 * @param meta the row's parsed header
 * @returns the body's value, with its console lines appended when it reports `notes`
 * @throws SrcUnavailableError when a precondition is missing
 */
export async function runExtRow(body: string, ctx: RecrScriptContext, meta: RowMeta): Promise<unknown> {
  const env = await extEnv();
  if (!env.extension) {
    const f = extFailure('not-extension', { ref: ctx.ref });
    throw new SrcUnavailableError('not-extension', f.message, f.steps);
  }
  if (!env.userScripts) {
    const f = extFailure('user-scripts-off', { ref: ctx.ref, reason: env.reason });
    throw new SrcUnavailableError('user-scripts-off', f.message, f.steps);
  }
  const source = await resolveSource(ctx, meta);
  const tab = await queryTab(source.url);
  if (!tab?.id) {
    const f = extFailure('no-tab', { ref: ctx.ref, url: source.url });
    throw new SrcUnavailableError('no-tab', f.message, f.steps);
  }
  const code = wrapTabBody(body, { ref: ctx.ref, args: { ...asArgs(ctx.args), source } });
  let injections: Array<{ result?: unknown }>;
  try {
    injections = await extChrome()!.userScripts!.execute({ target: { tabId: tab.id }, js: [{ code }] });
  } catch (e) {
    throw new Error(`${ctx.ref} could not run in tab ${tab.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const result = injections?.[0]?.result as TabResult | undefined;
  if (!result || typeof result !== 'object') {
    throw new Error(`${ctx.ref} returned nothing from tab ${tab.id}`);
  }
  if (!result.ok) throw new Error(`${ctx.ref} failed in tab ${tab.id}: ${result.error ?? 'unknown error'}`);
  const value = result.value;
  if (typeof value === 'object' && value !== null) {
    const needsUser = (value as { needsUser?: unknown }).needsUser;
    if (typeof needsUser === 'string' && needsUser) {
      const f = extFailure('needs-user', { ref: ctx.ref, prompt: needsUser });
      throw new SrcUnavailableError('needs-user', f.message, f.steps);
    }
    const notes = (value as { notes?: unknown }).notes;
    if (Array.isArray(notes) && result.logs?.length) notes.push(...result.logs.slice(0, 20));
  }
  return value;
}

/**
 * Register {@link runExtRow} as `runsrc`'s tab runner.
 *
 * Called once at boot by `src/ui/routes.tsx`, in both hosts: in the webapp it is
 * installed but every call reports `not-extension`, which is the message a webapp
 * user needs.
 */
export function installExtSrcRunner(): void {
  registerTabBodyRunner(runExtRow);
}
