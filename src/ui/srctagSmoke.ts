/**
 * srctagSmoke.ts — the app-side half of the `srctag/*` adapter rows.
 *
 * `src/srctagRows.ts` holds the bodies as text; this module writes them into
 * `db.das`, loads them through `srctag`'s own `loadAdaptersFromStore`, and runs
 * one live call per adapter. That is what a provider name, a model alias, or a
 * key in `secret.md` can be checked against without running a sweep over rows.
 *
 * Nothing here is wired into a sweep: seeding is an explicit step, and
 * {@link removeAdapterRows} tombstones what was written.
 */

import { daRead, db } from '../sdb';
import { SRCTAG_ROW_REFS, clearTagRows, seedTagRows } from '../srctagRows';
import {
  SRCTAG_EMBED_REF, SRCTAG_KEYWORDS_REF,
  loadAdaptersFromStore, parseKeywordDoc,
  type ClassifyFn, type EmbedFn,
} from '../srctag';
import type { RecrScriptContext } from '../runsrc';

/** Dev-name of the tag the seeded rows carry, so the list can tell them apart. */
export const SEED_TAG = 'srctag';

/** What `loadAdapterSet` resolved. */
export interface AdapterSet {
  embed?: EmbedFn;
  classify?: ClassifyFn;
  /** Surface forms per tag from `srctag/keywords.md`, the `synonyms` shape `tagRows` takes. */
  synonyms: Record<string, string[]>;
  /** Rows that were missing or threw, one line each. */
  errors: string[];
}

/** One smoke run's report, already formatted for a toast. */
export interface AdapterSmoke {
  title: string;
  lines: string[];
  /** Adapters that answered. */
  ok: number;
  seeded: string[];
  skipped: string[];
}

/** Texts one smoke call sends; one CJK and one Latin, the two tokenizer paths. */
export const SMOKE_TEXTS = ['中文标题示例', 'English title example'];

/** Labels handed to the classifier when the keywords doc names none. */
export const SMOKE_LABELS = ['react', 'vue', 'shopping', 'news', 'research'];

/**
 * Write the `srctag/*` rows, keeping any live row the user already has.
 *
 * @returns the refs written and the refs skipped
 */
export function seedAdapterRows(): Promise<{ written: string[]; skipped: string[] }> {
  return seedTagRows(db.das);
}

/**
 * Tombstone the seeded rows, so the removal syncs rather than being resurrected.
 *
 * @returns how many rows were tombstoned
 */
export function removeAdapterRows(): Promise<number> {
  return clearTagRows(db.das);
}

/** Whether a live row exists for `ref`. */
async function hasRow(ref: string, type: string): Promise<boolean> {
  return (await daRead(ref, type)) !== undefined;
}

/**
 * Load both adapters and the keywords doc out of the store.
 *
 * A missing row is reported in `errors` rather than thrown, because the lexical
 * channels are the default and an absent adapter is a normal state.
 *
 * @returns the adapters found, the synonyms, and one line per problem
 */
export async function loadAdapterSet(): Promise<AdapterSet> {
  const ctx: RecrScriptContext = { db, ref: 'srctag', args: {}, console };
  const store = { readScript: async (ref: string) => (await daRead(ref, 'src'))?.txt };
  const loaded = await loadAdaptersFromStore(store, ctx);
  const errors: string[] = [];
  for (const [ref, type] of [[SRCTAG_EMBED_REF, 'src'], [SRCTAG_KEYWORDS_REF, 'md']] as const) {
    if (!(await hasRow(ref, type))) errors.push(`${ref} not seeded`);
  }

  const keywords = await daRead(SRCTAG_KEYWORDS_REF, 'md');
  const synonyms: Record<string, string[]> = {};
  if (keywords?.txt) {
    for (const entry of parseKeywordDoc(keywords.txt)) {
      if (entry.keywords.length > 0) synonyms[entry.tag] = entry.keywords;
    }
  }
  return { ...loaded, synonyms, errors };
}

/**
 * Seed, load, and run one live call per adapter.
 *
 * Every failure is captured into the report: a missing `secret.md`, an unknown
 * provider, a refused origin, and a bad key all land as one line, so the menu
 * item can show what happened instead of throwing.
 *
 * @param opts labels for the classifier call
 * @returns the formatted report
 */
export async function smokeAdapters(opts: { labels?: string[] } = {}): Promise<AdapterSmoke> {
  const lines: string[] = [];
  const seeded = await seedAdapterRows();
  const set = await loadAdapterSet();
  let ok = 0;

  if (seeded.written.length > 0) lines.push(`seeded ${seeded.written.join(', ')}`);
  if (seeded.skipped.length > 0) lines.push(`kept existing ${seeded.skipped.join(', ')}`);
  lines.push(...set.errors);

  const labels = opts.labels ?? (Object.keys(set.synonyms).length > 0
    ? [...new Set([...Object.keys(set.synonyms), ...SMOKE_LABELS])].slice(0, 8)
    : SMOKE_LABELS);

  if (!set.embed) lines.push('embed: no adapter row');
  else {
    try {
      const [first] = await set.embed(SMOKE_TEXTS);
      lines.push(`embed: ${SMOKE_TEXTS.length} texts → ${first?.length ?? 0}-dim`);
      ok++;
    } catch (e) {
      lines.push(`embed failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!set.classify) lines.push('classify: no adapter row');
  else {
    try {
      const hits = await set.classify(SMOKE_TEXTS[1], labels);
      const top = hits[0];
      lines.push(top
        ? `classify: #${top.tag} ${top.score.toFixed(2)} of ${labels.length} labels`
        : `classify: no label returned (${labels.length} sent)`);
      ok++;
    } catch (e) {
      lines.push(`classify failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const forms = Object.values(set.synonyms).reduce((n, k) => n + k.length, 0);
  if (forms > 0) lines.push(`keywords: ${forms} surface form(s)`);

  return {
    title: `tag adapters: ${ok}/2 answered`,
    lines,
    ok,
    seeded: seeded.written,
    skipped: seeded.skipped,
  };
}

/** Refs the smoke item owns, for a caller that wants to list them. */
export { SRCTAG_ROW_REFS };
