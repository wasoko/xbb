/**
 * srctag.ts — score and write `db.das` `tags[]` for tab, url, and pin rows.
 *
 * Six channels are fused per row; the first four carry the default weights and
 * the last two are off until a caller turns them on:
 *   - TF-IDF over a dynamic neighbour window, weighted 0.35
 *   - embedding cosine against the neighbour centroid, weighted 0.35
 *   - priority tags, taken from the `#tag` headings of pin md cards, weighted 0.20
 *   - a zero-shot classifier's labels, weighted 0.10
 *   - TextRank centrality of the row's own tokens, weighted 0
 *   - TextRank centrality of the neighbour burst's pooled tokens, weighted 0
 *
 * TF-IDF needs an IDF table, so its score folds in how rare a term is across the
 * working set; that table is what misreads a burst of sibling links, where every
 * row shares the same few terms. TextRank needs no corpus: it ranks a token by
 * its position in a co-occurrence graph, so a row's own title yields a stable
 * score whatever its neighbours happen to be.
 *
 * The neighbour window is measured on one of three dimensions — insert order
 * (`tid`), row time (`dt`/`modAt`), or browser visit time (`rec.visitTime`) —
 * and its radius adapts to local density, so tabs opened together in one burst
 * stay one cluster while sparse rows reach further. {@link groupByDomain}
 * buckets a working set by hostname instead, for the caller that wants a row's
 * peers to be its site rather than its neighbours in the array.
 *
 * Everything here is dependency-free: no `sdb`, no Dexie, no DOM. Rows are
 * accepted structurally, the embedding and classifier calls are injected
 * functions, and writes go through a {@link TagWritePort} the caller supplies.
 * That is what lets the same file serve the webapp, a `recr` `run_src` row (see
 * {@link installSrctagGlobal}), and a copy inside the tabext extension.
 *
 * The lexical channels run with no network at all. {@link hashEmbed} is the
 * deterministic fallback when no embedding function is available, and
 * {@link loadAdaptersFromStore} reads optional API callers from `type='src'`
 * rows (`srctag/embed.js`, `srctag/classify.js`).
 */

import { runBody, type RecrScriptContext } from './runsrc';

// ─── Row and result types ──────────────────────────────────────────────────

/**
 * A `db.das` row as this module sees it. Structurally compatible with `Da`
 * from `sdb` without importing it.
 */
export interface TagRow {
  tid?: number;
  txt: string;
  ref: string;
  type: string;
  tags?: string[];
  dt?: unknown;
  modAt?: unknown;
  rec?: Record<string, unknown>;
}

/** Which ordering a neighbourhood and its clusters are measured on. */
export type TagDim = 'tid' | 'dt' | 'visitTime';

/** Per-channel contribution of one candidate tag, before the weights apply. */
export interface TagParts {
  /** Normalized TF-IDF weight times the neighbour similarity. */
  tfidf: number;
  /** Normalized TF-IDF weight times the embedding similarity; 0 without embeddings. */
  embed: number;
  /** TextRank centrality of the token in the row's own text, normalized by the row's top rank. */
  textRank: number;
  /** TextRank centrality of the token in the neighbour burst's pooled text; 0 when the row lacks it. */
  clusterRank: number;
  /** 1 for a priority tag, {@link TagScoreConfig.keywordBoost} when a trie match names it, else 0. */
  priority: number;
  /** 1 when a keyword (trie) match names the tag, else 0. */
  keyword: number;
  /** Classifier score for the tag, else 0. */
  suggest: number;
}

/** One scored candidate tag. */
export interface TagSuggestion {
  tag: string;
  score: number;
  parts: TagParts;
}

/** Weights and cut-offs of the fusion step. */
export interface TagScoreConfig {
  tfidf: number;
  embed: number;
  /** Weight of the row's own TextRank centrality; 0 leaves the channel out. */
  textRank: number;
  /** Weight of the neighbour burst's pooled TextRank centrality; 0 leaves the channel out. */
  clusterRank: number;
  priority: number;
  suggest: number;
  /** Factor applied to the priority channel when a keyword match names the tag. */
  keywordBoost: number;
  /** Candidate tags kept per row. */
  topK: number;
  /** Suggestions scoring below this are dropped. */
  minScore: number;
}

/** Window radius, burst gap, and the density test that adapts the radius. */
export interface TagWindowConfig {
  dim: TagDim;
  /** Radius before density adaptation. */
  window: number;
  minWindow: number;
  maxWindow: number;
  /** A stamp distance within which rows count as local for the density test. */
  denseSpan: number;
  /** Local rows (excluding the target) at or above this count shrink the window. */
  denseCount: number;
  /** Two rows further apart than this are separate clusters. */
  burstGap: number;
}

/** A window around one row: the neighbour indices, and the radius that produced them. */
export interface TagWindow {
  lo: number;
  hi: number;
  radius: number;
  /** Neighbour positions, excluding the row itself. */
  indices: number[];
}

/** One burst of adjacent rows. */
export interface TagCluster {
  /** Position of this cluster in the array returned by {@link clusterRows}. */
  key: number;
  indices: number[];
}

/** One row's scored result. */
export interface TagRowResult {
  row: TagRow;
  suggestions: TagSuggestion[];
  window: TagWindow;
  cluster: number;
}

// ─── Defaults ──────────────────────────────────────────────────────────────

/**
 * Default channel weights.
 *
 * `textRank` and `clusterRank` are off here: the default sweep is the lexical
 * pair plus the pin tags, and a caller that wants the graph channels (the
 * `rstext` grouper does) names them explicitly. A zero weight skips the
 * computation entirely, so the default path pays nothing for them.
 */
export const DEFAULT_TAG_SCORE: TagScoreConfig = {
  tfidf: 0.35, embed: 0.35, textRank: 0, clusterRank: 0, priority: 0.2, suggest: 0.1,
  keywordBoost: 1.5, topK: 8, minScore: 0.05,
};

/**
 * Weights of the `rstext` read path: TextRank carries the score, TF-IDF is
 * suppressed because a burst of sibling links shares its vocabulary, and
 * `clusterRank` is the term that reads the burst as a unit.
 *
 * The cut-off is higher than the default on purpose: a TextRank value is a
 * normalized centrality, so most of a row's tokens clear 0.05 and the list
 * would render a chip per token. The sweep in `test/srctag-cdp.test.ts` prints
 * what this and every other knob does to the live table.
 */
export const RSTEXT_TAG_SCORE: Partial<TagScoreConfig> = {
  tfidf: 0, embed: 0, textRank: 0.6, clusterRank: 0.4, priority: 0.5, suggest: 0,
  topK: 5, minScore: 0.4,
};

/** `burstGap` defaults, in each dimension's own unit (rows for `tid`, milliseconds otherwise). */
const BURST_GAP: Record<TagDim, number> = { tid: 1, dt: 60_000, visitTime: 300_000 };
/** `denseSpan` defaults, in each dimension's own unit. */
const DENSE_SPAN: Record<TagDim, number> = { tid: 8, dt: 60_000, visitTime: 600_000 };

/** Partial overrides merged over {@link DEFAULT_TAG_SCORE}. */
export function mergeTagScore(over?: Partial<TagScoreConfig>): TagScoreConfig {
  return { ...DEFAULT_TAG_SCORE, ...over };
}

/**
 * Window config for one dimension, with that dimension's burst gap and density
 * span as the defaults.
 *
 * @param dim ordering the window is measured on
 * @param over partial overrides
 * @returns the merged config
 */
export function defaultWindow(dim: TagDim = 'tid', over?: Partial<TagWindowConfig>): TagWindowConfig {
  return {
    window: 3, minWindow: 1, maxWindow: 8,
    denseSpan: DENSE_SPAN[dim], denseCount: 5, burstGap: BURST_GAP[dim],
    ...over, dim,
  };
}

/** The row tombstone `sdb.DEL_TAG` carries; local so this module imports no store. */
export const TAG_DEL = '[del]';

/** `rec` key holding the provenance of the tags this module wrote. */
export const TAG_AUTO_KEY = 'tagAuto';

// ─── Text: tokenizer, URL tokens, TF-IDF ────────────────────────────────────

/** English function words dropped from tokens; web-path noise is dropped by `urlTokens`. */
export const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'do', 'does', 'did',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'this', 'that', 'these', 'those',
  'it', 'its', 'as', 'if', 'then', 'than', 'so', 'not', 'no', 'but', 'you', 'your', 'we', 'our',
]);

/** Path and hostname segments that carry no topic; `www` and regional prefixes. */
export const URL_STOP = new Set([
  'www', 'com', 'cn', 'org', 'net', 'io', 'co', 'gov', 'edu', 'html', 'htm', 'php', 'asp',
  'index', 'amp', 'en', 'zh', 'search', 'login', 'watch', 'm', 'mobile',
]);

/** CJK code-point ranges treated as runs rather than Latin words. */
const CJK_RX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/** Options for {@link tokenize}. */
export interface TokenizeOptions {
  /** How a CJK run is cut: sliding bigrams (default), single characters, or the whole run. */
  cjk?: 'bigram' | 'unigram' | 'run';
  /** Tokens shorter than this are dropped. */
  minLength?: number;
}

/** NFKC + lowercase, so a tag and its text occurrence compare equal. */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/**
 * Tokens of `text` for TF-IDF and the keyword trie.
 *
 * Latin runs split on anything that is not a letter or digit, stop-worded, and
 * length-filtered. A CJK run is cut into sliding bigrams by default: Chinese has
 * no spaces, and a full run is too specific to recur across tabs while single
 * characters are too common.
 *
 * @param text source text
 * @param opts tokenizer options
 * @returns the tokens, in order, with duplicates kept
 */
export function tokenize(text: string, opts: TokenizeOptions = {}): string[] {
  const cjk = opts.cjk ?? 'bigram';
  // a single CJK character is a whole token in unigram mode, so the floor drops to 1 there
  const minLength = opts.minLength ?? (cjk === 'unigram' ? 1 : 2);
  const out: string[] = [];
  const keep = (t: string) => t.length >= minLength && !STOP_WORDS.has(t) && !/^\d+$/.test(t);
  const pushLatin = (run: string) => {
    for (const w of run.split(/[^\p{L}\p{N}]+/u)) if (w && keep(w)) out.push(w);
  };
  const pushCjk = (run: string) => {
    if (cjk === 'run') { if (keep(run)) out.push(run); return; }
    if (cjk === 'unigram') { for (const ch of run) if (keep(ch)) out.push(ch); return; }
    if (run.length === 1) { if (keep(run)) out.push(run); return; }
    for (let i = 0; i + 1 < run.length; i++) {
      const g = run.slice(i, i + 2);
      if (keep(g)) out.push(g);
    }
  };

  const src = normalizeText(text ?? '').replace(/https?:\/\/\S+/g, ' ');
  let buf = '';
  let bufCjk = false;
  for (const ch of src) {
    const isCjk = CJK_RX.test(ch);
    if (buf && isCjk !== bufCjk) {
      if (bufCjk) pushCjk(buf); else pushLatin(buf);
      buf = '';
    }
    buf += ch;
    bufCjk = isCjk;
  }
  if (buf) { if (bufCjk) pushCjk(buf); else pushLatin(buf); }
  return out;
}

/**
 * Extract the candidate tokens of a row: its title, any URL in it, and — for
 * non-markdown rows — the `ref` itself, which holds the URL.
 *
 * @param row row to read
 * @returns `{ text, urls }`, where `urls` are the URLs found in `txt` and `rec.url`
 */
export function rowSources(row: TagRow): { text: string; urls: string[] } {
  const urls = typeof row.rec?.url === 'string' ? [row.rec.url] : [];
  urls.push(...markdownLinks(row.txt ?? ''));
  if (row.type !== 'md' && /^[a-z]+:\/\//i.test(row.ref)) urls.push(row.ref);
  return { text: row.txt ?? '', urls };
}

/** URLs inside `text`: Markdown link targets and bare `http(s)` URLs. */
export function markdownLinks(text: string): string[] {
  const found: string[] = [];
  for (const m of (text ?? '').matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) found.push(m[1]);
  for (const m of (text ?? '').matchAll(/https?:\/\/[^\s)\]"'<>]+/g)) found.push(m[0]);
  return [...new Set(found)];
}

/**
 * Topic tokens of a URL: hostname labels, path segments, and query values.
 *
 * @param url absolute URL, or any string when it is not one
 * @returns tokens, deduplicated
 */
export function urlTokens(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [...new Set(tokenize(url))];
  }
  const host = u.hostname.replace(/^www\./, '');
  const parts = [
    host,
    ...host.split('.'),
    ...u.pathname.split(/[/\-_.]+/),
    ...queryValues(u.search),
  ];
  const out: string[] = [];
  for (const p of parts) out.push(...tokenize(p));
  return [...new Set(out.filter(t => !URL_STOP.has(t)))];
}

/** Percent-decoded values of a query string, without `URLSearchParams` iteration (not in the DOM lib). */
function queryValues(search: string): string[] {
  const out: string[] = [];
  for (const part of search.replace(/^\?/, '').split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0 || eq === part.length - 1) continue;
    try {
      out.push(decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')));
    } catch {
      // a malformed escape is not worth failing the whole token pass over
      out.push(part.slice(eq + 1));
    }
  }
  return out;
}

/**
 * Hostname a row was saved from, `www.` stripped, or `''` when the row names no
 * absolute URL.
 *
 * @param row row to read
 * @returns the hostname, or `''`
 */
export function rowDomain(row: TagRow): string {
  const candidates = [row.rec?.url, row.ref].filter((v): v is string => typeof v === 'string');
  for (const url of candidates) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      // a ref that is not an absolute URL says nothing about the row's site
    }
  }
  return '';
}

/**
 * Bucket rows by the hostname they were saved from.
 *
 * This is the clustering a burst of search results does not provide: sibling
 * links from one site share vocabulary a neighbour window would misread, so a
 * caller can score each site's rows as their own working set. Rows with no URL
 * land under `''`.
 *
 * @param rows rows to bucket
 * @returns one bucket per hostname, insertion-ordered by first appearance
 */
export function groupByDomain(rows: TagRow[]): Map<string, TagRow[]> {
  const out = new Map<string, TagRow[]>();
  for (const row of rows) {
    const key = rowDomain(row);
    const held = out.get(key);
    if (held) held.push(row);
    else out.set(key, [row]);
  }
  return out;
}

/** Sparse term-weight vector keyed by token. */
export type SparseVector = Record<string, number>;

/** Term counts of `tokens`. */
export function tokenCounts(tokens: string[]): SparseVector {
  const tf: SparseVector = {};
  for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
  return tf;
}

/**
 * Inverse document frequency per token: `log((N + 1) / (df + 1)) + 1`, so a
 * token in every document still carries a small positive weight.
 *
 * @param docs tokens per document
 * @returns token -> idf
 */
export function idf(docs: string[][]): SparseVector {
  const df: SparseVector = {};
  for (const doc of docs) for (const t of new Set(doc)) df[t] = (df[t] ?? 0) + 1;
  const n = docs.length;
  const out: SparseVector = {};
  for (const [t, d] of Object.entries(df)) out[t] = Math.log((n + 1) / (d + 1)) + 1;
  return out;
}

/**
 * Sublinear TF-IDF vectors for all documents under one IDF table.
 *
 * @param docs tokens per document
 * @returns the vectors and the IDF table they were built with
 */
export function tfidfVectors(docs: string[][]): { vectors: SparseVector[]; idf: SparseVector } {
  const table = idf(docs);
  const vectors = docs.map(tokens => {
    const tf = tokenCounts(tokens);
    const vec: SparseVector = {};
    for (const [t, c] of Object.entries(tf)) vec[t] = (1 + Math.log(c)) * (table[t] ?? 1);
    return vec;
  });
  return { vectors, idf: table };
}

/** Cosine similarity of two sparse vectors; 0 when either has no weight. */
export function cosineSparse(a: SparseVector, b: SparseVector): number {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of Object.entries(a)) {
    na += v * v;
    const w = b[k];
    if (w !== undefined) dot += v * w;
  }
  for (const v of Object.values(b)) nb += v * v;
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/** Cosine similarity of two dense vectors; 0 when either has no magnitude. */
export function cosineDense(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/** Mean of sparse vectors; `{}` for an empty list. */
export function centroidSparse(vectors: SparseVector[]): SparseVector {
  if (vectors.length === 0) return {};
  const out: SparseVector = {};
  for (const v of vectors) for (const [k, val] of Object.entries(v)) out[k] = (out[k] ?? 0) + val;
  for (const k of Object.keys(out)) out[k] /= vectors.length;
  return out;
}

/** Mean of dense vectors; `[]` for an empty list. */
export function centroidDense(vectors: ArrayLike<number>[]): number[] {
  if (vectors.length === 0) return [];
  const out = new Array(vectors[0].length).fill(0);
  for (const v of vectors) for (let i = 0; i < out.length; i++) out[i] += v[i] ?? 0;
  for (let i = 0; i < out.length; i++) out[i] /= vectors.length;
  return out;
}

/**
 * Deterministic character-histogram vector, used when no embedding function is
 * configured so the embed channel degrades to a weak lexical signal instead of
 * dropping out.
 *
 * @param text source text
 * @param dim vector length
 * @returns a unit-length vector
 */
export function hashEmbed(text: string, dim = 64): Float64Array {
  const vec = new Float64Array(dim);
  const src = normalizeText(text ?? '');
  for (let i = 0; i < src.length; i++) {
    const code = src.codePointAt(i) ?? 0;
    vec[code % dim] += 1;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

// ─── TextRank centrality ───────────────────────────────────────────────────

/** Knobs of {@link textRank}. */
export interface TextRankOptions {
  /** Co-occurrence window in tokens: two tokens are linked when this close. */
  window?: number;
  /** Damping factor of the random walk. */
  damping?: number;
  /** Iteration cap; the walk stops earlier once no score moves by more than 1e-4. */
  iterations?: number;
  /** Tokens shorter than this are left out of the graph. */
  minLength?: number;
}

/** {@link TextRankOptions} with every field resolved. */
export type TextRankConfig = Required<TextRankOptions>;

/** Defaults of {@link textRank}: the usual TextRank window and damping values. */
export const DEFAULT_TEXTRANK: TextRankConfig = {
  window: 4, damping: 0.85, iterations: 30, minLength: 0,
};

/**
 * TextRank centrality of every distinct token of `tokens`.
 *
 * The graph is the sliding co-occurrence window over the token sequence: an edge
 * joins two tokens at most `window` apart, weighted by how often that pair
 * recurs. Each node spreads its weight over its neighbours in proportion to the
 * edge weights — a PageRank over the token graph, so a token that recurs beside
 * many different tokens wins over one that appears once or always beside the
 * same partner. A weighting rather than a bare edge set is what keeps a short
 * title from collapsing: a row of four distinct nouns is a complete graph, and
 * an unweighted walk reads every one of them as equally central.
 *
 * No IDF table is involved, so a row's score does not depend on how rare its
 * neighbours made the term — the property that makes this channel usable where
 * a burst of sibling links has flattened TF-IDF.
 *
 * Scores are normalized by the highest one, so the top token always reads 1.
 *
 * @param tokens tokens in text order, duplicates kept
 * @param opts graph and iteration knobs
 * @returns token -> normalized centrality; `{}` for no tokens
 */
export function textRank(tokens: string[], opts: TextRankOptions = {}): SparseVector {
  const cfg = { ...DEFAULT_TEXTRANK, ...opts };
  const nodes: string[] = [];
  const index = new Map<string, number>();
  for (const t of tokens) {
    if (t.length < cfg.minLength || index.has(t)) continue;
    index.set(t, nodes.length);
    nodes.push(t);
  }
  const n = nodes.length;
  if (n === 0) return {};

  const edges: Map<number, number>[] = Array.from({ length: n }, () => new Map<number, number>());
  const link = (a: number, b: number) => {
    edges[a].set(b, (edges[a].get(b) ?? 0) + 1);
    edges[b].set(a, (edges[b].get(a) ?? 0) + 1);
  };
  const span = Math.max(1, cfg.window);
  for (let i = 0; i < tokens.length; i++) {
    const a = index.get(tokens[i]);
    if (a === undefined) continue;
    for (let j = i + 1; j < Math.min(tokens.length, i + span); j++) {
      const b = index.get(tokens[j]);
      if (b !== undefined && b !== a) link(a, b);
    }
  }

  const outWeight = edges.map(r => [...r.values()].reduce((sum, w) => sum + w, 0));
  let score = new Array<number>(n).fill(1);
  for (let it = 0; it < cfg.iterations; it++) {
    const next = new Array<number>(n).fill(1 - cfg.damping);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (const [j, w] of edges[i]) if (outWeight[j] > 0) sum += (w / outWeight[j]) * score[j];
      next[i] += cfg.damping * sum;
    }
    let delta = 0;
    for (let i = 0; i < n; i++) delta = Math.max(delta, Math.abs(next[i] - score[i]));
    score = next;
    if (delta < 1e-4) break;
  }

  let max = 0;
  for (const v of score) max = Math.max(max, v);
  if (max <= 0) return {};
  const out: SparseVector = {};
  for (let i = 0; i < n; i++) out[nodes[i]] = score[i] / max;
  return out;
}

// ─── Keyword trie (TurboText: Aho–Corasick) ────────────────────────────────

/** One tag and the surface forms that should match it. */
export interface KeywordEntry {
  tag: string;
  keywords: string[];
}

/** One trie hit. */
export interface KeywordMatch {
  tag: string;
  /** The matched surface form, as it appeared in the text. */
  form: string;
  start: number;
  end: number;
}

interface AcNode {
  children: Map<string, AcNode>;
  /** Longest proper suffix that is also a node; set by {@link TurboTextTagger.build}. */
  fail?: AcNode;
  /** Terminal of a keyword, holding the tag it names and the form as written. */
  out?: { tag: string; form: string; key: string };
}

const acNode = (): AcNode => ({ children: new Map() });

/**
 * A keyword-to-tag dictionary over an Aho–Corasick automaton, the TurboText
 * arrangement of the FlashText idea.
 *
 * The dictionary is a trie; failure links then make one left-to-right scan find
 * every occurrence of every keyword, so a scan is O(text) whatever the
 * dictionary holds, and overlapping or nested keywords are all reported.
 * {@link match} keeps the older FlashText reading — longest form wins and a
 * match consumes its span, so one occurrence cannot yield two tags — while
 * {@link matchAll} and {@link counts} expose the automaton's full output, which
 * is what a caller ranking terms by how often a keyword occurs needs.
 */
export class TurboTextTagger {
  private root = acNode();
  private count = 0;
  private built = false;

  /** @param entries tag -> surface forms to load */
  constructor(entries: KeywordEntry[] = []) {
    this.addEntries(entries);
  }

  /** Number of distinct surface forms loaded. */
  get size(): number {
    return this.count;
  }

  /** Add one surface form for `tag`. A form may not be empty after normalization. */
  add(tag: string, keyword: string): void {
    const form = String(keyword ?? '').trim();
    const key = normalizeText(form);
    if (!key || !tag) return;
    let cur = this.root;
    for (let i = 0; i < key.length; i++) {
      let next = cur.children.get(key[i]);
      if (!next) { next = acNode(); cur.children.set(key[i], next); }
      cur = next;
    }
    if (cur.out === undefined) this.count++;
    cur.out = { tag, form, key };
    this.built = false;
  }

  /** Add every entry's forms. */
  addEntries(entries: KeywordEntry[]): void {
    for (const e of entries) for (const k of e.keywords) this.add(e.tag, k);
  }

  /** Link every node to its longest proper suffix, once per dictionary change. */
  private build(): void {
    if (this.built) return;
    const queue: AcNode[] = [];
    for (const child of this.root.children.values()) {
      child.fail = this.root;
      queue.push(child);
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const node = queue[qi];
      for (const [ch, next] of node.children) {
        queue.push(next);
        let f = node.fail;
        while (f && f !== this.root && !f.children.has(ch)) f = f.fail;
        next.fail = f?.children.get(ch) ?? this.root;
      }
    }
    this.built = true;
  }

  /** Tags whose forms occur in `text`, deduplicated, in text order. */
  match(text: string): KeywordMatch[] {
    const src = normalizeText(text ?? '');
    const out: KeywordMatch[] = [];
    let i = 0;
    while (i < src.length) {
      let cur = this.root;
      let best: { node: AcNode; end: number } | undefined;
      let j = i;
      while (j < src.length) {
        const next = cur.children.get(src[j]);
        if (!next) break;
        cur = next;
        j++;
        if (cur.out !== undefined && boundaryOk(src, i, j)) best = { node: cur, end: j };
      }
      if (best) {
        const hit = best.node.out!;
        out.push({ tag: hit.tag, form: hit.form, start: i, end: best.end });
        i = best.end;
        continue;
      }
      i++;
    }
    return out;
  }

  /**
   * Every keyword occurrence in `text`, including overlapping and nested ones,
   * from one pass over the automaton.
   *
   * @param text text to scan
   * @returns the hits in end-offset order
   */
  matchAll(text: string): KeywordMatch[] {
    this.build();
    const src = normalizeText(text ?? '');
    const out: KeywordMatch[] = [];
    let cur = this.root;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      while (cur !== this.root && !cur.children.has(ch)) cur = cur.fail!;
      cur = cur.children.get(ch) ?? this.root;
      for (let node: AcNode | undefined = cur; node; node = node.fail) {
        const hit = node.out;
        if (!hit) continue;
        const start = i + 1 - hit.key.length;
        if (start >= 0 && boundaryOk(src, start, i + 1)) {
          out.push({ tag: hit.tag, form: hit.form, start, end: i + 1 });
        }
      }
    }
    return out;
  }

  /**
   * How often each tag's forms occur in `text`, counting overlapping and nested
   * occurrences separately.
   *
   * @param text text to scan
   * @returns tag -> occurrence count, keys in first-occurrence order
   */
  counts(text: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const hit of this.matchAll(text)) out.set(hit.tag, (out.get(hit.tag) ?? 0) + 1);
    return out;
  }
}

/** The FlashText-era name for {@link TurboTextTagger}, kept for existing callers. */
export { TurboTextTagger as KeywordTagger };

/**
 * Whether a match at `[start, end)` stands alone.
 *
 * A Latin keyword must not be the inside of a longer word (`art` in `cart`);
 * CJK has no word spacing, so an adjacent CJK character is allowed.
 */
function boundaryOk(src: string, start: number, end: number): boolean {
  const before = src[start - 1];
  const after = src[end];
  const latin = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch) && !CJK_RX.test(ch);
  return !latin(before) && !latin(after);
}

/**
 * Keyword entries for a list of tags.
 *
 * Each tag contributes itself, its hyphen/underscore form as spaced words, and
 * any synonym supplied by the caller.
 *
 * @param tags tags to match against text
 * @param synonyms extra surface forms per tag
 * @returns entries ready for {@link TurboTextTagger}
 */
export function keywordEntries(tags: string[], synonyms: Record<string, string[]> = {}): KeywordEntry[] {
  const out: KeywordEntry[] = [];
  for (const tag of tags) {
    const forms = new Set<string>([tag, tag.replace(/[-_]+/g, ' ')]);
    for (const s of synonyms[tag] ?? []) forms.add(s);
    out.push({ tag, keywords: [...forms] });
  }
  return out;
}

/**
 * Parse the `srctag/keywords.md` dialect: a `## tag` section holding `- keyword` items.
 *
 * @param md document text
 * @returns one entry per heading, in document order
 */
export function parseKeywordDoc(md: string): KeywordEntry[] {
  const out: KeywordEntry[] = [];
  let current: KeywordEntry | undefined;
  for (const line of (md ?? '').split('\n')) {
    const heading = line.match(/^\s*##\s+(.+?)\s*$/);
    if (heading) {
      current = { tag: heading[1], keywords: [] };
      out.push(current);
      continue;
    }
    const item = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (item && current) current.keywords.push(item[1]);
  }
  return out.filter(e => e.keywords.length > 0 || e.tag.length > 0);
}

// ─── Priority tags from pin md cards ───────────────────────────────────────

const HEADING_RX = /^(#{1,6})\s+(.+)$/;
/** A tag is `#`-prefixed after start or whitespace, so `e=` and `tabs=` stay plain text. */
const HASHTAG_RX = /(^|\s)#([\p{L}\p{N}_]+)/gu;
const CLOSING_HASH_RX = /\s+#+\s*$/;

/** One `#tag` occurrence in a pin card's heading. */
export interface PinTag {
  tag: string;
  level: number;
}

/**
 * `#tag` tokens in the Markdown headings of one pin card, following the same
 * rules `ui/cs1.tsx` renders with: heading lines only, closing hashes stripped,
 * a tag after start or whitespace.
 *
 * @param txt pin card text
 * @returns tags in text order, duplicates removed
 */
export function pinTags(txt: string): PinTag[] {
  const out: PinTag[] = [];
  const seen = new Set<string>();
  for (const raw of (txt ?? '').split('\n')) {
    const m = raw.match(HEADING_RX);
    if (!m) continue;
    const level = m[1].length;
    const text = m[2].replace(CLOSING_HASH_RX, '').trim();
    if (!text) continue;
    for (const hit of text.matchAll(HASHTAG_RX)) {
      const tag = hit[2];
      if (seen.has(tag)) continue;
      seen.add(tag);
      out.push({ tag, level });
    }
  }
  return out;
}

/**
 * Priority tags of a set of pin cards.
 *
 * @param pins pin `md` rows (`ref` starting with `pin`)
 * @returns the tags, in first-appearance order, deduplicated
 */
export function pinPriorityTags(pins: TagRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const pin of pins) {
    for (const t of pinTags(pin.txt ?? '')) {
      if (seen.has(t.tag)) continue;
      seen.add(t.tag);
      out.push(t.tag);
    }
  }
  return out;
}

// ─── Adjacency and clusters ────────────────────────────────────────────────

/** Largest numeric key of `rec[field]`, which holds `{ [epochMs]: value }` — see `sdb.maxRecKey`. */
function maxRecKey(rec: Record<string, unknown> | undefined, ...fields: string[]): number | undefined {
  for (const f of fields) {
    const dict = rec?.[f];
    if (!dict || typeof dict !== 'object') continue;
    const keys = Object.keys(dict as Record<string, unknown>).map(Number).filter(k => !Number.isNaN(k));
    if (keys.length > 0) return Math.max(...keys);
  }
  return undefined;
}

/** Epoch ms of a durable timestamp: a Date, an ISO string, or a number. */
function msOf(v: unknown): number {
  if (v == null) return NaN;
  const t = v instanceof Date ? v.getTime() : new Date(v as string | number).getTime();
  return Number.isNaN(t) ? NaN : t;
}

/**
 * Sort key of a row on one dimension.
 *
 * `dt` uses the later of the server `dt` and the local `modAt`, matching
 * `sdb.daStamp`. `visitTime` takes the newest of `rec.visitTime`, the typo
 * `rec.visitTIme`, and the keys of `rec.access2discard`.
 *
 * @param row row to read
 * @param dim dimension to read
 * @returns the sort key, or 0 when the row carries nothing for that dimension
 */
export function rowStamp(row: TagRow, dim: TagDim): number {
  if (dim === 'tid') return typeof row.tid === 'number' ? row.tid : 0;
  if (dim === 'dt') {
    const dt = msOf(row.dt);
    const mod = msOf(row.modAt);
    const best = Math.max(Number.isNaN(dt) ? -Infinity : dt, Number.isNaN(mod) ? -Infinity : mod);
    return Number.isFinite(best) ? best : 0;
  }
  const rec = row.rec;
  const num = typeof rec?.visitTime === 'number' && !Number.isNaN(rec.visitTime) ? rec.visitTime : undefined;
  const best = Math.max(num ?? -Infinity, maxRecKey(rec, 'visitTime', 'visitTIme', 'access2discard') ?? -Infinity);
  return Number.isFinite(best) ? best : 0;
}

/**
 * Rows ordered on `dim`, ascending, leaving the input untouched.
 *
 * @param rows rows to order
 * @param dim dimension to order by
 * @returns a new array in ascending stamp order
 */
export function sortByDim(rows: TagRow[], dim: TagDim): TagRow[] {
  return rows.map(row => ({ row, stamp: rowStamp(row, dim) }))
    .sort((a, b) => a.stamp - b.stamp)
    .map(r => r.row);
}

/**
 * Neighbourhood of `rows[i]` with a radius adapted to local density.
 *
 * A dense burst (at least `denseCount` rows within `denseSpan`) shrinks the
 * radius, so tabs opened from one search page do not swallow their neighbours'
 * terms. A sparse run grows it, so a lone tab still has context. The radius is
 * clamped to `[minWindow, maxWindow]` and the window to the array bounds.
 *
 * @param rows rows ordered on the config's dimension
 * @param i position of the row
 * @param cfg window configuration
 * @returns the window; `indices` excludes `i`
 */
export function neighbourhood(rows: TagRow[], i: number, cfg: TagWindowConfig): TagWindow {
  const n = rows.length;
  if (n === 0 || i < 0 || i >= n) return { lo: 0, hi: -1, radius: 0, indices: [] };
  const self = rowStamp(rows[i], cfg.dim);
  let local = 0;
  for (let j = 0; j < n; j++) {
    if (j === i) continue;
    if (Math.abs(rowStamp(rows[j], cfg.dim) - self) <= cfg.denseSpan) local++;
  }
  let radius = cfg.window;
  if (local >= cfg.denseCount) radius = Math.round(cfg.window / 2);
  else if (local <= 1) radius = cfg.window * 2;
  radius = Math.max(cfg.minWindow, Math.min(cfg.maxWindow, radius));

  const lo = Math.max(0, i - radius);
  const hi = Math.min(n - 1, i + radius);
  const indices: number[] = [];
  for (let j = lo; j <= hi; j++) if (j !== i) indices.push(j);
  return { lo, hi, radius, indices };
}

/**
 * Split ordered rows wherever two consecutive stamps are further apart than
 * `burstGap`: one cluster per browsing burst (or per open-order run).
 *
 * @param rows rows ordered on the config's dimension
 * @param cfg window configuration
 * @returns clusters in order
 */
export function clusterRows(rows: TagRow[], cfg: TagWindowConfig): TagCluster[] {
  const out: TagCluster[] = [];
  let current: number[] = [];
  let prev: number | undefined;
  for (let i = 0; i < rows.length; i++) {
    const stamp = rowStamp(rows[i], cfg.dim);
    if (prev !== undefined && Math.abs(stamp - prev) > cfg.burstGap) {
      out.push({ key: out.length, indices: current });
      current = [];
    }
    current.push(i);
    prev = stamp;
  }
  if (current.length > 0) out.push({ key: out.length, indices: current });
  return out;
}

// ─── Fusion ────────────────────────────────────────────────────────────────

/** Everything {@link scoreTagsForRow} needs for one row. */
export interface RowContext {
  /** Rows ordered on `windowCfg.dim`, in the same order as `vectors`. */
  rows: TagRow[];
  /** Position of the row being scored. */
  index: number;
  vectors: SparseVector[];
  windowCfg: TagWindowConfig;
  cfg: TagScoreConfig;
  /** Tags from the pin cards. */
  priority: string[];
  /** Trie hits on this row's text. */
  keywords: KeywordMatch[];
  /** Classifier output for this row. */
  suggestions?: { tag: string; score: number }[];
  /** One dense vector per row, when an embedding channel is available. */
  embeddings?: ArrayLike<number>[];
  /**
   * Tokens per row, in the same order as `rows`. Supplies the two TextRank
   * channels; without it they read 0 even when their weights are set.
   */
  docs?: string[][];
  /** Graph knobs for the TextRank channels. */
  rank?: TextRankOptions;
}

/**
 * Score every candidate tag of one row.
 *
 * Candidates are the row's own tokens plus every tag a trie hit or the
 * classifier proposed. The TF-IDF and embedding channels both gate on the
 * token's own weight, so a neighbour's shared vocabulary only lifts tags the
 * row actually carries, while a proposal with no textual support still scores
 * through the classifier channel alone.
 *
 * The TextRank channels are computed here, per row: `textRank` walks the row's
 * own tokens and `clusterRank` walks the neighbour window's pooled tokens, so
 * both follow the window the other channels use. A zero weight on both skips
 * the graph entirely, which is what keeps the default path free of the cost.
 *
 * @param ctx the row, its corpus, and its configured channels
 * @returns suggestions sorted by descending score
 */
export function scoreTagsForRow(ctx: RowContext): TagSuggestion[] {
  const { rows, index, vectors, windowCfg, cfg, priority, keywords, suggestions = [], embeddings } = ctx;
  const own = vectors[index] ?? {};
  const win = neighbourhood(rows, index, windowCfg);

  const neighVecs = win.indices.map(j => vectors[j]).filter((v): v is SparseVector => v !== undefined);
  const tfidfSim = cosineSparse(own, centroidSparse(neighVecs.length > 0 ? neighVecs : [own]));

  let embedSim = 0;
  if (embeddings && embeddings[index]) {
    const neigh = win.indices.map(j => embeddings[j]).filter((v): v is ArrayLike<number> => v !== undefined);
    embedSim = cosineDense(embeddings[index], centroidDense(neigh.length > 0 ? neigh : [embeddings[index]]));
  }

  const docs = ctx.docs;
  const ownRank = cfg.textRank > 0 && docs?.[index] ? textRank(docs[index], ctx.rank) : undefined;
  const poolRank = cfg.clusterRank > 0 && docs
    ? textRank(win.indices.flatMap(j => docs[j] ?? []), ctx.rank)
    : undefined;

  const prioritySet = new Set(priority);
  const keywordTags = new Set(keywords.map(k => k.tag));
  const suggestMap = new Map(suggestions.map(s => [s.tag, s.score]));

  const candidates = new Set<string>([
    ...Object.keys(own),
    ...keywordTags,
    ...suggestMap.keys(),
  ]);

  let maxWeight = 0;
  for (const t of candidates) maxWeight = Math.max(maxWeight, own[t] ?? 0);

  const out: TagSuggestion[] = [];
  for (const tag of candidates) {
    const tfNorm = maxWeight > 0 ? (own[tag] ?? 0) / maxWeight : 0;
    const isKeyword = keywordTags.has(tag);
    const prio = prioritySet.has(tag) || isKeyword ? (isKeyword ? cfg.keywordBoost : 1) : 0;
    const parts: TagParts = {
      tfidf: tfNorm * tfidfSim,
      embed: tfNorm * embedSim,
      textRank: ownRank ? (ownRank[tag] ?? 0) : 0,
      clusterRank: poolRank && (own[tag] ?? 0) > 0 ? (poolRank[tag] ?? 0) : 0,
      priority: prio,
      keyword: isKeyword ? 1 : 0,
      suggest: suggestMap.get(tag) ?? 0,
    };
    const score = cfg.tfidf * parts.tfidf + cfg.embed * parts.embed
      + cfg.textRank * parts.textRank + cfg.clusterRank * parts.clusterRank
      + cfg.priority * parts.priority + cfg.suggest * parts.suggest;
    out.push({ tag, score, parts });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Naive English plural strip plus NFKC/lowercase, for near-duplicate detection only. */
function tagStem(tag: string): string {
  const t = normalizeText(tag).replace(/^#/, '').trim();
  if (!/^[a-z][a-z-]*$/.test(t) || t.length < 5) return t;
  if (t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.endsWith('es')) return t.slice(0, -2);
  if (t.endsWith('s')) return t.slice(0, -1);
  return t;
}

/**
 * Drop near-duplicates from a score-ordered list: equal stems, and a shorter
 * tag contained in a longer one (only when the shorter is at least 4
 * characters, so two-letter fragments do not merge unrelated tags).
 *
 * @param tags suggestions in descending score order
 * @returns the kept tags, in the same order
 */
export function dedupeTags(tags: string[]): string[] {
  const kept: string[] = [];
  const stems = new Set<string>();
  for (const tag of tags) {
    const stem = tagStem(tag);
    if (!stem || stems.has(stem)) continue;
    const clash = kept.some(k => {
      const kd = normalizeText(k);
      const td = normalizeText(tag);
      return td.length >= 4 && kd.length >= 4 && (kd.includes(td) || td.includes(kd));
    });
    if (clash) continue;
    stems.add(stem);
    kept.push(tag);
  }
  return kept;
}

/**
 * Cut a scored list to the tags worth keeping.
 *
 * @param suggestions scored candidates
 * @param cfg weights and cut-offs
 * @returns the top entries after the score filter and dedupe
 */
export function rankTags(suggestions: TagSuggestion[], cfg: TagScoreConfig): TagSuggestion[] {
  const kept = dedupeTags(suggestions.filter(s => s.score >= cfg.minScore).map(s => s.tag));
  const byTag = new Map(suggestions.map(s => [s.tag, s]));
  return kept.slice(0, cfg.topK).map(t => byTag.get(t)!);
}

// ─── Score explanations ────────────────────────────────────────────────────

/** One channel's share of a tag's score, after its configured weight. */
export interface TagChannelStat {
  channel: keyof TagParts;
  /** Weight the fusion applied to this channel. */
  weight: number;
  /** Raw channel value before the weight. */
  value: number;
  /** `weight * value`, this channel's additive share of the score. */
  contribution: number;
}

/** How one suggested tag scored: the channels that carried it, largest first. */
export interface TagExplanation {
  tag: string;
  score: number;
  /** Channels with a non-zero value, ordered by descending contribution. */
  channels: TagChannelStat[];
  /** Channel with the largest contribution, or undefined when none contributed. */
  top?: keyof TagParts;
  /** One line of `channel value×weight=contribution`, for a hover tooltip. */
  text: string;
}

/** Display names for the channels, so a tooltip reads `turbotext` rather than `keyword`. */
const CHANNEL_LABEL: Record<keyof TagParts, string> = {
  tfidf: 'tfidf', embed: 'embed', textRank: 'textrank', clusterRank: 'clusterrank',
  priority: 'priority', keyword: 'turbotext', suggest: 'classify',
};

/** Two decimals keep a tooltip short. */
const fixed = (n: number): string => n.toFixed(2);

/**
 * Break one suggestion into the channels that produced it.
 *
 * A trie hit scores through `parts.priority === keywordBoost`, so the report
 * splits that back into one base `priority` share and one `keyword` share worth
 * `cfg.priority * (keywordBoost - 1)`. `channels[].contribution` therefore adds
 * up to `score` in every case. A channel whose weight is 0 contributes 0 and is
 * left out, so a suppressed channel does not pad a hover tooltip.
 *
 * @param s scored suggestion
 * @param cfg the weights the fusion used
 * @returns the tag, its score, and the contributing channels
 */
export function explainTag(s: TagSuggestion, cfg: TagScoreConfig = DEFAULT_TAG_SCORE): TagExplanation {
  const p = s.parts;
  const basePriority = p.keyword > 0 ? 1 : p.priority;
  const keywordWeight = cfg.priority * (cfg.keywordBoost - 1);
  const all: TagChannelStat[] = [
    { channel: 'tfidf', weight: cfg.tfidf, value: p.tfidf, contribution: cfg.tfidf * p.tfidf },
    { channel: 'embed', weight: cfg.embed, value: p.embed, contribution: cfg.embed * p.embed },
    { channel: 'textRank', weight: cfg.textRank, value: p.textRank, contribution: cfg.textRank * p.textRank },
    { channel: 'clusterRank', weight: cfg.clusterRank, value: p.clusterRank, contribution: cfg.clusterRank * p.clusterRank },
    { channel: 'priority', weight: cfg.priority, value: basePriority, contribution: cfg.priority * basePriority },
    { channel: 'keyword', weight: keywordWeight, value: p.keyword, contribution: keywordWeight * p.keyword },
    { channel: 'suggest', weight: cfg.suggest, value: p.suggest, contribution: cfg.suggest * p.suggest },
  ];
  const channels = all.filter((c) => c.contribution > 0).sort((a, b) => b.contribution - a.contribution);
  return {
    tag: s.tag,
    score: s.score,
    channels,
    ...(channels[0] ? { top: channels[0].channel } : {}),
    text: channels
      .map((c) => `${CHANNEL_LABEL[c.channel]} ${fixed(c.value)}×${fixed(c.weight)}=${fixed(c.contribution)}`)
      .join(' · '),
  };
}

/**
 * Hover text for one explanation: the score, the channel shares, the window the
 * score was measured in, and the fact that nothing was written.
 *
 * @param e explanation from {@link explainTag}
 * @param ctx the window and the dimension it was measured on
 * @returns multi-line text for a `title` attribute
 */
export function explanationText(
  e: TagExplanation,
  ctx?: { dim?: TagDim; window?: TagWindow },
): string {
  const lines = [`#${e.tag} · ${e.score.toFixed(3)}`, e.text || 'no channel contributed'];
  if (ctx?.window) {
    lines.push(`window ±${ctx.window.radius} (${ctx.window.indices.length} rows, ${ctx.dim ?? 'tid'})`);
  }
  lines.push('srctag suggestion — not persisted');
  return lines.join('\n');
}

// ─── Orchestration over a row set ──────────────────────────────────────────

/** Options for {@link tagRows}. */
export interface TagRowsOptions {
  score?: Partial<TagScoreConfig>;
  window?: Partial<TagWindowConfig> & { dim?: TagDim };
  /** Graph knobs of the TextRank channels. */
  rank?: TextRankOptions;
  /** Priority tags; when omitted they are read from `pins`. */
  priorityTags?: string[];
  /** Pin md cards whose headings supply the priority tags. */
  pins?: TagRow[];
  /** Extra keyword surface forms per tag. */
  synonyms?: Record<string, string[]>;
  /** Embedding function; one call per working set, and one per site bucket under `bucket: 'domain'`. */
  embed?: EmbedFn;
  /** Pre-computed vectors keyed by row `ref`; wins over `embed`. */
  embeddings?: Record<string, ArrayLike<number>>;
  /** Zero-shot classifier; called once per scored row. */
  classify?: ClassifyFn;
  /** Labels handed to `classify`. */
  labels?: string[];
  /** Restrict scoring to these `tid`s. */
  onlyTids?: number[];
  /**
   * `'domain'` scores each hostname's rows as their own working set, so a row's
   * peers are its site's rows rather than its neighbours in the array. See
   * {@link groupByDomain}.
   */
  bucket?: 'domain';
}

/**
 * Wrap an {@link EmbedFn} so no text is embedded twice across a bucketed run.
 *
 * A vector is a pure function of its text, so the second site to hold a title
 * would only repeat a request. The returned function keeps the caller's order
 * and asks the client for the texts it has not seen yet.
 *
 * @param embed the client, or undefined
 * @returns the memoizing wrapper, or undefined when there is nothing to wrap
 */
function memoEmbed(embed: EmbedFn | undefined): EmbedFn | undefined {
  if (!embed) return undefined;
  const seen = new Map<string, number[]>();
  return async (texts: string[]) => {
    const missing = [...new Set(texts.filter(t => !seen.has(t)))];
    if (missing.length > 0) {
      const fresh = await embed(missing);
      missing.forEach((t, i) => { if (fresh[i]) seen.set(t, fresh[i] as number[]); });
    }
    return texts.map(t => seen.get(t) ?? []);
  };
}

/**
 * Score tags for every row of a working set.
 *
 * Rows are ordered on the configured dimension, so the neighbour window and the
 * clusters describe one browsing run rather than the caller's array order. With
 * `bucket: 'domain'` the set is first split by hostname and each site is scored
 * on its own, which is the reading a burst of sibling links needs.
 *
 * @param rows rows to score, in any order
 * @param opts channels and configuration
 * @returns one result per scored row, in the working set's order
 */
export async function tagRows(rows: TagRow[], opts: TagRowsOptions = {}): Promise<TagRowResult[]> {
  if (opts.bucket === 'domain') {
    const out: TagRowResult[] = [];
    const embed = memoEmbed(opts.embed);
    for (const bucket of groupByDomain(rows).values()) {
      out.push(...await tagRows(bucket, { ...opts, bucket: undefined, embed }));
    }
    return out;
  }
  const cfg = mergeTagScore(opts.score);
  const windowCfg = defaultWindow(opts.window?.dim ?? 'tid', opts.window);
  const sorted = sortByDim(rows, windowCfg.dim);
  const clusters = clusterRows(sorted, windowCfg);
  const clusterOf = new Map<number, number>();
  for (const c of clusters) for (const i of c.indices) clusterOf.set(i, c.key);

  const sources = sorted.map(rowSources);
  const docs = sources.map(s => [...tokenize(s.text), ...s.urls.flatMap(urlTokens)]);
  const { vectors } = tfidfVectors(docs);

  const priority = opts.priorityTags ?? pinPriorityTags(opts.pins ?? []);
  const tagger = new TurboTextTagger(keywordEntries(priority, opts.synonyms));
  const texts = sources.map(s => [s.text, ...s.urls].join(' '));

  let embeddings: ArrayLike<number>[] | undefined;
  if (opts.embeddings) embeddings = sorted.map(r => opts.embeddings![r.ref] ?? hashEmbed(r.txt ?? ''));
  else if (opts.embed) embeddings = await opts.embed(texts);

  const only = opts.onlyTids ? new Set(opts.onlyTids) : undefined;
  const results: TagRowResult[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    if (only && (row.tid === undefined || !only.has(row.tid))) continue;
    const suggestions = opts.classify && opts.labels
      ? normalizeClassify(await opts.classify(texts[i], opts.labels))
      : undefined;
    const scored = scoreTagsForRow({
      rows: sorted, index: i, vectors, windowCfg, cfg, docs,
      rank: opts.rank,
      priority, keywords: tagger.match(texts[i]), suggestions, embeddings,
    });
    results.push({
      row,
      suggestions: rankTags(scored, cfg),
      window: neighbourhood(sorted, i, windowCfg),
      cluster: clusterOf.get(i) ?? 0,
    });
  }
  return results;
}

/** One row's suggestions with the context they were measured in. */
export interface RowTagReport {
  tid?: number;
  ref: string;
  /** Dimension the working set was ordered on. */
  dim: TagDim;
  /** Neighbour rows the TF-IDF score used. */
  window: TagWindow;
  /** Cluster index of the row within the sorted working set. */
  cluster: number;
  /** Suggested tags, each with its channel breakdown. */
  tags: TagExplanation[];
}

/**
 * Turn one scored row into the report a list can render beside it.
 *
 * @param result scored row
 * @param cfg the weights the fusion used
 * @param dim dimension the working set was ordered on
 * @returns the row's identity, window, cluster, and explained tags
 */
export function reportRowTags(
  result: TagRowResult,
  cfg: TagScoreConfig = DEFAULT_TAG_SCORE,
  dim: TagDim = 'tid',
): RowTagReport {
  return {
    tid: result.row.tid,
    ref: result.row.ref,
    dim,
    window: result.window,
    cluster: result.cluster,
    tags: result.suggestions.map((s) => explainTag(s, cfg)),
  };
}

/**
 * Score rows and return each row's tags with the stats a hover needs. The
 * lexical channels run alone unless `opts.embed` or `opts.classify` is
 * supplied, so the default path makes no request. Nothing is written; persist
 * through {@link tagRows} plus {@link planTagUpdates}.
 *
 * @param rows rows to score, in any order
 * @param opts channels and configuration
 * @returns one report per scored row, in the working set's order
 */
export async function tagRowReports(rows: TagRow[], opts: TagRowsOptions = {}): Promise<RowTagReport[]> {
  const cfg = mergeTagScore(opts.score);
  const dim = opts.window?.dim ?? 'tid';
  return (await tagRows(rows, opts)).map((r) => reportRowTags(r, cfg, dim));
}

// ─── Run statistics ────────────────────────────────────────────────────────

/** One tag's aggregate over a scored working set. */
export interface TagRunTag {
  tag: string;
  /** Rows whose report suggested the tag. */
  count: number;
  /** Best score any row gave the tag. */
  score: number;
}

/** One channel's share of a run's total contribution. */
export interface TagRunChannel {
  channel: keyof TagParts;
  /** `channel contribution / sum of all contributions`, or 0 when nothing scored. */
  share: number;
}

/** Aggregate statistics of one {@link tagRows} run, for comparing channel sets. */
export interface TagRunStats {
  /** Rows the run was given. */
  rows: number;
  /** Rows that kept at least one suggestion. */
  scored: number;
  /** Suggestions across all rows, before {@link rankTags} cut them. */
  suggested: number;
  /** Distinct tags suggested. */
  distinct: number;
  /** Rows that kept no suggestion. */
  empty: number;
  meanScore: number;
  maxScore: number;
  /** Suggestions whose tag is a priority tag or a keyword match. */
  priorityHits: number;
  /** Channel shares, largest first. */
  channels: TagRunChannel[];
  /** Most widespread tags first, then by best score. */
  topTags: TagRunTag[];
}

/** Four decimals keep a printed statistic stable across runs. */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Fold a run's results into the numbers that compare one channel set against
 * another: how many rows kept a tag, how many tags came back, how the score
 * split over the channels, and which tags spread widest.
 *
 * Channel shares come from {@link explainTag}, so they add up to the run's
 * score total whether or not a channel is weighted.
 *
 * @param results scored rows
 * @param cfg the weights the fusion used
 * @param topK how many tags {@link TagRunStats.topTags} lists
 * @returns the run's statistics
 */
export function summarizeTagRun(
  results: TagRowResult[],
  cfg: TagScoreConfig = DEFAULT_TAG_SCORE,
  topK = 8,
): TagRunStats {
  const hits = new Map<string, TagRunTag>();
  const byChannel = new Map<keyof TagParts, number>();
  let suggested = 0;
  let sum = 0;
  let max = 0;
  let priorityHits = 0;
  let empty = 0;

  for (const result of results) {
    if (result.suggestions.length === 0) empty++;
    for (const s of result.suggestions) {
      suggested++;
      sum += s.score;
      max = Math.max(max, s.score);
      if (s.parts.priority > 0) priorityHits++;
      const held = hits.get(s.tag);
      if (held) {
        held.count++;
        held.score = Math.max(held.score, s.score);
      } else {
        hits.set(s.tag, { tag: s.tag, count: 1, score: s.score });
      }
      for (const c of explainTag(s, cfg).channels) {
        byChannel.set(c.channel, (byChannel.get(c.channel) ?? 0) + c.contribution);
      }
    }
  }

  const total = [...byChannel.values()].reduce((a, b) => a + b, 0);
  const channels = [...byChannel.entries()]
    .map(([channel, v]) => ({ channel, share: total > 0 ? round4(v / total) : 0 }))
    .sort((a, b) => b.share - a.share || a.channel.localeCompare(b.channel));
  const topTags = [...hits.values()]
    .sort((a, b) => (b.count - a.count) || (b.score - a.score) || a.tag.localeCompare(b.tag))
    .slice(0, topK)
    .map((t) => ({ tag: t.tag, count: t.count, score: round4(t.score) }));

  return {
    rows: results.length,
    scored: results.length - empty,
    suggested,
    distinct: hits.size,
    empty,
    meanScore: suggested > 0 ? round4(sum / suggested) : 0,
    maxScore: round4(max),
    priorityHits,
    channels,
    topTags,
  };
}

/** Accept classifier output in the shapes the adapters may produce. */
function normalizeClassify(raw: unknown): { tag: string; score: number }[] {
  const one = (v: unknown): { tag: string; score: number } | undefined => {
    if (typeof v === 'string') return { tag: v, score: 1 };
    const o = v as { tag?: unknown; label?: unknown; score?: unknown } | null;
    const tag = o?.tag ?? o?.label;
    return typeof tag === 'string'
      ? { tag, score: typeof o?.score === 'number' ? o.score : 1 }
      : undefined;
  };
  if (Array.isArray(raw)) {
    return raw.map(one).filter((r): r is { tag: string; score: number } => r !== undefined);
  }
  const single = one(raw);
  return single ? [single] : [];
}

/**
 * Use case 1 — discovery when a pin card is saved.
 *
 * @param pins pin cards whose headings carry the priority tags
 * @param rows rows to tag
 * @param opts channels and configuration
 * @returns scored rows, ordered on the visit-time dimension by default
 */
export function tagRowsForPinSave(pins: TagRow[], rows: TagRow[], opts: TagRowsOptions = {}): Promise<TagRowResult[]> {
  return tagRows(rows, { ...opts, pins, window: { dim: 'visitTime', ...opts.window } });
}

/**
 * Use case 2 — interactive tagging of the rows the user picked in the agent chat.
 *
 * @param rows rows the chat is working on
 * @param tids the rows to tag
 * @param opts channels and configuration
 * @returns scored rows, on the insert-order dimension by default
 */
export function tagRowsInteractive(rows: TagRow[], tids: number[], opts: TagRowsOptions = {}): Promise<TagRowResult[]> {
  return tagRows(rows, { ...opts, onlyTids: tids, window: { dim: 'tid', ...opts.window } });
}

/**
 * Use case 3 — initial tagging when the extension sweeps active tabs.
 *
 * @param rows swept tab rows
 * @param opts channels and configuration
 * @returns scored rows, on the insert-order dimension by default
 */
export function tagSweepRows(rows: TagRow[], opts: TagRowsOptions = {}): Promise<TagRowResult[]> {
  return tagRows(rows, { ...opts, window: { dim: 'tid', ...opts.window } });
}

// ─── Network adapters (direct fetch; the endpoint must be CORS-open) ────────

/** Endpoint, model, and credential of one API. No key is baked into this module. */
export interface TagApiConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  headers?: Record<string, string>;
  /** Abort the request after this many milliseconds. */
  timeoutMs?: number;
}

/** Cloudflare Workers AI also needs the account the model runs under. */
export interface CloudflareEmbedConfig extends TagApiConfig {
  accountId: string;
}

/** Texts in, one vector per text out, in the same order. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** Text and labels in, scored tags out. */
export type ClassifyFn = (text: string, labels: string[]) => Promise<{ tag: string; score: number }[]>;

/** POST `body` as JSON and parse the response, with a timeout and a status check. */
async function fetchJson(url: string, body: unknown, cfg: { apiKey?: string; headers?: Record<string, string>; timeoutMs?: number }, extra: Record<string, string> = {}): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        ...(cfg.headers ?? {}),
        ...extra,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** `/v1/embeddings` of an OpenAI-compatible provider, from a base URL with or without `/v1`. */
function embeddingsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/v1$/.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`;
}

/**
 * OpenAI-compatible embeddings client (`BAAI/bge-m3` on Silicon Flow,
 * `nvidia/nemotron-3-embed-1b:free` on OpenRouter, and others).
 *
 * The provider must allow this page's origin; a browser cannot reach a provider
 * that refuses CORS.
 *
 * @param cfg endpoint, model, and credential
 * @returns an {@link EmbedFn} posting one batch per call
 */
export function createEmbedClient(cfg: TagApiConfig): EmbedFn {
  return async (texts: string[]) => {
    const json = await fetchJson(embeddingsUrl(cfg.baseUrl), {
      model: cfg.model, input: texts, encoding_format: 'float',
    }, cfg);
    const rows: { index?: number; embedding: number[] }[] = json?.data ?? [];
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('embeddings response carried no data');
    return rows
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map(r => r.embedding);
  };
}

/** Silicon Flow's OpenAI-compatible endpoint (`BAAI/bge-m3` by default). */
export function createSiliconFlowEmbed(cfg: Partial<TagApiConfig> & { apiKey: string }): EmbedFn {
  return createEmbedClient({ baseUrl: 'https://api.siliconflow.cn', model: 'BAAI/bge-m3', ...cfg });
}

/** OpenRouter's embeddings route; verify the model and route before wiring it. */
export function createOpenRouterEmbed(cfg: Partial<TagApiConfig> & { apiKey: string }): EmbedFn {
  return createEmbedClient({ baseUrl: 'https://openrouter.ai/api', model: 'nvidia/nemotron-3-embed-1b:free', ...cfg });
}

/**
 * Cloudflare Workers AI (`@cf/baai/bge-m3` by default).
 *
 * @param cfg account, model, and credential
 * @returns an {@link EmbedFn}
 */
export function createCloudflareEmbed(cfg: Omit<CloudflareEmbedConfig, 'baseUrl'> & { baseUrl?: string }): EmbedFn {
  const baseUrl = cfg.baseUrl
    ?? `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/run`;
  return async (texts: string[]) => {
    const json = await fetchJson(`${baseUrl.replace(/\/+$/, '')}/${cfg.model}`, { text: texts }, cfg);
    const data = json?.result?.data ?? json?.data;
    if (!Array.isArray(data) || data.length === 0) throw new Error('Cloudflare response carried no data');
    return data as number[][];
  };
}

/**
 * A zero-shot classifier over classifier.dev's `POST {base}/v1/classify`.
 *
 * The body is `{ inputs, labels, instructions }`. The response may be
 * `{ label, score }`, `{ labels: [{ label, score }] }`, `{ results: [...] }`, or
 * an array of those entries; all normalize to scored tags.
 *
 * @param cfg endpoint, optional credential, and the instruction text
 * @returns a {@link ClassifyFn}
 */
export function createClassifierDevClassify(
  cfg: Partial<TagApiConfig> & { baseUrl?: string; instructions?: string } = {},
): ClassifyFn {
  const base = (cfg.baseUrl ?? 'https://classifier.dev').replace(/\/+$/, '');
  const url = /\/v1\/classify$/.test(base) ? base : `${base}/v1/classify`;
  return async (text: string, labels: string[]) => {
    const json = await fetchJson(url, {
      inputs: [text],
      labels,
      instructions: cfg.instructions
        ?? 'Pick the single best-fitting label and give a 0-1 confidence.',
    }, cfg);
    return normalizeClassify(json?.labels ?? json?.results ?? json?.outputs ?? json);
  };
}

/**
 * Run an {@link EmbedFn} in chunks, so a large sweep does not exceed a
 * provider's per-request input limit.
 *
 * @param embed the client
 * @param texts texts to embed
 * @param opts chunk size and progress callback
 * @returns one vector per text, in order
 */
export async function embedBatch(
  embed: EmbedFn,
  texts: string[],
  opts: { batchSize?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<number[][]> {
  const size = Math.max(1, opts.batchSize ?? 32);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += size) {
    out.push(...await embed(texts.slice(i, i + size)));
    opts.onProgress?.(Math.min(texts.length, i + size), texts.length);
  }
  return out;
}

/** Vector store {@link embedWithCache} reads and fills; xbb backs it with the `vecs` table. */
export interface TagVectorCache {
  get(key: string): ArrayLike<number> | undefined;
  set(key: string, vec: number[]): void;
}

/**
 * Embed only the texts the cache is missing, so a repeated sweep pays for new
 * rows only.
 *
 * @param embed the client
 * @param model cache-namespacing model id
 * @param texts texts to embed
 * @param cache the store to read and fill
 * @returns one vector per text, in order
 */
export async function embedWithCache(
  embed: EmbedFn,
  model: string,
  texts: string[],
  cache: TagVectorCache,
): Promise<number[][]> {
  const key = (t: string) => `${model}|${t}`;
  const missing: { i: number; text: string }[] = [];
  const out: number[][] = new Array(texts.length);
  texts.forEach((text, i) => {
    const hit = cache.get(key(text));
    if (hit) out[i] = Array.from(hit);
    else missing.push({ i, text });
  });
  if (missing.length > 0) {
    const fresh = await embed(missing.map(m => m.text));
    missing.forEach((m, k) => {
      out[m.i] = fresh[k];
      if (fresh[k]) cache.set(key(m.text), fresh[k]);
    });
  }
  return out;
}

// ─── Dynamic adapters from `type='src'` rows ───────────────────────────────

/** Ref convention of the src row whose default export is an {@link EmbedFn}. */
export const SRCTAG_EMBED_REF = 'srctag/embed.js';
/** Ref convention of the src row whose default export is a {@link ClassifyFn}. */
export const SRCTAG_CLASSIFY_REF = 'srctag/classify.js';
/** Ref convention of the md row listing extra keywords, in the {@link parseKeywordDoc} dialect. */
export const SRCTAG_KEYWORDS_REF = 'srctag/keywords.md';
/** Ref convention of the src row that compares neighbourhood rules over one row set. */
export const SRCTAG_SUGGEST_REF = 'srctag/suggest.js';
/** Ref convention of the same comparison, its API channels defaulted to the `ds` provider. */
export const SRCTAG_SUGGEST_DS_REF = 'srctag/suggest-ds.js';

/** Which adapter a src row provides. */
export type TagAdapterKind = 'embed' | 'classify';

/**
 * Run one `type='src'` body and take its adapter.
 *
 * The body's result is the adapter. A function body therefore `return`s it; a
 * module's default export is called with `ctx` by `runsrc.runBody`, so a module
 * exports a factory — `export default (ctx) => embedFn`. `ctx` is how the row
 * reaches `db` for its key without this module importing the store.
 *
 * @param body row text of the src row
 * @param kind which adapter the row must supply
 * @param ctx value handed to the body
 * @returns the adapter
 * @throws when the body's result carries no function
 */
export async function loadTagAdapter(
  body: string,
  kind: TagAdapterKind,
  ctx: RecrScriptContext,
): Promise<EmbedFn | ClassifyFn> {
  const value = await runBody(body, ctx);
  const fn = typeof value === 'function' ? value : (value as Record<string, unknown> | null)?.[kind];
  if (typeof fn !== 'function') {
    throw new Error(`src row must result in a function; a module exports default (ctx) => ${kind}Fn`);
  }
  return fn as EmbedFn | ClassifyFn;
}

/** The parts of `IRecrStore` this module needs to read a src row. */
export interface TagScriptSource {
  readScript(ref: string): Promise<string | undefined>;
}

/**
 * Load whichever adapters the store has rows for.
 *
 * A missing row is normal: the sweep then uses the built-in lexical channels
 * plus {@link hashEmbed}. A row that throws is reported and skipped the same
 * way, so one bad script cannot stop a sweep.
 *
 * @param store store holding the `srctag/*` rows
 * @param ctx value handed to each body
 * @returns the adapters that loaded
 */
export async function loadAdaptersFromStore(
  store: TagScriptSource,
  ctx: RecrScriptContext,
): Promise<{ embed?: EmbedFn; classify?: ClassifyFn }> {
  const out: { embed?: EmbedFn; classify?: ClassifyFn } = {};
  const pairs: [TagAdapterKind, string][] = [['embed', SRCTAG_EMBED_REF], ['classify', SRCTAG_CLASSIFY_REF]];
  for (const [kind, ref] of pairs) {
    const body = await store.readScript(ref);
    if (body === undefined) continue;
    try {
      const fn = await loadTagAdapter(body, kind, { ...ctx, ref });
      if (kind === 'embed') out.embed = fn as EmbedFn;
      else out.classify = fn as ClassifyFn;
    } catch (e) {
      ctx.console.warn(`[srctag] ${ref} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

// ─── Write-back ────────────────────────────────────────────────────────────

/** Where a written tag came from, recorded under {@link TAG_AUTO_KEY}. */
export interface TagProvenance {
  score: number;
  /** Channel that proposed it, e.g. `tfidf+emb` or `classify`. */
  src: string;
  /** ISO timestamp of the write. */
  at: string;
}

/** How {@link planTagUpdates} treats tags the row already carries. */
export type TagApplyMode = 'add' | 'replaceAuto' | 'replace';

/** The field changes one row needs. */
export interface TagUpdate {
  tid: number;
  ref: string;
  /** Tags to add, already absent from the row. */
  add: string[];
  /** Tags to remove. */
  remove: string[];
  /** The resulting tag array. */
  tags: string[];
  /** The resulting `rec`, carrying the new provenance entries. */
  rec: Record<string, unknown>;
}

/** Options for {@link planTagUpdates}. */
export interface PlanTagOptions {
  /** `add` only adds; `replaceAuto` also removes what a previous run wrote; `replace` sets the list. */
  mode?: TagApplyMode;
  /** Channel name recorded in the provenance. */
  src?: string;
  /** Tags never removed. */
  keep?: string[];
  /** When set, only these tags are written or pruned; the other channels' proposals are dropped. */
  only?: string[];
  /** Timestamp for the provenance records. */
  at?: number;
  /** Tombstone value; defaults to {@link TAG_DEL}. */
  delTag?: string;
}

/** `existing` minus `remove` plus `add`, order preserved. */
export function mergeTags(existing: string[], add: string[], remove: string[] = []): string[] {
  const drop = new Set(remove);
  const out = existing.filter(t => !drop.has(t));
  for (const t of add) if (!out.includes(t)) out.push(t);
  return out;
}

/**
 * Turn scored results into row updates.
 *
 * `[del]` tombstones and the `keep` list are never removed, so a re-run cannot
 * resurrect a deleted row or drop a tag the user pinned by hand. Every mode
 * records the score and channel of each written tag under `rec.tagAuto`, which
 * is what `replaceAuto` reads back to prune its own previous output.
 *
 * @param results scored rows
 * @param opts mode, provenance, and exclusions
 * @returns one update per scored row that has a `tid`
 */
export function planTagUpdates(results: TagRowResult[], opts: PlanTagOptions = {}): TagUpdate[] {
  const mode = opts.mode ?? 'add';
  const src = opts.src ?? 'srctag';
  const at = new Date(opts.at ?? Date.now()).toISOString();
  const del = opts.delTag ?? TAG_DEL;
  const keep = new Set(opts.keep ?? []);
  const only = opts.only ? new Set(opts.only) : undefined;
  const out: TagUpdate[] = [];

  for (const result of results) {
    const tid = result.row.tid;
    if (typeof tid !== 'number') continue;
    const existing = result.row.tags ?? [];
    const kept = only ? result.suggestions.filter(s => only.has(s.tag)) : result.suggestions;
    const scored = kept.map(s => s.tag);
    const prov = { ...(result.row.rec?.[TAG_AUTO_KEY] as Record<string, TagProvenance> ?? {}) };

    let remove: string[] = [];
    if (mode === 'replaceAuto') {
      remove = Object.keys(prov).filter(t => !scored.includes(t) && (!only || only.has(t)));
    }
    if (mode === 'replace') {
      remove = existing.filter(t => !scored.includes(t) && (!only || only.has(t)));
    }
    remove = remove.filter(t => t !== del && !keep.has(t) && existing.includes(t));

    const tags = mergeTags(existing, scored, remove);
    const rec: Record<string, unknown> = { ...(result.row.rec ?? {}) };
    for (const t of remove) delete prov[t];
    for (const s of kept) prov[s.tag] = { score: round3(s.score), src, at };
    if (Object.keys(prov).length > 0) rec[TAG_AUTO_KEY] = prov;
    else delete rec[TAG_AUTO_KEY];

    out.push({ tid, ref: result.row.ref, add: scored.filter(t => !existing.includes(t)), remove, tags, rec });
  }
  return out;
}

/** Three decimals is enough for a recorded score and keeps rows small. */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Where {@link commitTagUpdates} sends each row update. */
export interface TagWritePort {
  write(update: TagUpdate): Promise<unknown>;
}

/** Dexie-like table surface: `das` from `sdb` satisfies it. */
export interface TagWriteTable {
  update(key: number, changes: Record<string, unknown>): Promise<unknown>;
}

/**
 * Port writing `tags`, `rec`, and a local `modAt` stamp, so the next sync
 * pushes the change. A caller that also needs the version shelf `sdb.daEdit`
 * records composes its own port over `daEdit` instead.
 *
 * @param table table to update
 * @param now stamp to write as `modAt`
 * @returns the port
 */
export function dexieTagPort(table: TagWriteTable, now: () => Date = () => new Date()): TagWritePort {
  return {
    write: (u) => table.update(u.tid, { tags: u.tags, rec: u.rec, modAt: now() }),
  };
}

/** Port over an arbitrary write function, for callers with their own row recipe. */
export function customTagPort(write: (update: TagUpdate) => Promise<unknown>): TagWritePort {
  return { write };
}

/**
 * Write every planned update, stopping at the first failure.
 *
 * @param port destination
 * @param updates planned updates
 * @returns the number of rows written
 */
export async function commitTagUpdates(port: TagWritePort, updates: TagUpdate[]): Promise<number> {
  let n = 0;
  for (const u of updates) {
    await port.write(u);
    n++;
  }
  return n;
}

// ─── Global installation for `run_src` ─────────────────────────────────────

/** Everything {@link installSrctagGlobal} publishes. */
export interface SrctagApi {
  tagRows: typeof tagRows;
  tagRowsForPinSave: typeof tagRowsForPinSave;
  tagRowsInteractive: typeof tagRowsInteractive;
  tagSweepRows: typeof tagSweepRows;
  planTagUpdates: typeof planTagUpdates;
  commitTagUpdates: typeof commitTagUpdates;
  dexieTagPort: typeof dexieTagPort;
  customTagPort: typeof customTagPort;
  pinPriorityTags: typeof pinPriorityTags;
  loadAdaptersFromStore: typeof loadAdaptersFromStore;
  keywordEntries: typeof keywordEntries;
  parseKeywordDoc: typeof parseKeywordDoc;
  tokenize: typeof tokenize;
  rankTags: typeof rankTags;
  /** TextRank centrality of a token list. */
  textRank: typeof textRank;
  /** Aggregate a scored run into the numbers a channel comparison prints. */
  summarizeTagRun: typeof summarizeTagRun;
  /** Bucket rows by hostname, for a domain-clustered working set. */
  groupByDomain: typeof groupByDomain;
  /** Hostname of one row, `www.` stripped. */
  rowDomain: typeof rowDomain;
}

/** The public surface, as a plain object. */
export function srctagApi(): SrctagApi {
  return {
    tagRows, tagRowsForPinSave, tagRowsInteractive, tagSweepRows,
    planTagUpdates, commitTagUpdates, dexieTagPort, customTagPort,
    pinPriorityTags, loadAdaptersFromStore, keywordEntries, parseKeywordDoc,
    tokenize, rankTags, textRank, summarizeTagRun, groupByDomain, rowDomain,
  };
}

/**
 * Publish {@link srctagApi} on `target.srctag`.
 *
 * A `type='src'` row cannot `import` this file: `runsrc` evaluates it from a
 * `data:` URL, which has no base for a relative specifier. Installing the API
 * on the global object is what makes a `run_src` row able to call it, e.g.
 * `const rows = await ctx.db.das.toArray(); return await srctag.tagRows(rows)`.
 *
 * @param target object to attach to; defaults to the current global
 * @returns the api that was installed
 */
export function installSrctagGlobal(
  target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): SrctagApi {
  const api = srctagApi();
  target.srctag = api;
  return api;
}
