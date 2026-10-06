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
 */

/**
 * `AsyncFunction` so a script body may `await`; the body still runs in the
 * caller's realm, so a script reaches the same globals the caller does.
 */
const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor as
  new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

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
 * Runs `body` on the path its syntax allows.
 *
 * A one-line body such as `let n = 0; export default ...` puts the module
 * keyword off the line start, so the constructor's syntax error is the
 * tie-breaker: it names `export`/`import` only for module-only syntax.
 *
 * @param body row text of a `type='src'` row
 * @param ctx value passed to the script
 * @returns the script's result
 */
export async function runBody(body: string, ctx: RecrScriptContext): Promise<unknown> {
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
