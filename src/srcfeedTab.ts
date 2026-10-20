/**
 * srcfeedTab.ts — the tab port of `srcfeed`.
 *
 * A row whose header says `// @requires tab` reads a live page: the history
 * sidebar, the rendered post list, anything only a browser tab holds. It cannot run
 * in the caller's realm — an MV3 extension page forbids eval, and a webapp has no tab
 * access — so this module runs the body through `chrome.userScripts.execute` in the
 * matching tab. Chrome compiles the code, the extension never does, and the body's
 * `ctx` is `{ ref, args, console }`: it has no Dexie handle, because it runs in the
 * page's origin.
 *
 * The caller resolves the source once: `srcfeed` hands the registry entry as
 * `ctx.args.source`, so this module owns the capability probe, the tab match, the
 * execution and the refusal catalogue — and no document dialect.
 *
 * Everything that can fail is checked before the row runs, and reported with the
 * steps that fix it: not the extension, `chrome.userScripts` withheld, no tab
 * matching the entry's URL, or a manual step the page needs first (the entry's
 * `Prompt`).
 *
 * Adopted from ScriptCat's `checkUserScriptsAvailable` and its user-script path
 * (`src/pkg/utils/utils.ts`, `src/app/service/service_worker/runtime.ts`); see
 * `docs/script-post.md`.
 */

import {
  registerTabBodyRunner, SrcUnavailableError,
  type RecrScriptContext, type SrcUnavailableCode,
} from './runsrc';

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
export interface TabEnv {
  /** True when the page is an extension page. */
  extension: boolean;
  /** True when `chrome.userScripts` answers a register/unregister round-trip. */
  userScripts: boolean;
  /** Why {@link userScripts} is false, for the report. */
  reason?: string;
}

let envCache: Promise<TabEnv> | undefined;

/**
 * Probe the extension capability once per page.
 *
 * The probe follows ScriptCat's: property access, a `getScripts` call, then a
 * register/unregister round-trip, because some Chromium builds expose the API while
 * withholding the permission it needs.
 *
 * @returns the capability verdict, cached after the first call
 */
export function tabEnv(): Promise<TabEnv> {
  return (envCache ??= probeTabEnv());
}

/** Drop the cached verdict, so the next {@link tabEnv} probes again. */
export function resetTabEnv(): void {
  envCache = undefined;
}

/**
 * Probe `chrome.userScripts` without assumptions.
 *
 * @returns the verdict and the first error that made it false
 */
async function probeTabEnv(): Promise<TabEnv> {
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
    const id = `srcfeed-tab-probe-${Date.now()}`;
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
export function tabFailure(
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
          : ['Give the registry entry a `* URL:` pattern the open tab matches.'],
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
        message: detail.reason ?? `${detail.ref} needs its source block`,
        steps: ['Run it through a `.feed.md` source, which passes the registry entry as `ctx.args.source`.'],
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

/** `ctx.args` as an object, for the source block and `showRows`-style options. */
const asArgs = (args: unknown): Record<string, unknown> =>
  (typeof args === 'object' && args !== null ? args as Record<string, unknown> : {});

/**
 * The registry entry a tab row reads, from `ctx.args.source`.
 *
 * @param ctx value of the `run_src` call
 * @returns the entry as the caller resolved it
 * @throws SrcUnavailableError when the caller passed no block or a block with no URL
 */
function sourceOf(ctx: RecrScriptContext): Record<string, unknown> {
  const source = asArgs(ctx.args).source;
  if (typeof source !== 'object' || source === null) {
    const f = tabFailure('missing-source', { ref: ctx.ref });
    throw new SrcUnavailableError('missing-source', f.message, f.steps);
  }
  const block = source as Record<string, unknown>;
  if (String(block.url ?? '') === '') {
    const f = tabFailure('missing-source', { ref: ctx.ref, reason: `${ctx.ref} got a source block with no URL` });
    throw new SrcUnavailableError('missing-source', f.message, f.steps);
  }
  return block;
}

/**
 * The first open tab whose URL matches `pattern`.
 *
 * @param pattern match pattern from the registry entry
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
 * @param ctx value of the `run_src` call; `ctx.args.source` must be the registry entry
 * @returns the body's value, with its console lines appended when it reports `notes`
 * @throws SrcUnavailableError when a precondition is missing
 */
export async function runTabRow(body: string, ctx: RecrScriptContext): Promise<unknown> {
  const env = await tabEnv();
  if (!env.extension) {
    const f = tabFailure('not-extension', { ref: ctx.ref });
    throw new SrcUnavailableError('not-extension', f.message, f.steps);
  }
  if (!env.userScripts) {
    const f = tabFailure('user-scripts-off', { ref: ctx.ref, reason: env.reason });
    throw new SrcUnavailableError('user-scripts-off', f.message, f.steps);
  }
  const source = sourceOf(ctx);
  const tab = await queryTab(String(source.url));
  if (!tab?.id) {
    const f = tabFailure('no-tab', { ref: ctx.ref, url: String(source.url) });
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
      const f = tabFailure('needs-user', { ref: ctx.ref, prompt: needsUser });
      throw new SrcUnavailableError('needs-user', f.message, f.steps);
    }
    const notes = (value as { notes?: unknown }).notes;
    if (Array.isArray(notes) && result.logs?.length) notes.push(...result.logs.slice(0, 20));
  }
  return value;
}

/**
 * Register {@link runTabRow} as `runsrc`'s tab runner.
 *
 * Called once at boot by `src/ui/routes.tsx`, in both hosts: in the webapp it is
 * installed but every call reports `not-extension`, which is the message a webapp
 * user needs.
 */
export function installSrcFeedTabRunner(): void {
  registerTabBodyRunner(runTabRow);
}
