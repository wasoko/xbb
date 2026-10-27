/**
 * starTagger.ts — the `star.tagger.md` document: the star's seed overrides, the
 * overridable relation mapping, and the legacy taxonomy section an older build wrote.
 *
 * The dialect is deliberately small and local. It shares no parser with
 * `srcfeed.ts`: a `##` opens a section, `key: value` lines under `## Setup` are
 * the overrides, `## Mapping` is generated once and then left editable, and a
 * `## Taxonomy` section written by an older build is still readable. A missing key
 * leaves the existing qarf profile in force, so a fresh row changes nothing until
 * the user adds a line.
 *
 * The generated taxonomy *table* is not in this document: it changes on every seed,
 * so `ui/starTaggerRun.ts` caches it in `db.bins` with the seed it was read from.
 *
 * `## Setup` keys:
 *   base: 5000       tab/tag rows pulled for the qarf seed
 *   trace: 555       table rows cached with the seed
 *   maxGraph: 1111   graph nodes built before the table is cut
 *   alias: js = javascript, k8s = kubernetes
 *   noSyn/noTheme/noWeb: yes  ignore that relation group when the sea reads the mapping
 *   reset: no        `yes` rebuilds the taxonomy and the mapping once, then becomes `no`
 *   alpha/floor/ceil optional qarf overrides
 */

/** Row ref holding the star's seed overrides and its generated taxonomy. */
export const STAR_TAGGER_REF = 'star.tagger.md';

/** Suffix every star tagger document's ref ends in. */
export const TAGGER_REF_SUFFIX = '.tagger.md';

/** `base` default: tab/tag rows pulled for the qarf seed. */
export const STAR_BASE_DEFAULT = 5000;

/** Upper bound on a hand-written `base`, so one row cannot freeze the tab. */
export const STAR_BASE_MAX = 50_000;

/** `trace` default: table rows cached with the seed. */
export const STAR_TRACE_DEFAULT = 555;

/** Upper bound on a hand-written `trace`. */
export const STAR_TRACE_MAX = 5_000;

/** `maxGraph` default: nodes built for the taxonomy graph. */
export const STAR_GRAPH_DEFAULT = 1111;

/** Upper bound on a hand-written `maxGraph`. */
export const STAR_GRAPH_MAX = 5_000;

/** `recent` default: newest rows that make the trend pass's recent head. */
export const STAR_RECENT_DEFAULT = 500;

/** Upper bound on a hand-written `recent`. */
export const STAR_RECENT_MAX = 50_000;

/** `minRecent` default: recent rows a tag needs before it can emerge. */
export const STAR_MIN_RECENT_DEFAULT = 3;

/** Upper bound on a hand-written `minRecent`. */
export const STAR_MIN_RECENT_MAX = 1_000;

/** `minLift` default: recent rate over older rate a tag needs to emerge. */
export const STAR_MIN_LIFT_DEFAULT = 2;

/** Upper bound on a hand-written `minLift`, so one line cannot hide every tag. */
export const STAR_MIN_LIFT_MAX = 100;

/** The overrides one `star.tagger.md` carries. */
export interface StarTaggerSetup {
  /** Tab/tag rows pulled for the seed; absent reads {@link STAR_BASE_DEFAULT}. */
  base?: number;
  /** Table rows cached with the seed; absent reads {@link STAR_TRACE_DEFAULT}. */
  trace?: number;
  /** Graph nodes built before the trace is cut; absent reads {@link STAR_GRAPH_DEFAULT}. */
  maxGraph?: number;
  /** Newest rows that make the trend pass's recent head. */
  recent?: number;
  /** Recent rows a tag needs before it can emerge. */
  minRecent?: number;
  /** Recent rate over older rate a tag needs to emerge, unless the older rate is zero. */
  minLift?: number;
  /** Alias -> canonical tag, as written in `alias:` lines. */
  alias: Record<string, string>;
  /** Ignore the generated `### Synonyms` relations whichever copy is read. */
  noSyn: boolean;
  /** Ignore the generated `### Themes` relations whichever copy is read. */
  noTheme: boolean;
  /** Ignore the generated `### Web` relations whichever copy is read. */
  noWeb: boolean;
  /** `reset: yes` asks for one forced taxonomy and mapping rebuild. */
  reset: boolean;
  /** Optional qarf steepness override. */
  alpha?: number;
  /** Optional lowest lexical share. */
  floor?: number;
  /** Optional highest lexical share. */
  ceil?: number;
  /** Lines the parser could not use, for the trace header. */
  notes: string[];
}

/** The document split into its head and its sections. */
export interface StarTaggerDoc {
  /** Text before the first `##` section. */
  head: string;
  /** Parsed `## Setup` overrides. */
  setup: StarTaggerSetup;
  /** Overridable `## Mapping` body: aliases, synonyms, themes and web relations. */
  mapping: string;
  /** A generated `## Taxonomy` body an older build wrote; kept as the first-mount fallback. */
  taxonomy: string;
  /** User-authored `## Notes` body. */
  notes: string;
}

/** A fresh setup: no overrides, no aliases, no reset. */
export const DEFAULT_STAR_SETUP: StarTaggerSetup = {
  alias: {}, noSyn: false, noTheme: false, noWeb: false, reset: false, notes: [],
};

/** A fresh setup object, safe for a caller that may mutate it. */
export const defaultStarSetup = (): StarTaggerSetup => ({ ...DEFAULT_STAR_SETUP, alias: {}, notes: [] });

/** The document a missing row is seeded with. */
export const STAR_TAGGER_DOC = `# star.tagger

## Setup
# base: 5000
# trace: 555
# maxGraph: 1111
# recent: 500
# minRecent: 3
# minLift: 2
# alias: js = javascript, k8s = kubernetes
# noSyn: no
# noTheme: no
# noWeb: no
# reset: no

## Mapping

## Notes
This row customizes the star's taxonomy. Uncomment a Setup line to override the
default; a missing key leaves the qarf profile in force.

- base: how many recent tab/tag rows the star reads. Bigger sees more, slower.
- trace: how many tags the generated table lists. 0 writes no table rows.
- maxGraph: how many tags the graph may build before that table is cut.
- recent: how many of the newest rows make the trend pass's recent head.
- minRecent: recent rows a tag needs before the sea may draw it as emerging.
- minLift: how many times its older rate a tag's recent rate must reach.
- alias: another spelling of the same tag, e.g. js = javascript.
- noSyn/noTheme/noWeb: write yes to ignore that relation group.
- reset: write yes to rebuild the table and mapping once; it clears itself back to no.
- alpha/floor/ceil: optional qarf weighting overrides.

The generated table is cached in this browser's \`db.bins\`, not written here.
Edit Setup and Mapping. \`## Taxonomy\` is a section an older build wrote and is no
longer read while the cache exists.
`;

/** `## <name>` that opens a section. */
const HEADER_RX = /^##\s+(.+?)\s*$/;
/** `key: value` line of `## Setup`. */
const KEY_RX = /^\s*([A-Za-z][\w -]*):\s*(.*)$/;

/** One `##` section: its heading and the lines under it. */
interface Section {
  name: string;
  body: string[];
}

/**
 * Whether a ref names a star tagger document.
 *
 * @param ref a row ref
 * @returns true for any `*.tagger.md`
 */
export const isTaggerRef = (ref: string): boolean =>
  String(ref ?? '').toLowerCase().endsWith(TAGGER_REF_SUFFIX);

/** Split a document into its head and `##` sections. */
function splitSections(md: string): { head: string; sections: Section[] } {
  const lines = String(md ?? '').replace(/\s+$/, '').split('\n');
  const sections: Section[] = [];
  const head: string[] = [];
  let open: Section | undefined;
  for (const line of lines) {
    const match = line.match(HEADER_RX);
    if (!match) {
      (open ? open.body : head).push(line);
      continue;
    }
    open = { name: match[1], body: [] };
    sections.push(open);
  }
  return { head: head.join('\n').trim(), sections };
}

/** The body of the first section whose name matches, case-insensitively. */
const sectionBody = (sections: Section[], name: string): string[] =>
  sections.find((s) => s.name.toLowerCase() === name.toLowerCase())?.body ?? [];

/**
 * Parse one `alias:` value.
 *
 * @param text comma-separated `alias = tag` pairs
 * @returns the pairs as written, later entries winning
 */
export function parseAliases(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const piece of String(text ?? '').split(',')) {
    const at = piece.indexOf('=');
    if (at < 0) continue;
    const alias = piece.slice(0, at).trim();
    const tag = piece.slice(at + 1).trim();
    if (alias !== '' && tag !== '') out[alias] = tag;
  }
  return out;
}

/** A number from a Setup line, or undefined when the value is not usable. */
function readNumber(
  value: string, opts: { min: number; max: number; integer?: boolean },
): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n < opts.min || n > opts.max) return undefined;
  return opts.integer === true ? Math.round(n) : n;
}

/** One `## Setup` body, as the seed and the trace use it. */
function parseSetup(body: string[]): StarTaggerSetup {
  const setup: StarTaggerSetup = { ...DEFAULT_STAR_SETUP, alias: {}, notes: [] };
  for (const line of body) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = trimmed.match(KEY_RX);
    if (!match) {
      setup.notes.push(`ignored Setup line: ${trimmed}`);
      continue;
    }
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (key === 'alias') {
      Object.assign(setup.alias, parseAliases(value));
      continue;
    }
    if (key === 'reset' || key === 'nosyn' || key === 'notheme' || key === 'noweb') {
      const on = /^(yes|true|1|on)$/i.test(value);
      if (key === 'reset') setup.reset = on;
      else if (key === 'nosyn') setup.noSyn = on;
      else if (key === 'notheme') setup.noTheme = on;
      else setup.noWeb = on;
      continue;
    }
    const limits = key === 'alpha'
      ? { min: 0, max: 1_000 }
      : key === 'floor' || key === 'ceil' ? { min: 0, max: 1 }
        : key === 'minlift' ? { min: 0, max: STAR_MIN_LIFT_MAX }
          : key === 'trace' ? { min: 0, max: STAR_TRACE_MAX, integer: true }
            : key === 'maxgraph' ? { min: 1, max: STAR_GRAPH_MAX, integer: true }
              : key === 'recent' ? { min: 1, max: STAR_RECENT_MAX, integer: true }
                : key === 'minrecent' ? { min: 1, max: STAR_MIN_RECENT_MAX, integer: true }
                  : key === 'base' ? { min: 1, max: STAR_BASE_MAX, integer: true }
                    : undefined;
    if (limits === undefined) continue;
    const n = readNumber(value, limits);
    if (n === undefined) {
      setup.notes.push(`ignored ${key}: ${value}`);
      continue;
    }
    if (key === 'alpha') setup.alpha = n;
    else if (key === 'floor') setup.floor = n;
    else if (key === 'ceil') setup.ceil = n;
    else if (key === 'trace') setup.trace = n;
    else if (key === 'maxgraph') setup.maxGraph = n;
    else if (key === 'recent') setup.recent = n;
    else if (key === 'minrecent') setup.minRecent = n;
    else if (key === 'minlift') setup.minLift = n;
    else if (key === 'base') setup.base = n;
  }
  return setup;
}

/**
 * Read a `star.tagger.md`.
 *
 * @param md document text
 * @returns the head, the Setup overrides, the overridable mapping, and the legacy and
 *          user sections
 */
export function parseStarTaggerDoc(md: string): StarTaggerDoc {
  const { head, sections } = splitSections(md);
  return {
    head,
    setup: parseSetup(sectionBody(sections, 'Setup')),
    mapping: sectionBody(sections, 'Mapping').join('\n').trim(),
    taxonomy: sectionBody(sections, 'Taxonomy').join('\n').trim(),
    notes: sectionBody(sections, 'Notes').join('\n').trim(),
  };
}

/**
 * Replace one `##` section, keeping every other line as written.
 *
 * A missing section is inserted before `## Notes` when that exists, otherwise at
 * the end.
 *
 * @param md document text
 * @param name section heading
 * @param body section body
 * @returns the rewritten document, with one trailing newline
 */
export function setSection(md: string, name: string, body: string): string {
  const lines = String(md ?? '').replace(/\s+$/, '').split('\n');
  const start = lines.findIndex((line) => {
    const match = line.match(HEADER_RX);
    return match !== null && match[1].toLowerCase() === name.toLowerCase();
  });
  const fresh = [`## ${name}`, ...String(body ?? '').trim().split('\n').filter((l, i, all) =>
    !(l === '' && (i === 0 || i === all.length - 1)))];
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && lines[end].match(HEADER_RX) === null) end++;
    lines.splice(start, end - start, ...fresh, '');
  } else {
    const notes = lines.findIndex((line) => {
      const match = line.match(HEADER_RX);
      return match !== null && match[1].toLowerCase() === 'notes';
    });
    const at = notes >= 0 ? notes : lines.length;
    lines.splice(at, 0, ...fresh, '');
  }
  const out = lines.join('\n').trim();
  return out === '' ? '\n' : `${out}\n`;
}

/**
 * Set one `## Setup` key, preserving comments and every other section.
 *
 * @param md document text
 * @param key Setup key
 * @param value value to write
 * @returns the rewritten document
 */
export function setSetupValue(md: string, key: string, value: string): string {
  const { sections } = splitSections(md);
  const body = sectionBody(sections, 'Setup').slice();
  const rx = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'i');
  const at = body.findIndex((line) => rx.test(line));
  const line = `${key}: ${value}`;
  if (at >= 0) body[at] = line;
  else body.push(line);
  return setSection(md, 'Setup', body.join('\n'));
}

/** A normalized alias key: case and surrounding space folded. */
const aliasKey = (tag: string): string => String(tag ?? '').trim().toLowerCase();

/** Resolved aliases, and what could not be resolved. */
export interface ResolvedAliases {
  /** Normalized alias -> canonical display tag. */
  map: Map<string, string>;
  /** Cycles and self-aliases, for the trace header. */
  notes: string[];
}

/**
 * Resolve every alias to its final canonical tag, following chains.
 *
 * A cycle keeps the last tag before the repeat and records a note; a self-alias
 * is ignored.
 *
 * @param raw alias -> tag pairs, as written
 * @returns the resolver and its notes
 */
export function resolveAliases(raw: Record<string, string>): ResolvedAliases {
  const direct = new Map<string, string>();
  const display = new Map<string, string>();
  for (const [alias, tag] of Object.entries(raw)) {
    const key = aliasKey(alias);
    const target = tag.trim();
    if (key === '' || key === aliasKey(target)) continue;
    direct.set(key, target);
    display.set(key, alias.trim());
    display.set(aliasKey(target), target);
  }
  const map = new Map<string, string>();
  const notes: string[] = [];
  const visit = (key: string, seen: Set<string>): string | undefined => {
    const held = map.get(key);
    if (held !== undefined) return held;
    if (seen.has(key)) {
      notes.push(`alias cycle at ${display.get(key) ?? key}`);
      return undefined;
    }
    seen.add(key);
    const next = direct.get(key);
    if (next === undefined) return display.get(key) ?? key;
    const resolved = visit(aliasKey(next), seen);
    const value = resolved ?? next;
    map.set(key, value);
    return value;
  };
  for (const key of direct.keys()) visit(key, new Set());
  return { map, notes };
}

/**
 * Fold one tag through a resolved alias map.
 *
 * @param tag a tag as written
 * @param map resolver from {@link resolveAliases}
 * @returns the canonical tag, or the tag when it has no alias
 */
export const foldAlias = (tag: string, map: Map<string, string>): string =>
  map.get(aliasKey(tag)) ?? tag;

/** The limits the seed actually uses, after defaults and bounds. */
export interface StarLimits {
  base: number;
  trace: number;
  maxGraph: number;
  recent: number;
  minRecent: number;
  minLift: number;
}

/**
 * Effective seed limits: a missing key reads its default, a value outside its
 * bound is clamped, and `trace` never asks for more nodes than `maxGraph`.
 *
 * @param setup parsed Setup
 * @returns the counts the seed and trace use, plus the trend thresholds
 */
export function starLimits(setup: StarTaggerSetup): StarLimits {
  const base = Math.min(STAR_BASE_MAX, Math.max(1, Math.round(setup.base ?? STAR_BASE_DEFAULT)));
  const maxGraph = Math.min(STAR_GRAPH_MAX, Math.max(1,
    Math.round(setup.maxGraph ?? STAR_GRAPH_DEFAULT)));
  const trace = Math.min(maxGraph, Math.min(STAR_TRACE_MAX,
    Math.max(0, Math.round(setup.trace ?? STAR_TRACE_DEFAULT))));
  const recent = Math.min(base, Math.min(STAR_RECENT_MAX,
    Math.max(1, Math.round(setup.recent ?? STAR_RECENT_DEFAULT))));
  const minRecent = Math.min(STAR_MIN_RECENT_MAX,
    Math.max(1, Math.round(setup.minRecent ?? STAR_MIN_RECENT_DEFAULT)));
  const minLift = Math.min(STAR_MIN_LIFT_MAX,
    Math.max(0, setup.minLift ?? STAR_MIN_LIFT_DEFAULT));
  return { base, trace, maxGraph, recent, minRecent, minLift };
}

/**
 * A stable dependency key for the Setup block: `reset` is left out so clearing it does not
 * seed twice, and the `noSyn`/`noTheme`/`noWeb` filters are left out because they change how
 * the stored mapping is read rather than what the seed produces.
 *
 * @param setup parsed Setup
 * @returns the key the sea re-seeds on
 */
export function starSetupFingerprint(setup: StarTaggerSetup): string {
  const alias = Object.entries(setup.alias).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    base: setup.base, trace: setup.trace, maxGraph: setup.maxGraph,
    recent: setup.recent, minRecent: setup.minRecent, minLift: setup.minLift,
    alias, alpha: setup.alpha, floor: setup.floor, ceil: setup.ceil,
  });
}


