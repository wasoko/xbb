/**
 * restHelp.ts — the hover text behind the rest tuner's controls and the rest
 * panel's readings.
 *
 * The strip above the blocks is dense on purpose: labels stay short so one
 * family's whole knob set fits on a line. This module holds the sentences a label
 * cannot carry — what a control moves, and which control moves the thing a
 * reading is showing — so a control is explained where it is read.
 *
 * Nothing here holds state; the components set these lines as a native `title`.
 * `group` is the one `TagParts` key with no tuner control, because the aim pass
 * writes it, not a weight.
 */

import { TAG_CHANNEL_LABEL, type TagParts, type TagScoreConfig } from '../srctag';
import type { RestVizMode, RestWindowMode } from './restGrouper';

/** One line per grouper ref, for the strip's own name. */
export const PROFILE_HELP: Record<string, string> = {
  rstag: 'the fused channels — TF-IDF, the embed fallback and the pin tags; chips only, aim off',
  rstext: 'the two TextRank walks over the row and its site\'s rows, on the visit-time window; TF-IDF off',
  rsfreq: 'TF-IDF against the neighbour centroid, over the row\'s title alone',
  rstrank: 'the two TextRank walks: the row\'s own centrality and its burst\'s',
  rstt: 'the TurboText Aho–Corasick trie, over the pin cards and `keywords.md`',
  rrf: 'the 3-stage chain: TurboText candidates, BM25F over the title and the row\'s tags, then a rank fusion of that with the semantic and TextRank lists; sub-tags come from c-TF-IDF over each burst',
};

/**
 * What one weight moves, and — where it matters — which other control undoes it.
 * The keys are the `TagParts` channels the tuner renders under
 * `TAG_CHANNEL_LABEL`.
 */
export const CHANNEL_HELP: Record<keyof TagParts, string> = {
  tfidf: 'the row\'s words against its neighbours\': a word rare in the burst scores higher',
  bm25: 'the BM25F list: a word the title carries outranks the same word in a URL, `k1` discounts repetition and `b` normalizes a long field. `rrf` is the family that runs it',
  embed: 'the row against its neighbours\' vectors; without the `dyn` adapter this is the 64-bin hash fallback, not a model',
  textRank: 'each word\'s centrality in the row\'s own title. Generic words (`why`, `like`) score near 1 here — drop them with `minLen` or `min`',
  clusterRank: 'the same walk over the burst\'s pooled words, counted only where the row carries the word',
  priority: 'the lift a curated tag gets: a pin card\'s `#tag` heading, or a trie hit',
  keyword: 'the trie hit itself, on top of the `priority` lift; `rstt` is the family that sets it',
  suggest: 'classifier labels, the channel the `dyn` adapter feeds',
  group: 'rows that proposed a promoted sub-tag — set by the aim pass, not a knob',
};

/** One line per tuner control, keyed by the control rather than by its rendered label. */
export const TUNER_HELP: Record<string, string> = {
  viz: 'which reading the panel draws below, and which of them replace the blocks: `chips` leaves the tag layer beside each row, `clusters` files every row under the tag each one kept, `priority` splits the rows by whether a curated tag was kept, and `themes` by burst and anchor. `channels` and `keywords` add a bar or a term list and leave the blocks alone',
  aim: 'run the aim pass over the scored set: focus drops a suggestion neither a curated tag nor the `aimMin` cut-off carried, and promote mints `parent/theme` for a term a burst shares. On `rrf` over short titles the cut-off barely bites — every candidate sits in the first ranks of every list — so `topK` and the pre-processing are what decide the chip list',
  aimMin: 'the score a suggestion the priority half did not carry must clear, on a fused scale where 1 is the top of every list the pass ran. Inert on a TextRank-scored family (a normalized centrality puts most words near 1) and on `rrf` over short titles; raise it to keep only what several signals agree on',
  promoteMin: 'rows of one burst that must propose a word before the aim pass mints it as a sub-tag. A burst is a cluster of the window on screen, so the `window` switch decides whether this knob is reachable at all',
  promoteTop: 'most sub-tags one promote group mints, most widespread first. Without a cap, a group that is not really one burst mints a sub-tag for every word three of its rows share',
  dyn: 'load the store\'s `srctag/*` adapters into the pass: one batched embedding call over the rows and the candidate terms, then one classifier call per scored row. Off leaves the semantic list out of the fusion, which `channels` shows as a missing `embed` bar',
  window: 'what a row is read against: its `tid` neighbours, its `dt` neighbours, its visit-time neighbours, or its own site alone. It sets the neighbour window *and* the clusters the bucket half groups by, so switching it changes both what scores a row and what counts as a burst',
  urls: 'let the row\'s `ref` and its Markdown links feed the token bag the trie, both graph walks and the semantic list read. Hostname labels (`dev`, `docs`) are the noisiest evidence a link row has, and on a list of one site\'s pages they are on every row — which is why `rrf` ships them out',
  topK: 'most tags one row keeps. On `rrf` this is the knob that decides the chip list: the fused score is flat over ranks, so the cut-off and the aim pass keep nearly everything and only this cap shortens it',
  minScore: 'cut-off — a suggestion below this is dropped. On a fused `rrf` score the scale is flat (every candidate sits in the first ranks), so moving it changes little; use `topK` to shorten the list and the pre-processing to improve it',
  rows: 'newest rows the pass scores. Everything the panel counts is over these rows alone, so a shorter window reads the rest as unscored. `rrf` ships it empty — the box says `all` — because its clusters are a reading of the whole window; typing a number caps it again',
  graphWindow: 'the token distance at which two words join the TextRank graph. Wider links more words and flattens the walk',
  damping: 'damping of that walk: the share of its weight a word passes on rather than keeps',
  iterations: 'iteration cap of the walk, which also stops early at `tol`',
  tol: 'the walk stops when no word\'s score moves by more than this',
  minLength: 'characters a word needs to enter both TextRank walks — it can still be a chip through BM25F, which reads the title and the row\'s tags. It counts characters, so raising it to drop `vs` also drops every two-character CJK bigram',
  trieDistance: 'edit budget of a fuzzy trie match; above 0 the scan costs O(text × forms × distance)',
  trieOverlap: 'which overlapping matches survive: greedy takes the longest form and consumes its span, optimal the non-overlapping set with the most matched text',
  bm25K1: 'BM25F term-frequency saturation: lower discounts a repeated word sooner, so writing a word five times in a title buys less',
  bm25B: 'BM25F length normalization: 0 ignores how long a field is, 1 fully normalizes it, so a long title cannot out-score a short one by length alone',
  bm25Field: 'how much one BM25F field counts when a word appears in it. `title` names the item, `tags` is what the row is already filed under, and `url` is the field its own switch governs — weighting it 0 is what stops a URL pattern being read as a topic',
  rrfK: 'the rank constant of the fusion: how much a first place is worth. Larger flattens the lists towards equal, so a word one list ranks low still contributes; smaller lets the top of each list decide. It moves the printed suggestion counts a lot and the per-row chip count very little, because every candidate of a short title is already in the first ranks',
  maxDf: 'share of the rows that may carry a word before it is dropped as a corpus-wide term, over the title, the URL and the row\'s own tags together. This is what keeps a pattern on every row — the site in a list of its own pages, the browser in every query string — out of the chips. It needs a corpus: a pass shorter than 8 rows reads every term as evidence',
  stop: 'function words dropped by name, on top of the tokenizer\'s own list. A short title\'s `vs`, `how` and `any` are central to its graph walk and rare enough to pass the frequency floor, so this is the only knob that removes them without also removing two-character CJK words',
  bucketLambda: 'MMR trade-off in sub-tag discovery: 1 keeps the highest c-TF-IDF words, 0 the most distinct ones, so near-synonyms of a theme already picked do not all become sub-tags',
  bucketGraph: 'share of the burst\'s TextRank centrality folded into a theme\'s c-TF-IDF score: the difference between a word the burst merely contains and one it keeps returning to',
  reset: 'restore this grouper\'s profile defaults',
};

/** One line per panel reading. */
export const VIZ_HELP: Record<RestVizMode, string> = {
  chips: 'the tag layer beside each row, and nothing replaced',
  clusters: 'one block per tag the rows kept, headed by the tag itself with its right border dropped so the box opens onto its rows. A row joins the highest-scored tag the priority half carried, or its top-ranked tag when nothing curated carried it; the pin cards\' tags lead, then the widest clusters. A tag fewer than three rows keep is no cluster: those rows trail with their own chips, then a row that kept nothing under `(no suggestion)`. This reading draws no bars — hover a head for the channels behind it and the rows it holds',
  priority: 'rows on a curated tag vs none, then one bar per tag kept by more than one row — the priority-backed ones in green, with the count of one-off tags beside them. `topK` shortens the list and the pre-processing (`stop`, `max df`) cleans it; a generic word a graph channel lifted leaves through `minLen`',
  themes: 'one line per burst-and-anchor group sharing a word: the evidence behind a promoted sub-tag. Calibrate with `promote ≥` and `themes ≤`',
  channels: 'one bar per channel, sized by its share of the pass\'s total contribution',
  keywords: 'the forms the trie matched, with row counts and an example title',
};

/** One line per window mode, for the `window` select. */
export const WINDOW_HELP: Record<RestWindowMode, string> = {
  tid: 'read the row against its neighbours by insert order',
  dt: 'read the row against its neighbours by sync time',
  visitTime: 'read the row against the rows opened around the same time',
  domain: 'read the row against the other rows of its own hostname, on the visit-time window',
};

/**
 * The hover text for one channel knob.
 *
 * @param knob - the `TagParts` key the tuner renders.
 * @returns the help line.
 */
export const knobHelp = (knob: keyof TagParts): string => CHANNEL_HELP[knob];

/** The display label one channel knob renders under, so a caller pairs the two. */
export const knobLabel = (knob: keyof TagParts): string => TAG_CHANNEL_LABEL[knob];

/**
 * What a reading does *not* show for the family on screen.
 *
 * The panel offers the same five readings for every grouper, so one of them can
 * be beside the point here: `keyword hits` lists the trie's matches, and only
 * `rstt` scores a hit on its own. The other families use a hit to lift a curated
 * tag, so there the reading says where a chip came from rather than what scored it.
 *
 * @param mode - the reading rendered.
 * @param score - the weights the pass runs with.
 * @returns the caveat, or undefined when the reading informs this family.
 */
export function vizCaveat(mode: RestVizMode, score: Partial<TagScoreConfig>): string | undefined {
  if (mode === 'keywords' && !(score.keyword ?? 0)) {
    return 'this family leaves the `keyword` weight off: a trie hit only lifts a curated tag here, and `rstt` is the grouper that scores the hits themselves.';
  }
  return undefined;
}
