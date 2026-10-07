/**
 * srctagRows.ts — the `type='src'` and `type='md'` rows that give `srctag` an
 * embedding channel, a classifier channel, and a neighbourhood comparison, as text
 * a caller can seed.
 *
 * Each body runs through `runsrc.runBody` with `ctx = { db, ref, args, console }`.
 * A `data:` module has no base URL, so a body cannot import anything: the secret
 * reader and the response normalization are inlined in each body, and the two
 * adapter bodies repeat them on purpose.
 *
 * A body resolves its endpoint from `secret.md` — the dialect `recr.parseSecrets`
 * reads — under `## Providers` / `### <name>`:
 *
 *   ### cfw
 *   * Base URL: https://api.cloudflare.com/client/v4/accounts/<acct>/ai/run
 *   * Models:
 *     - bge: @cf/baai/bge-m3
 *   * API Keys:
 *     - main: <token>
 *
 * `ctx.args` picks the provider and model alias, so a sweep can run
 * `run_src('srctag/embed.js', { provider: 'ere', model: 'nbed' })`.
 *
 * `srctag/suggest.js` is the third body and results in a report rather than an
 * adapter: `run_src` hands that report to the model as the tool result. It owns no
 * scoring, reaching `srctag`'s fusion through `globalThis.srctag`. `srctag/suggest-ds.js`
 * is the same body with its API channels defaulted to the `ds` provider.
 *
 * Nothing here is written automatically: `seedTagRows` is the caller's step.
 */

import {
  SRCTAG_CLASSIFY_REF, SRCTAG_EMBED_REF, SRCTAG_KEYWORDS_REF, SRCTAG_SUGGEST_DS_REF,
  SRCTAG_SUGGEST_REF,
} from './srctag';

/** One row to seed. */
export interface TagSeedRow {
  ref: string;
  type: 'src' | 'md';
  txt: string;
  tags: string[];
}

/** Shared body prefix: read one provider block out of `secret.md` through `ctx.db`. */
const READ_PROVIDER = `// secret.md is a row of this store; no import can reach it from a data:-URL module.
async function readSecret(ctx, provider, modelAlias) {
  const rows = await ctx.db.das.where('[ref+type]').equals(['secret.md', 'md']).toArray();
  const live = rows.filter(function (r) { return !(r.tags || []).includes('[del]'); });
  const row = live[live.length - 1] || rows[rows.length - 1];
  if (!row) throw new Error('no secret.md row (ref=secret.md, type=md)');
  const md = row.txt || '';

  // '### name' blocks, each ending at the next '###' or '##'
  const blocks = {};
  let name = null;
  let buf = [];
  const flush = function () { if (name) blocks[name] = buf.join('\\n'); buf = []; };
  for (const line of md.split('\\n')) {
    const h3 = line.match(/^###\\s+(.+?)\\s*$/);
    if (h3) { flush(); name = h3[1]; continue; }
    if (/^##\\s+/.test(line)) { flush(); name = null; continue; }
    if (name) buf.push(line);
  }
  flush();

  const body = blocks[provider];
  if (!body) {
    const found = Object.keys(blocks).join(', ') || 'none';
    throw new Error('provider "' + provider + '" not in secret.md (found: ' + found + ')');
  }

  // '- alias: value' entries under the '* Label:' bullet they follow
  function listed(label) {
    const out = {};
    let on = false;
    for (const line of body.split('\\n')) {
      if (new RegExp('^\\\\*\\\\s*' + label + ':', 'i').test(line)) { on = true; continue; }
      if (/^\\*/.test(line)) on = false;
      const m = on && line.match(/^\\s*-\\s*([^:]+):\\s*(.+)$/);
      if (m) out[m[1].trim()] = m[2].trim();
    }
    return out;
  }

  const baseUrl = (body.match(/^\\*\\s*Base URL:\\s*(.+)$/mi) || [])[1];
  if (!baseUrl) throw new Error('provider "' + provider + '" has no "Base URL"');
  const models = listed('Models');
  if (!modelAlias) modelAlias = Object.keys(models)[0];
  const model = models[modelAlias];
  if (!model) {
    throw new Error('model "' + modelAlias + '" not in provider "' + provider
      + '" (found: ' + (Object.keys(models).join(', ') || 'none') + ')');
  }
  const keys = listed('API Keys');
  const apiKey = keys[Object.keys(keys)[0]];
  return { baseUrl: baseUrl.replace(/\\/+$/, ''), model: model, apiKey: apiKey, provider: provider };
}`;

/**
 * Body of `srctag/embed.js`: an {@link EmbedFn} over one provider.
 *
 * The request shape follows the Base URL: a `/ai/run` root is Cloudflare's
 * `{ text: [...] }` -> `result.data`; anything else is the OpenAI-compatible
 * `{ model, input, encoding_format }` -> `data[].embedding`. `ctx.args.shape`
 * overrides the guess.
 */
export const SRCTAG_EMBED_BODY = `${READ_PROVIDER}

const args = ctx.args || {};
const provider = args.provider || 'cfw';
const modelAlias = args.model || 'bge';
const shape = args.shape;

// The secret is read per call, not at load: a missing provider or key then lands in
// the caller's report instead of making the whole adapter row silently unloadable.
return async function embed(texts) {
  const cfg = await readSecret(ctx, provider, modelAlias);
  const cloudflare = shape ? shape === 'cloudflare' : /\\/ai\\/run/.test(cfg.baseUrl);
  ctx.console.log('[srctag] embed', provider, modelAlias, cfg.model, cloudflare ? 'cloudflare' : 'openai');

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;

  let url;
  let body;
  if (cloudflare) {
    url = cfg.baseUrl + '/' + cfg.model;
    body = { text: texts };
  } else {
    url = /\\/v1$/.test(cfg.baseUrl) ? cfg.baseUrl + '/embeddings' : cfg.baseUrl + '/v1/embeddings';
    body = { model: cfg.model, input: texts, encoding_format: 'float' };
  }

  const res = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(res.status + ' ' + res.statusText + ': ' + (await res.text()).slice(0, 200));
  const json = await res.json();

  const data = cloudflare
    ? (json && json.result && json.result.data) || (json && json.data)
    : json && json.data;
  if (!Array.isArray(data) || data.length === 0) throw new Error('no vectors in the response');
  if (cloudflare) return data;
  return data.slice()
    .sort(function (a, b) { return (a.index || 0) - (b.index || 0); })
    .map(function (r) { return r.embedding; });
};`;

/**
 * Body of `srctag/classify.js`: a {@link ClassifyFn} over classifier.dev's
 * `POST {base}/v1/classify` (`{ inputs, labels, instructions }`).
 *
 * Each reply is normalized to `{ tag, score }`, accepting `{ label, score }`,
 * `{ labels: [...] }`, `{ results: [...] }`, and a bare array of either shape.
 */
export const SRCTAG_CLASSIFY_BODY = `${READ_PROVIDER}

const args = ctx.args || {};
const provider = args.provider || 'cjev';
const modelAlias = args.model || '';
const instructions = args.instructions
  || 'Pick the single best-fitting label and give a 0-1 confidence.';

function one(v) {
  if (typeof v === 'string') return { tag: v, score: 1 };
  if (!v || typeof v !== 'object') return null;
  const tag = v.tag !== undefined ? v.tag : v.label;
  if (typeof tag !== 'string') return null;
  return { tag: tag, score: typeof v.score === 'number' ? v.score : 1 };
}

function normalize(json) {
  const list = (json && (json.labels || json.results || json.outputs)) || json;
  const arr = Array.isArray(list) ? list : [list];
  const out = [];
  for (const v of arr) {
    const hit = one(v);
    if (hit) out.push(hit);
  }
  return out;
}

// Read per call, like the embedding row, so a bad provider surfaces to the caller.
return async function classify(text, labels) {
  const cfg = await readSecret(ctx, provider, modelAlias);
  const url = /\\/v1\\/classify$/.test(cfg.baseUrl) ? cfg.baseUrl : cfg.baseUrl + '/v1/classify';
  ctx.console.log('[srctag] classify', provider, url);

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ inputs: [text], labels: labels, instructions: instructions }),
  });
  if (!res.ok) throw new Error(res.status + ' ' + res.statusText + ': ' + (await res.text()).slice(0, 200));
  return normalize(await res.json());
};`;

/**
 * `srctag/keywords.md` in the {@link parseKeywordDoc} dialect: a `## tag` heading
 * followed by the surface forms that should match it.
 */
export const SRCTAG_KEYWORDS_DOC = `## machine learning
- ml
- 机器学习

## machine-learning
- 深度学习

## react
- reactjs
- 反应

## vue
- vuejs
- vue3
`;

/**
 * Builds a suggest body whose API channels resolve through `defaults` unless
 * `ctx.args` names another provider or model.
 *
 * @param defaults provider and model alias baked into the row; `{}` leaves the
 *   adapters to their own defaults, which is `srctag/embed.js`'s `cfw` and
 *   `srctag/classify.js`'s `cjev`
 * @returns the body text a `type='src'` row holds
 */
function suggestBody(defaults: { provider?: string; model?: string }): string {
  return `// The lexical channels live in srctag.ts and a data:-URL body cannot import them, so
// this reads them off globalThis.srctag (installSrctagGlobal, ui/routes.tsx). Only the
// row plumbing and the comparison belong here.
const DEFAULTS = ${JSON.stringify(defaults)};
const args = (ctx && ctx.args) || {};
const api = typeof globalThis !== 'undefined' ? globalThis.srctag : undefined;
if (!api || typeof api.tagRows !== 'function') {
  return { error: 'globalThis.srctag is not installed: ui/routes.tsx must run installSrctagGlobal()' };
}

// The API channels are the srctag/*.js rows, which read their provider out of ctx.args:
// naming one here is what makes this row's flavour differ from the generic one.
const provider = args.provider || DEFAULTS.provider;
const model = args.model || DEFAULTS.model;

const DEL = '[del]';
const isLive = function (r) { return (r.tags || []).indexOf(DEL) < 0; };
const withDim = function (dim, extra) {
  return Object.assign({ window: { dim: dim } }, extra);
};

// Working set: newest tid first, so limit keeps the rows the UI shows.
const all = (await ctx.db.das.toArray()).filter(isLive);
all.sort(function (a, b) { return (b.tid || 0) - (a.tid || 0); });
const limit = typeof args.limit === 'number' ? args.limit : 300;
let rows = all.slice(0, limit);
if (Array.isArray(args.tids) && args.tids.length > 0) {
  rows = rows.filter(function (r) { return args.tids.indexOf(r.tid) >= 0; });
}

// High-priority pages are the pin md cards: the #tag headings pinPriorityTags reads.
const isPin = function (r) { return r.type === 'md' && String(r.ref || '').indexOf('pin') === 0; };
const pins = rows.filter(isPin);
const priorityTags = api.pinPriorityTags(pins);

// A pin card is where tags come from, so it supplies the priority tags without being
// scored itself; the rest list does the same by hiding the refs its cards already render.
rows = rows.filter(function (r) { return !isPin(r); });

// The keywords doc is local: its surface forms feed the trie and name the classifier labels.
const synonyms = {};
let labels = Array.isArray(args.labels) ? args.labels.slice(0, 40) : undefined;
const readRows = async function (ref, type) {
  const found = await ctx.db.das.where('[ref+type]').equals([ref, type]).toArray();
  const live = found.filter(isLive);
  return live.length > 0 ? live[live.length - 1] : undefined;
};
const keywords = await readRows('srctag/keywords.md', 'md');
if (keywords && keywords.txt) {
  for (const entry of api.parseKeywordDoc(keywords.txt)) {
    if (entry.keywords.length > 0) synonyms[entry.tag] = entry.keywords;
  }
  if (!labels) labels = Object.keys(synonyms);
}

// The API channels are the seeded srctag/*.js rows; a missing row is a normal state.
const notes = [];
if (provider) {
  notes.push('API channels resolve through provider "' + provider + '"'
    + (model ? ' model "' + model + '"' : ''));
}
let embed;
let classify;
if (args.adapters !== false) {
  const loaded = await api.loadAdaptersFromStore({
    readScript: async function (ref) {
      const row = await readRows(ref, 'src');
      return row ? row.txt : undefined;
    },
  }, Object.assign({}, ctx, { args: Object.assign({}, args, { provider: provider, model: model }) }));
  embed = loaded.embed;
  classify = loaded.classify;
  if (!embed) notes.push('no srctag/embed.js loaded: embedding channel off');
  if (!classify) notes.push('no srctag/classify.js loaded: classifier channel off');
} else {
  notes.push('adapters: false in args: lexical channels only, no provider called');
}
if (!classify) labels = undefined;

const topK = typeof args.topK === 'number' ? args.topK : 5;
const bucketLimit = typeof args.bucketLimit === 'number' ? args.bucketLimit : 12;
const channels = {
  priorityTags: priorityTags, synonyms: synonyms,
  embed: embed, classify: classify, labels: labels,
  score: args.score || undefined,
};

/** One rule's suggestions, folded into counts. The rule's own order is dropped. */
function summarize(key, results) {
  const hits = {};
  let suggested = 0;
  let sum = 0;
  let max = 0;
  let priorityHits = 0;
  for (const result of results) {
    for (const s of result.suggestions) {
      suggested++;
      sum += s.score;
      if (s.score > max) max = s.score;
      const held = hits[s.tag] || { tag: s.tag, count: 0, score: 0 };
      held.count++;
      if (s.score > held.score) held.score = s.score;
      hits[s.tag] = held;
      if (priorityTags.indexOf(s.tag) >= 0) priorityHits++;
    }
  }
  const ranked = Object.keys(hits).map(function (t) { return hits[t]; })
    .sort(function (a, b) {
      return (b.count - a.count) || (b.score - a.score) || a.tag.localeCompare(b.tag);
    });
  return {
    key: key,
    rows: results.length,
    suggested: suggested,
    distinct: ranked.length,
    meanScore: suggested > 0 ? Number((sum / suggested).toFixed(4)) : 0,
    maxScore: Number(max.toFixed(4)),
    priorityHits: priorityHits,
    topTags: ranked.slice(0, topK),
    tags: ranked.map(function (t) { return t.tag; }),
  };
}

const dims = Array.isArray(args.dims) ? args.dims : ['tid', 'dt', 'visitTime'];
const groups = [];
for (const dim of dims) {
  groups.push(summarize(dim, await api.tagRows(rows, withDim(dim, channels))));
}

// suffix_*: rows carrying the same fc.txtRx suffix tag become one another's neighbours,
// so each bucket is scored as its own working set.
const buckets = {};
for (const r of rows) {
  const suffix = (r.tags || []).filter(function (t) { return String(t).indexOf('suffix_') === 0; })[0];
  const key = suffix || '(none)';
  if (!buckets[key]) buckets[key] = [];
  buckets[key].push(r);
}
const suffixResults = [];
const suffixGroups = [];
for (const key of Object.keys(buckets).sort()) {
  const scored = await api.tagRows(buckets[key], withDim('tid', channels));
  for (const result of scored) suffixResults.push(result);
  suffixGroups.push(summarize(key, scored));
}
const suffixPooled = summarize('suffix_*', suffixResults);
groups.push(suffixPooled);

/** Share of tags two rules agree on, over everything either proposed. */
function jaccard(a, b) {
  const left = {};
  const right = {};
  for (const t of a) left[t] = true;
  for (const t of b) right[t] = true;
  let shared = 0;
  let union = 0;
  const seen = {};
  for (const t of a) {
    seen[t] = true;
    union++;
    if (right[t]) shared++;
  }
  for (const t of b) {
    if (!seen[t]) union++;
  }
  return union > 0 ? shared / union : 0;
}

const baseline = (groups.find(function (g) { return g.key === 'tid'; }) || groups[0]).tags;
const strip = function (g) {
  const out = Object.assign({}, g);
  if (!args.detail) delete out.tags;
  return out;
};

return {
  ref: ctx.ref,
  scanned: all.length,
  scored: rows.length,
  pins: pins.map(function (p) { return p.ref; }),
  priorityTags: priorityTags,
  adapters: {
    embed: !!embed, classify: !!classify,
    provider: provider || null, model: model || null,
    notes: notes,
  },
  groups: groups.map(function (g) {
    return Object.assign(strip(g), {
      overlapTid: g.key === 'tid' ? 1 : Number(jaccard(g.tags, baseline).toFixed(3)),
    });
  }),
  suffixBuckets: Object.keys(buckets).length,
  suffixGroups: suffixGroups.slice(0, bucketLimit).map(strip),
  ranking: groups.slice().sort(function (a, b) {
    return (b.priorityHits - a.priorityHits) || (b.suggested - a.suggested) || a.key.localeCompare(b.key);
  }).map(function (g) { return g.key; }),
  notes: notes.concat([
    'each rule scores the rows on its own; suffix_* buckets rows that share an fc.txtRx title suffix',
    'a candidate must also occur in row text, a keyword match, or a classifier label, so a suffix_* tag groups rows without being suggested itself',
  ]),
};`;
}

/**
 * Body of `srctag/suggest.js`: one row set scored under several neighbourhood rules,
 * returned as a comparison.
 *
 * Unlike the two adapters this body results in the report itself rather than a
 * function, which is what `recr`'s `run_src` returns to the model. It owns no
 * scoring: the fusion runs in `srctag`, reached through `globalThis.srctag`, and
 * the four rules it compares are `tid`, `dt`, `visitTime`, and the `suffix_*` tag
 * `fc.txtRx` writes on a title tail — for that last one the rows sharing a tag
 * become each other's neighbourhood.
 *
 * `ctx.args`:
 *   - `limit` rows scanned, newest `tid` first (default 300)
 *   - `tids` restrict scoring to these rows
 *   - `dims` which time/order rules to run (`['tid','dt','visitTime']`)
 *   - `topK` tags listed per rule (default 5), `detail` keep each rule's full tag list
 *   - `bucketLimit` `suffix_*` buckets listed (default 12); the pooled rule always sees all
 *   - `provider` / `model` the API channels resolve through, read out of the same
 *     `ctx.args` that `srctag/embed.js` and `srctag/classify.js` read
 *   - `adapters: false` stay on the lexical channels, so no provider is called
 *   - `labels` classifier labels; defaults to the `srctag/keywords.md` headings
 */
export const SRCTAG_SUGGEST_BODY = suggestBody({});

/**
 * Body of `srctag/suggest-ds.js`: the same comparison with its API channels defaulted
 * to the `ds` provider, so the embed and classify rows resolve through that provider
 * instead of their own `cfw` / `cjev` defaults. `ctx.args.provider` still wins, so one
 * row can be pointed at another provider without reseeding.
 */
export const SRCTAG_SUGGEST_DS_BODY = suggestBody({ provider: 'ds' });


/**
 * Rows `srctag` reads by convention. Seeding them is a caller's step; nothing in
 * the app writes them on its own.
 */
export const SRCTAG_ROW_SEEDS: TagSeedRow[] = [
  { ref: SRCTAG_EMBED_REF, type: 'src', txt: SRCTAG_EMBED_BODY, tags: ['srctag'] },
  { ref: SRCTAG_CLASSIFY_REF, type: 'src', txt: SRCTAG_CLASSIFY_BODY, tags: ['srctag'] },
  { ref: SRCTAG_KEYWORDS_REF, type: 'md', txt: SRCTAG_KEYWORDS_DOC, tags: ['srctag'] },
  { ref: SRCTAG_SUGGEST_REF, type: 'src', txt: SRCTAG_SUGGEST_BODY, tags: ['srctag'] },
  { ref: SRCTAG_SUGGEST_DS_REF, type: 'src', txt: SRCTAG_SUGGEST_DS_BODY, tags: ['srctag'] },
];

/** Refs {@link seedTagRows} writes and {@link clearTagRows} removes. */
export const SRCTAG_ROW_REFS = SRCTAG_ROW_SEEDS.map((s) => s.ref);

/** The row fields the seed helpers read and write; `Da` carries more. */
export interface SeedRow {
  ref: string;
  type: string;
  txt?: string;
  tags?: string[];
  rec?: Record<string, unknown>;
  modAt?: Date;
}

/**
 * The slice of a Dexie table the seed helpers need. `any` here keeps the module
 * free of Dexie's types: `db.das` satisfies it structurally, and a bare object
 * does too in tests.
 */
export interface TagSeedTable {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  filter(pred: (row: any) => boolean): { toArray(): Promise<any[]>; delete(): Promise<number> };
  bulkPut(rows: any[]): Promise<unknown>;
}

/** What a seed pass wrote and what it left alone. */
export interface TagSeedResult {
  written: string[];
  /** Refs that already carry a live row, so the user's own version was kept. */
  skipped: string[];
}

/** Whether `row` is one of ours and not tombstoned. */
const isLiveSeed = (row: SeedRow): boolean =>
  SRCTAG_ROW_REFS.includes(row.ref) && !(row.tags ?? []).includes('[del]');

/**
 * Write the `srctag/*` rows, leaving a ref that already has a live row alone.
 *
 * @param table store to write through
 * @returns the refs written and the refs skipped
 */
export async function seedTagRows(table: TagSeedTable): Promise<TagSeedResult> {
  const existing: SeedRow[] = await table.filter(isLiveSeed).toArray();
  const skipped = [...new Set(existing.map((r) => r.ref))];
  const rows = SRCTAG_ROW_SEEDS.filter((s) => !skipped.includes(s.ref))
    .map((s) => ({ ref: s.ref, type: s.type, txt: s.txt, tags: [...s.tags], rec: {}, modAt: new Date() }));
  if (rows.length > 0) await table.bulkPut(rows);
  return { written: rows.map((r) => r.ref), skipped };
}

/**
 * Tombstone the `srctag/*` rows the way the store's own delete does, so the
 * removal syncs instead of leaving a remote copy to resurrect them.
 *
 * @param table store to write through
 * @returns how many rows were tombstoned
 */
export async function clearTagRows(table: TagSeedTable): Promise<number> {
  const rows: SeedRow[] = await table.filter(isLiveSeed).toArray();
  if (rows.length === 0) return 0;
  await table.bulkPut(rows.map((r) => ({
    ...r, tags: [...new Set([...(r.tags ?? []), '[del]'])], modAt: new Date(),
  })));
  return rows.length;
}
