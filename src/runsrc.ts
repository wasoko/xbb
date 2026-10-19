/**
 * runsrc.ts — evaluate the body of a `type='src'` row.
 *
 * Kept apart from `recr.ts` so the evaluator carries no Dexie, React, or DOM
 * import: the same code runs in the webapp page, in a web worker, and in an
 * extension context. The caller supplies whatever the script needs through
 * `ctx`, which is how `run_src` hands over `db` without this module naming it.
 *
 * A body is either a function body (the default) or an ES module; see
 * {@link isModuleSource}.
 *
 * A realm that forbids eval — an MV3 extension page, whose `script-src` cannot
 * carry `'unsafe-eval'` — has two ways to run a row instead: a compiled twin
 * registered for that exact body text, or the tab runner, for rows whose header
 * asks for a live tab. Both are registered by the host, so this module names no
 * `chrome` or DOM API.
 */

import { needsTab, rowMeta, type RowMeta } from './rowMeta';

/**
 * `AsyncFunction` so a script body may `await`; the body still runs in the
 * caller's realm, so a script reaches the same globals the caller does.
 */
const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor as
  new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

/** Which path {@link runBodyWithPath} took: the row text, a compiled twin, or a browser tab. */
export type BodyPath = 'body' | 'twin' | 'tab';

/** Why a row could not run in the realm it was asked for. */
export type SrcUnavailableCode =
  | 'not-extension'    // the row needs a tab, but this host is the webapp
  | 'user-scripts-off' // the extension is present but `chrome.userScripts` is withheld
  | 'no-tab'           // no open tab matches the row's `@match`
  | 'needs-user'       // the page needs one manual step (the row's `@prompt`)
  | 'missing-source'   // no source block and no `@match` named a URL
  | 'eval-blocked';    // no twin, and this realm's CSP refuses eval

/**
 * A row that cannot run here, with the steps that make it runnable.
 *
 * Callers print {@link steps} beside the message so a refusal names a setting or
 * a tab instead of a Content Security Policy.
 */
export class SrcUnavailableError extends Error {
  /**
   * @param code which precondition failed
   * @param message one line naming the row and the missing capability
   * @param steps what the user can do, in order
   */
  constructor(
    readonly code: SrcUnavailableCode,
    message: string,
    readonly steps: string[] = [],
  ) {
    super(message);
    this.name = 'SrcUnavailableError';
  }
}

/** Verdict of the one eval probe this module runs. */
interface EvalVerdict {
  ok: boolean;
  reason?: string;
}

let evalProbe: EvalVerdict | undefined;
let evalOverride: boolean | undefined;

/**
 * Whether this realm lets a row body be compiled with `new Function`.
 *
 * The probe constructs an empty `AsyncFunction` once and caches the verdict. In an
 * MV3 extension page that construction is refused, and the refusal is the answer;
 * nothing is inferred from `typeof chrome`, which is also defined on ordinary
 * pages.
 *
 * @returns true when {@link runBodyWithPath} may evaluate the row text
 */
export function canEvalBody(): boolean {
  if (evalOverride !== undefined) return evalOverride;
  if (evalProbe === undefined) {
    try {
      new AsyncFunction('');
      evalProbe = { ok: true };
    } catch (e) {
      evalProbe = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }
  return evalProbe.ok;
}

/**
 * Why {@link canEvalBody} answered false, for the refusal text.
 *
 * @returns the construction error's message, or undefined when eval works
 */
export function bodyEvalReason(): string | undefined {
  canEvalBody();
  return evalProbe?.reason;
}

/**
 * Force the probe verdict, for tests and for a host that knows better.
 *
 * @param verdict true or false to override, null to probe again
 */
export function setEvalProbe(verdict: boolean | null): void {
  evalOverride = verdict === null ? undefined : verdict;
  if (verdict === null) evalProbe = undefined;
}

/** A compiled counterpart of one exact row body. */
export type BodyTwin = (ctx: RecrScriptContext) => Promise<unknown>;

/** Compiled counterparts, keyed by the body text they replace. */
const bodyTwins = new Map<string, BodyTwin>();

/**
 * Register a compiled counterpart for one exact body text.
 *
 * A row the user edited no longer matches its seed text, so it never runs a twin:
 * the refusal is the only honest answer when the realm cannot eval.
 *
 * @param body exact row text the twin stands in for
 * @param run the compiled implementation
 */
export function registerBodyTwin(body: string, run: BodyTwin): void {
  bodyTwins.set(body, run);
}

/**
 * Register a set of twins, e.g. a seed module's exported map.
 *
 * @param twins body text to compiled implementation
 */
export function registerBodyTwins(twins: ReadonlyMap<string, BodyTwin>): void {
  for (const [body, run] of twins) bodyTwins.set(body, run);
}

/**
 * The twin registered for a body, if any.
 *
 * @param body exact row text
 * @returns the compiled implementation, or undefined
 */
export function bodyTwinFor(body: string): BodyTwin | undefined {
  return bodyTwins.get(body);
}

/** A host that can run a row body inside a live browser tab. */
export type TabBodyRunner = (
  body: string,
  ctx: RecrScriptContext,
  meta: RowMeta,
) => Promise<unknown>;

let tabRunner: TabBodyRunner | undefined;

/**
 * Install (or remove) the tab runner. The extension registers `extsrc`'s.
 *
 * @param run runner to install, null to remove the current one
 */
export function registerTabBodyRunner(run: TabBodyRunner | null): void {
  tabRunner = run ?? undefined;
}

/** Value a `type='src'` body receives: the caller's tables, the row ref, and the call arguments. */
export interface RecrScriptContext {
  /** Page tables the caller chooses to expose; `db` from `sdb` in the webapp. */
  db: unknown;
  ref: string;
  args: unknown;
  console: Console;
}

/**
 * Dynamic `import()` of a specifier that is not a literal. `@vite-ignore` keeps
 * the bundler from trying to resolve a `data:` URL at build time.
 *
 * `new Function`/indirect `eval` cannot carry this: the test environment runs
 * them in a vm context whose `import()` needs a callback Node does not install.
 */
const nativeImport = (u: string): Promise<{ default?: unknown }> =>
  import(/* @vite-ignore */ u) as Promise<{ default?: unknown }>;

/**
 * Whether a `type='src'` body is an ES module rather than a function body.
 *
 * The two are mutually exclusive: `export` is a syntax error inside
 * `AsyncFunction`, and a top-level `return` is a syntax error inside a module.
 * A line whose first token is a static `import` or an `export` names the module
 * form; `import(` and `exports.x` are expressions a function body may hold.
 *
 * @param body row text of a `type='src'` row
 * @returns true when the body opens a line with `import` or `export`
 */
export function isModuleSource(body: string): boolean {
  return /^[ \t]*(?:export(?![$\w])|import(?![$\w(]))/m.test(body);
}

/**
 * Module specifier for a `type='src'` body: a `data:` URL, which browsers and
 * Node both `import()`.
 *
 * The URL carries the whole body, so identical text yields one module instance
 * and module-level state survives a later call that reads the same text. A
 * `data:` module has no base URL, so a relative specifier inside it cannot
 * resolve, and a page whose CSP forbids `script-src data:` refuses it.
 *
 * @param body source text of the module row
 * @returns a `data:text/javascript` URL carrying `body`
 */
export function moduleSourceUrl(body: string): string {
  return 'data:text/javascript;charset=utf-8,' + encodeURIComponent(body);
}

/**
 * Imports a module row and calls its default export with `ctx`.
 *
 * @param body module source text
 * @param ctx value passed to the default export
 * @returns the default export's result
 * @throws when the module exports no default function
 */
async function runModule(body: string, ctx: RecrScriptContext): Promise<unknown> {
  const mod = await nativeImport(moduleSourceUrl(body));
  const fn = mod.default;
  if (typeof fn !== 'function') throw new Error('module row must export a default function(ctx)');
  return await (fn as (ctx: RecrScriptContext) => unknown)(ctx);
}

/**
 * Runs `body` in this realm, on the path its syntax allows.
 *
 * A one-line body such as `let n = 0; export default ...` puts the module
 * keyword off the line start, so the constructor's syntax error is the
 * tie-breaker: it names `export`/`import` only for module-only syntax.
 *
 * @param body row text of a `type='src'` row
 * @param ctx value passed to the script
 * @returns the script's result
 */
async function runInRealm(body: string, ctx: RecrScriptContext): Promise<unknown> {
  if (isModuleSource(body)) return runModule(body, ctx);
  let run: (ctx: RecrScriptContext) => Promise<unknown>;
  try {
    run = new AsyncFunction('ctx', body) as (ctx: RecrScriptContext) => Promise<unknown>;
  } catch (e) {
    if (e instanceof SyntaxError && /\b(?:export|import)\b/.test(e.message)) {
      return runModule(body, ctx);
    }
    throw e;
  }
  return await run(ctx);
}

/**
 * Runs `body` on whichever path this host allows, and says which one ran.
 *
 * Order is deliberate. A row that declares `@requires tab` never runs in the caller's
 * realm — its body reads a live page — even where eval would be available. Otherwise
 * the row text runs whenever the realm can eval, and the twin is consulted only when
 * it cannot.
 *
 * @param body row text of a `type='src'` row
 * @param ctx value passed to the script
 * @returns the result and the path that produced it
 * @throws SrcUnavailableError when no path can run the body here
 */
export async function runBodyWithPath(
  body: string,
  ctx: RecrScriptContext,
): Promise<{ value: unknown; path: BodyPath }> {
  const meta = rowMeta(body);
  if (needsTab(meta)) {
    if (!tabRunner) {
      throw new SrcUnavailableError(
        'not-extension',
        `${ctx.ref} reads a live browser tab and needs the extension`,
        ['Open the app from the Tab Seer extension page and run the row again.'],
      );
    }
    return { value: await tabRunner(body, ctx, meta), path: 'tab' };
  }
  if (canEvalBody()) return { value: await runInRealm(body, ctx), path: 'body' };
  const twin = bodyTwins.get(body);
  if (twin) return { value: await twin(ctx), path: 'twin' };
  throw new SrcUnavailableError(
    'eval-blocked',
    `${ctx.ref} cannot run here: this page's Content Security Policy blocks 'unsafe-eval'`,
    [
      'Run the row from the app opened at its own origin (the webapp, not the extension page).',
      'In the extension, only rows with a compiled counterpart or `@requires tab` can run.',
    ],
  );
}

/**
 * Runs `body` on whichever path this host allows.
 *
 * @param body row text of a `type='src'` row
 * @param ctx value passed to the script
 * @returns the script's result
 * @throws SrcUnavailableError when no path can run the body here
 */
export async function runBody(body: string, ctx: RecrScriptContext): Promise<unknown> {
  return (await runBodyWithPath(body, ctx)).value;
}
