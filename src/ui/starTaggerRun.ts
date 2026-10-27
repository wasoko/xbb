/**
 * starTaggerRun.ts — the sea's cached seed: `star.tagger.md`'s Setup, its overridable
 * `## Mapping`, and the `db.bins` record the wall opens on.
 *
 * The seed itself is `seaPinGraph.loadPinGraph`; this module owns the row that is seeded
 * when missing, the mapping section written once (and on `reset`), and the one bin record
 * holding the generated table plus the seed it was read from.
 *
 * The cache is what makes a sea mount cheap: `greet` no longer runs for a seed, and a mount
 * whose table and Setup are unchanged reads the cached seed instead of scanning `db.das`
 * and running qarf again. The text builders stay pure in `starTaggerTrace.ts`.
 */

import { greet } from '../greet';
import { binGet, binPut, daEdit, daRead, db, treeCac, treeCacReady } from '../sdb';
import {
  STAR_TAGGER_DOC, STAR_TAGGER_REF, parseStarTaggerDoc, setSection, setSetupValue,
  starSetupFingerprint, type StarTaggerSetup,
} from '../starTagger';
import { buildStarTaxonomy } from '../starTaggerTrace';
import type { TagGraph } from './restGraph';
import type { PinGraphSeed, StarTiming } from './seaPinGraph';

export { buildStarTaxonomy } from '../starTaggerTrace';
export type { StarTaxonomy, StarTaxonomyRow } from '../starTaggerTrace';

/** Bin key of the sea's one cache record: the generated table and the seed it came from. */
export const STAR_CACHE_BIN = 'star-cache';

/** Shape version of {@link StarCache}; bump it whenever what a seed produces changes. */
export const STAR_CACHE_VERSION = 1;

/** What the table looked like when the cached seed was read. */
export interface StarCacheStamp {
  /** Highest `tid` in `db.das`. */
  tid: number;
  /** Rows in `db.das`; a deletion moves it. */
  count: number;
  /** Newest `modAt`, in epoch ms; an edit moves it. */
  modAt: number;
  /** Server and working snapshot, so switching either cannot reuse another's seed. */
  snap: string;
}

/** One cached sea reading: the table the wall draws and the seed the rest of the sea reads. */
export interface StarCache {
  /** {@link STAR_CACHE_VERSION} of the build that wrote it. */
  v: number;
  /** Table state the seed was read at. */
  stamp: StarCacheStamp;
  /** Setup fingerprint the seed ran with; see `starTagger.starSetupFingerprint`. */
  fingerprint: string;
  /** Generated body: header, timing, the table and `### Bursts`. */
  taxonomy: string;
  /** The seed the wall, the row lists and the omnibox hints read. */
  seed: PinGraphSeed;
}

/** A graph as `binPut` can carry it: every field but the namer, which is a function. */
type StoredGraph = Omit<TagGraph, 'name'>;

/** A seed as `binPut` can carry it. */
type StoredSeed = Omit<PinGraphSeed, 'graph'> & { graph: StoredGraph };

/** The record actually stored; `readStarCache` restores the namer. */
interface StoredCache extends Omit<StarCache, 'seed'> { seed: StoredSeed }

/**
 * The namer a stored graph is reopened with.
 *
 * `buildTagGraph`'s closure also merges a spelling it has never seen; a cached seed only
 * asks about tags the build already named, and each of those is recorded in `folded` (an
 * explicit alias) or `merged` (a similarity merge), so the two maps reproduce it.
 *
 * @param graph the stored graph
 * @returns the graph with its `name`
 */
function restoreName(graph: StoredGraph): TagGraph {
  return {
    ...graph,
    name: (tag: string): string => {
      const folded = graph.folded?.get(tag) ?? tag;
      return graph.merged?.get(folded) ?? folded;
    },
  };
}

/** A seed stripped of everything `binPut` cannot encode. */
function storedSeed(seed: PinGraphSeed): StoredSeed {
  const { name: _name, ...graph } = seed.graph;
  return { ...seed, graph };
}

/** A seed in flight, so StrictMode and two mounts cannot add two rows. */
let ensuring: Promise<void> | undefined;

/**
 * Seed `star.tagger.md` when it is missing.
 *
 * An existing row is never overwritten, including one the user left empty, so
 * the call is safe on every mount.
 *
 * @returns the in-flight seed, so a caller can await it
 */
export function ensureStarTaggerRow(): Promise<void> {
  ensuring ??= (async () => {
    const row = await daRead(STAR_TAGGER_REF, 'md');
    if (row !== undefined) return;
    await db.das.add({
      ref: STAR_TAGGER_REF, type: 'md', txt: STAR_TAGGER_DOC,
      tags: ['tagger'], rec: {}, modAt: new Date(),
    });
  })().finally(() => { ensuring = undefined; });
  return ensuring;
}

/**
 * The stamp a seed is read at: the newest row, the row count, the newest edit and the
 * working snapshot. A cached seed is reusable while all four still stand.
 *
 * @returns the current stamp
 */
export async function dasStamp(): Promise<StarCacheStamp> {
  await treeCacReady;
  const [newest, count, edited] = await Promise.all([
    db.das.orderBy(':id').last(),
    db.das.count(),
    db.das.orderBy('modAt').last(),
  ]);
  return {
    tid: newest?.tid ?? 0,
    count,
    modAt: edited?.modAt?.getTime() ?? 0,
    snap: `${String(treeCac['server'])}|${String(treeCac['snap_name'])}`,
  };
}

/**
 * Whether a seed read at `held` still describes the table at `now`.
 *
 * @param held stamp stored with the cache
 * @param now stamp read from the table
 * @returns true when nothing the seed reads has changed
 */
export const sameStamp = (held: StarCacheStamp, now: StarCacheStamp): boolean =>
  held.tid === now.tid && held.count === now.count
  && held.modAt === now.modAt && held.snap === now.snap;

/**
 * The cached sea reading, or `undefined` when nothing is stored or an older build wrote it.
 *
 * @returns the cache the wall can open on
 */
export async function readStarCache(): Promise<StarCache | undefined> {
  const held = await binGet<StoredCache>(STAR_CACHE_BIN);
  if (held?.v !== STAR_CACHE_VERSION) return undefined;
  return { ...held, seed: { ...held.seed, graph: restoreName(held.seed.graph) } };
}

/** The table and burst body with the lines that change on every seed removed. */
const tableOnly = (text: string): string => text.split('\n')
  .filter((line) => !line.startsWith('seeded ') && !line.startsWith('time: '))
  .join('\n');

/**
 * Write the `## Mapping` section into `star.tagger.md`, unless the row already has one.
 *
 * The mapping is the stale-but-overridable half: it is written once so a reader can edit
 * it, and rebuilt only by `reset: yes`. The generated table is never written to the row.
 *
 * @param mapping the generated section body
 * @param force rewrite an existing section and clear the one-shot `reset`
 * @returns whether the row changed
 */
async function writeMapping(mapping: string, force: boolean): Promise<boolean> {
  const row = await daRead(STAR_TAGGER_REF, 'md');
  const held = row?.txt ?? STAR_TAGGER_DOC;
  if (!force && parseStarTaggerDoc(held).mapping !== '') return false;
  let next = setSection(held, 'Mapping', mapping);
  if (force) next = setSetupValue(next, 'reset', 'no');
  if (row?.tid !== undefined) {
    await db.das.update(row.tid, daEdit(row, next));
  } else {
    await db.das.add({
      ref: STAR_TAGGER_REF, type: 'md', txt: next,
      tags: ['tagger'], rec: {}, modAt: new Date(),
    });
  }
  await greet(db.das);
  return true;
}

/**
 * Cache one seed and write the overridable mapping into its row.
 *
 * The table is kept as stored while its lines are unchanged, so the seed stamp and timing
 * line cannot churn the cache. The row is only written when it has no `## Mapping` or the
 * Setup asked for one rebuild, which is the only time a sea mount still pushes.
 *
 * The stamp is measured after those writes, because the mapping row is itself a `das` write
 * and a stamp taken before it would invalidate this cache on the next mount.
 *
 * @param seed the sea's seed
 * @param setup the Setup it ran with
 * @param timings stage timings
 * @param now seed stamp, injectable for a deterministic test
 * @returns the cache that was written
 */
export async function saveStarSeed(
  seed: PinGraphSeed, setup: StarTaggerSetup, timings: StarTiming, now: Date = new Date(),
): Promise<StarCache> {
  const built = buildStarTaxonomy(seed, setup, timings, now);
  const held = await readStarCache();
  const taxonomy = held !== undefined && tableOnly(held.taxonomy) === tableOnly(built.text)
    ? held.taxonomy : built.text;
  await writeMapping(built.mapping, setup.reset === true);
  const cache: StarCache = {
    v: STAR_CACHE_VERSION, stamp: await dasStamp(),
    fingerprint: starSetupFingerprint(setup), taxonomy, seed,
  };
  await binPut(STAR_CACHE_BIN, { ...cache, seed: storedSeed(seed) });
  return cache;
}

