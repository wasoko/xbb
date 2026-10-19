# Script posting (`run_src` bodies outside the webapp)

`routes.tsx` boots the app in two hosts: the webapp (its own origin, `http://localhost:5173`
in dev) and, through `tabext`, an MV3 options page (`chrome-extension://<id>/options.html`).
Everything a `type='src'` row can drive — the feed read, the tag adapters, a custom rest
grouper, `recr`'s `run_src` tool — goes through one evaluator, `src/runsrc.ts`, and that
evaluator needs a realm allowed to eval. The webapp is; an extension page is not.

This file gathers the facts, the prior art that settles the design, the minimal change
shipped now, and the bridge deferred to the future host.

## The constraint

`tabext/ext/manifest.json:68` sets

```
"extension_pages": "script-src 'self' 'wasm-unsafe-eval' http://localhost ; object-src 'self' ;"
```

so `runBody`'s two branches fail there:

| branch | needs | fails with |
|---|---|---|
| `new AsyncFunction('ctx', body)` | `'unsafe-eval'` | `Evaluating a string as JavaScript violates the following Content Security Policy directive … script-src 'self' 'wasm-unsafe-eval' http://localhost` |
| `import('data:text/javascript,…')` | `data:` under `script-src` | refused by the same header (already noted in `moduleSourceUrl`'s JSDoc) |

`'unsafe-eval'` cannot be added: MV3 refuses it in `extension_pages` at load. The app is
bundled as `ext/built.out/routes.js` (the options page) and is the only bundle carrying
`runsrc`; `bg.js` carries neither `recr` nor `runsrc`, so the service worker never evaluates
a row today and must not start.

## Who calls `runBody`, and what a blocked realm does

| Call site | Row | After M1 |
|---|---|---|
| `src/ui/wFeedRun.ts` | `webfeed/extract.js` | the compiled twin runs; `notes` say so and the readout keeps its items |
| `src/srctag.ts` (`loadTagAdapter` ← `loadAdaptersFromStore`) | `srctag/embed.js`, `srctag/classify.js` | no twin exists, so the row is skipped with the named refusal; the sweep keeps the lexical channels and `hashEmbed` |
| `src/ui/restGrouper.ts` | a custom `type='src'` grouper row | the refusal is logged and the list falls back to flat; the default `qarf` never evals |
| `src/recr.ts` (`run_src`) | any `type='src'` row | the twin, or a refusal that lists the steps; a `@requires tab` row goes to the extension's tab runner |

The default boot path needs one thing only: the feed read. Nothing else breaks silently —
but three of the four failures reach a user or a model as a raw Chrome message.

## Prior art: ScriptCat

ScriptCat (`scriptscat/scriptcat`) is an MV3 userscript manager with the same problem —
arbitrary user code, a CSP that forbids eval — and its answer is uniform: **compile once,
execute only in a realm that may eval, and bridge the privileged objects into it.**

DeepWiki: [overview](https://deepwiki.com/scriptscat/scriptcat),
[extension architecture](https://deepwiki.com/scriptscat/scriptcat/1.1-extension-architecture),
[sandbox environment](https://deepwiki.com/scriptscat/scriptcat/3.2-sandbox-environment).

| # | Mechanism | Code |
|---|---|---|
| 1 | All three execution paths share one compilation step: `with(arguments[0]\|\|this.$){ … return (async function(){ <user code> }).call(this); }`, compiled with `new Function` | `src/app/service/content/utils.ts`, `src/app/service/content/exec_script.ts`, [architecture-execution.md](https://github.com/scriptscat/scriptcat/blob/main/docs/references/architecture-execution.md) |
| 2 | Page scripts go to Chrome's own compiler, `chrome.userScripts.register(...)` in the `MAIN`/`USER_SCRIPT` world, and the extension sets *that world's* CSP | `src/app/service/service_worker/runtime.ts` (`configureWorld({ csp: "script-src 'self' 'unsafe-inline' 'unsafe-eval' *", messaging: true })`) |
| 3 | Background and scheduled scripts get no page: the service worker asks the offscreen document to host them and it forwards evaluation into the **sandbox iframe** | `src/app/service/sandbox/runtime.ts` (`execScript`, `BgExecScriptWarp`, cron map), Path B/C in architecture-execution.md |
| 4 | The sandbox page is declared, not configured: `"sandbox": { "pages": ["src/sandbox.html"] }` | `src/manifest.json` |
| 5 | On Chrome they write **no** sandbox CSP — the Chrome build deletes `content_security_policy.sandbox` and relies on Chrome's default, which allows `'unsafe-eval'`; only Firefox gets the explicit string | `scripts/build-config.js` (`createChromeManifest`, `FIREFOX_SANDBOX_CSP`, `applyFirefoxSandboxManifest`) |
| 6 | Privileged objects are never copied into the eval realm — `GM_*` reaches it over their message channel — because a sandboxed page has an opaque origin: no `chrome.*`, no extension storage | `message_serialization: "structured_clone"` in `src/manifest.json` |
| 7 | Availability is probed, never assumed: property access, then a method call, then a register/unregister round-trip, with a Vivaldi carve-out; their e2e flips the user toggle in a throwaway profile | `src/pkg/utils/utils.ts` (`checkUserScriptsAvailable`), `e2e/README.md`, `e2e/fixtures.ts` (`chrome.developerPrivate.updateExtensionConfiguration({ userScriptsAccess: true })`) |
| 8 | Their agent's `execute_script` tool has two targets and says which is which: `page` (`chrome.scripting.executeScript`, cannot be interrupted, timeout only stops the caller waiting) and `sandbox` (isolated, genuinely cancelled) | `src/app/service/agent/core/tools/execute_script.ts` |

**Essence in one line:** the body is compiled once and executed only in a realm that may
eval — a page's user-script world, or a sandboxed extension page — with privileged objects
reaching it over a message channel.

Paths in the table are relative to `scriptscat/scriptcat` at
[`125d58b5`](https://github.com/scriptscat/scriptcat/tree/125d58b5); the wiki pages are
[overview](https://deepwiki.com/scriptscat/scriptcat),
[extension architecture](https://deepwiki.com/scriptscat/scriptcat/1.1-extension-architecture),
[script execution environment](https://deepwiki.com/scriptscat/scriptcat/3-script-execution-environment),
[sandbox environment](https://deepwiki.com/scriptscat/scriptcat/3.2-sandbox-environment),
[tool system](https://deepwiki.com/scriptscat/scriptcat/8.2-tool-system-and-mcp-integration).

## Which realm can do what

| realm | eval | owns the app's `tagDB_0` | reachable from the options page |
|---|---|---|---|
| webapp page (own origin) | yes | yes, when it is the origin the app was opened at | n/a |
| extension page (options, popup) | no | yes | itself |
| service worker | no | yes | yes, but no DOM |
| offscreen document | no — an extension page | yes | yes |
| content script / `world:'MAIN'` | page-dependent | no — the page's origin | only on http(s) tabs |
| `chrome.userScripts` world | yes (CSP set by `configureWorld`) | no — the target page's origin | only on http(s) tabs |
| sandboxed page (`sandbox.pages` + iframe) | yes | no — opaque origin | yes, by message only |

The app's store is the reason the escape hatches do not compose: eval and `ctx.db` only
coincide in a page the app itself owns.

## M1 — shipped now: probe, twins, honest reasons

The change is transparent by construction: `runsrc` keeps both existing branches untouched
whenever the realm can eval, and the webapp never consults anything new.

| File | Change |
|---|---|
| `src/rowMeta.ts` | the `// @requires` / `@match` / `@max` / `@prompt` parse; stops at the first body line |
| `src/runsrc.ts` | `canEvalBody()` — probe once, cache verdict and reason (the `checkUserScriptsAvailable` shape); `registerBodyTwin`/`registerBodyTwins` keyed by **exact body text**; `runBodyWithPath` returns the path (`body`/`twin`/`tab`); `runBody` delegates; `SrcUnavailableError` carries `code` and `steps`; the constructor-syntax-error tie-breaker is unchanged |
| `src/webfeedRows.ts` | `webFeedReport` + `WEBFEED_BODY_TWINS` for `WEBFEED_EXTRACT_BODY`: the body's own call to `extractFromDoc`, with the same `sources` lines and `showRows` slice |
| `src/ui/routes.tsx` | `registerBodyTwins(WEBFEED_BODY_TWINS)` and `installExtSrcRunner()` beside the two `install*Global()` calls |
| `src/ui/wFeedRun.ts` | uses the traced form and appends `ran the compiled body…` to `notes` when the twin ran |
| `src/recr.ts` | `run_src` uses the traced form, appends the path, and prints `SrcUnavailableError.steps`; the tool description names `@requires tab` |
| `src/extsrc.ts`, `src/extsrcRows.ts` | the tab runner, its capability probe and failure catalogue, plus the seeded `extsrc.md`/`extsrc/extract.js` — see [extsrc.md](extsrc.md) |

Deliberately not in M1: a twin for `srctag/embed.js` and `srctag/classify.js`. Their body
*is* the implementation (read the provider block out of `secret.md`, call the API, return an
adapter), so there is no compiled equivalent to route to; in an extension page they stay
skipped by `loadAdaptersFromStore`, which already reports that and keeps the lexical
channels. No twin means no eval, and a user-edited body is never swapped for different code:
the match is exact text, so one edited character means refusal, not a silent substitute.

```mermaid
flowchart TD
  A["runBody(body, ctx)"] --> B{"canEvalBody()"}
  B -- yes --> C["webapp, worker, tests:<br/>AsyncFunction / data: import"]
  B -- no --> D{"twin registered<br/>for this exact text?"}
  D -- yes --> E["compiled twin<br/>runs in the caller's realm, real ctx.db"]
  D -- no --> F["SrcEvalBlockedError:<br/>names the CSP and the host that can run it"]
```

The cost is one honest gap: in the extension an **edited** `webfeed/extract.js` does not run.
That is what M2 exists to close.

### extsrc — the `run_src` case that needs a tab

A row whose header says `// @requires tab` never takes any of the three paths above:
`runsrc` hands it to the tab runner, which checks the extension, checks
`chrome.userScripts`, matches a tab, and hands the body to
`chrome.userScripts.execute`. Chrome compiles that body; the extension never evaluates
it. The row stays `type='src'`, stays behind the `rwr` gate, and needs no new tool —
`run_src` already offers it. Details and the failure catalogue: [extsrc.md](extsrc.md).

## M2 — deferred: a script post for the greet service host

The bridge waits for the host it belongs to: a responsive-hooked greet service host on
tabext, which is long-lived and can hold one frame for every caller instead of one per read.

- `ext/sandbox.html` + a sandbox host entry in `tabext/esbuild.mjs`; manifest gains
  `"sandbox": { "pages": ["sandbox.html"] }`. Chrome needs no sandbox CSP entry (ScriptCat's
  Chrome build ships without one); the existing `content_security_policy.sandbox` string is
  kept only for parity and would be the place `'unsafe-eval'` goes for Firefox.
- The host imports `runsrc` unchanged. Same-origin is impossible — a sandboxed page gets an
  opaque origin — so the frame is framed by the options page and reached by `postMessage`:
  `{ id, body, ctx: { ref, args } }` in, `{ id, ok, value | error }` out, with `console`
  lines streamed as they are written.
- `ctx.db` becomes a port shaped like `dexieTagPort` (`src/srctag.ts:2614`, which already
  narrows Dexie to one operation for the tagger): the frame asks, the parent answers. The ops
  are only the ones rows use — `where('[ref+type]').equals(k).toArray()`, `toArray`, `get`,
  `add`, `update`, and the `where('type').equals(t).toArray()` the feed's `existingRows`
  needs. Values cross by structured clone; a body returning a DOM node or a function is
  refused by name.
- Cancellation comes free: dropping or reloading the frame stops a body that never settles,
  which `run_src` cannot do today in any realm. ScriptCat's `target:'sandbox'` makes the same
  trade against its uninterruptible `target:'page'`.
- Rejected: the service worker (no eval, no DOM, and ScriptCat keeps evaluation out of its
  own), the offscreen document (an extension page; ScriptCat uses it only as a DOM-capable
  host forwarding into the sandbox), and `chrome.userScripts` for the app's own store (its
  world belongs to the target page's origin, so `tagDB_0` and `embs` there are a different
  database). `chrome.userScripts` **is** what `extsrc` uses, precisely because an `extsrc`
  row reads a page and owns no store.

## Verifying

1. A scratch copy of `ext/manifest.json` with `'unsafe-eval'` added to `extension_pages`:
   confirm Chrome refuses to load it, so the header is not a knob.
2. Options page: `new Function('return 1')()` throws; a scratch `sandbox.pages` frame runs it;
   `indexedDB.open('tagDB_0')` inside that frame opens an empty database — the measurement
   that justifies M2's port.
2. `test/runsrc.test.ts` (new): the selection is a pure function of `(body, canEval)` — twin on
   exact text, refusal on an edited body, refusal on an unknown body, and no twin consulted
   when eval is available.
3. `test/startagfeed/wFeedRun.test.ts`: a read with eval blocked reports the compiled path in
   `notes` and the same items as the row-text read.
4. Real hosts: a feed read in the options page (compiled path) beside the same read at
   `http://localhost:5173` (row text), plus `test/srctag-cdp.test.ts` untouched.
5. tabext's `node_modules` in this checkout is Windows-only, so the extension build and load
   stay a Windows-side step; only `npx tsc --noEmit` runs here.

## Open questions

1. Does the future greet host own the frame, or does the options page keep one and hand it
   over? (Both work; the port's owner decides who answers `ctx.db` calls.)
2. Is an edited `webfeed/extract.js` expected to run in the extension before M2 exists — if so,
   M2 moves ahead of the host and grows the port M1 does not need.
3. The `srctag` adapter rows stay skipped in an extension page until M2; is that acceptable for
   a sweep run from the options page, or should a twin for the built-in provider walk be added
   to `srctag.ts` as a separate change?
