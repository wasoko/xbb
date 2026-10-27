/**
 * srcfeedStore.ts — the page store behind `srcfeed`'s port.
 *
 * Kept apart from `srcfeed.ts` so the engine stays free of Dexie: the app passes
 * this port, a test passes its own. The one-time {@link ensureBbSrcFeedEntries}
 * append lives here because it reads and writes the same rows.
 */

import { greet } from './greet';
import { daEdit, daRead, daRows, db, type Da } from './sdb';
import { EXTSRC_REF, SRCFEED_REF, appendSourceEntries, type SrcFeedStore } from './srcfeed';
import { WEBFEED_REF } from './srcfeedWeb';
import {
  BB_LIST_LEGACY_BLOCK, BB_LIST_REF, BB_SOURCE_ENTRIES, EXTDOM_GR_REF,
  GR_SOURCE_ENTRIES, SRCFEED_ROW_SEEDS, seedBbRows, seedSrcFeedRows,
} from './srcfeedRows';

/**
 * The row a tab should show, seeding the registry when no feed document exists at all.
 *
 * A pin card's `{srcfeed.md}` is the one ref that can bootstrap a fresh installation:
 * the registry names the site and tab adapters, so the seed writes those with it. An
 * existing `webfeed.md` or `extsrc.md` is a registry too (read through the adapter),
 * so the example is not written over it; a tombstoned registry is a deletion, not a
 * missing document, and is left alone.
 *
 * @param ref - the tab's ref
 * @param type - row type to read; omitted searches the editor's `md`/`src` pair
 * @returns the winning live row, or undefined when absent, deleted, or unreadable
 */
export async function readOrSeedSrcFeed(ref: string, type?: string): Promise<Da | undefined> {
  if (ref !== SRCFEED_REF) return daRead(ref, type);
  /* Any row of any generation, tombstone included, means the user has (or had) a
     registry; only a truly missing one is seeded. */
  const held = await Promise.all([
    daRows(ref, ['md']),
    daRows(WEBFEED_REF, ['md']),
    daRows(EXTSRC_REF, ['md']),
  ]);
  if (held.every((rows) => rows.length === 0)) await seedSrcFeedRows(db.das);
  return daRead(ref, 'md');
}

/**
 * The open database as {@link SrcFeedStore}: reads resolve the winning live row, and
 * a write replaces a row's text or creates the document on its first read.
 *
 * @returns the port a `runSrcFeed` call takes
 */
export function sdbSrcFeedStore(): SrcFeedStore {
  return {
    db,
    read: (ref, type) => daRead(ref, type),
    ensure: async (ref) => {
      const seed = SRCFEED_ROW_SEEDS.find((row) => row.ref === ref);
      if (seed === undefined) return undefined;
      /* A row of that ref, tombstone included, means the user has it or deleted it;
         only a truly missing seed is created. */
      if ((await daRows(ref, [seed.type])).length > 0) return daRead(ref, seed.type);
      await db.das.add({ ...seed, tags: [...seed.tags], rec: {}, modAt: new Date() });
      return daRead(ref, seed.type);
    },
    save: async (row, ref, txt) => {
      if (row?.tid !== undefined) await db.das.update(row.tid, daEdit(row, txt));
      else await db.das.add({ ref, type: 'md', txt, tags: ['srcfeed'], rec: {}, modAt: new Date() });
    },
    push: async () => greet(db.das),
  };
}

/** Marker key: the one-time Bilibili entry append has run for this store. */
const BB_APPEND_KEY = 'srcfeed.bb-appended.v3';

/**
 * Append the seeded Bilibili entries to an existing registry, once.
 *
 * `seedSrcFeedRows` only runs for a fresh installation, so an existing `srcfeed.md`
 * would never learn about a later seed. This migration adds the missing `### bb-*`
 * blocks under `## Sources` and writes the five script rows, leaving every existing
 * block alone. A tombstoned script row is treated as a deletion: its entry is not
 * added back. A registry that is absent or tombstoned is left for the normal seed.
 *
 * The `db.tree` marker makes the pass one-shot, so a user who removes an entry later
 * is not overruled on every boot.
 *
 * @returns the entry names added and the script rows written
 */
export async function ensureBbSrcFeedEntries(): Promise<string[]> {
  const marker = await db.tree.get(BB_APPEND_KEY);
  if (marker?.value === true) return [];
  const row = await daRead(SRCFEED_REF, 'md');
  if (row === undefined) {
    await db.tree.put({ key: BB_APPEND_KEY, value: true });
    return [];
  }
  const held: Da[] = await db.das.filter((candidate) =>
    BB_SOURCE_ENTRIES.some((entry) => entry.name === candidate.ref)).toArray();
  const dead = new Set(held.filter((candidate) => (candidate.tags ?? []).includes('[del]'))
    .map((candidate) => candidate.ref));
  const entries = BB_SOURCE_ENTRIES.filter((entry) => !dead.has(entry.name));
  const { text, added } = appendSourceEntries(row.txt, entries);
  if (added.length > 0 && row.tid !== undefined) await db.das.update(row.tid, daEdit(row, text));
  const seeded = await seedBbRows(db.das);
  await db.tree.put({ key: BB_APPEND_KEY, value: true });
  return [...added, ...seeded];
}

/** Marker key: the first seeded `bb-list` cap has been moved from 111 to 5555. */
const BB_LIST_MAX_KEY = 'srcfeed.bb-list-max-5555.v1';

/**
 * Move the exact first seeded `bb-list` block from `Max: 111` to `Max: 5555`.
 *
 * A registry seeded by the first Bilibili release holds that block; the reader now
 * defaults to 5555 and a `Max: 111` line would override it. Only the exact block is
 * replaced, so a user-edited URL, tag or cap stays as written. The pass is one-shot.
 *
 * @returns true when the block was rewritten
 */
export async function ensureBbListMax(): Promise<boolean> {
  const marker = await db.tree.get(BB_LIST_MAX_KEY);
  if (marker?.value === true) return false;
  const row = await daRead(SRCFEED_REF, 'md');
  if (row === undefined) {
    await db.tree.put({ key: BB_LIST_MAX_KEY, value: true });
    return false;
  }
  const entry = BB_SOURCE_ENTRIES.find((candidate) => candidate.name === BB_LIST_REF);
  const next = entry !== undefined && row.txt.includes(BB_LIST_LEGACY_BLOCK)
    ? row.txt.replace(BB_LIST_LEGACY_BLOCK, entry.block)
    : row.txt;
  const changed = next !== row.txt;
  if (changed && row.tid !== undefined) await db.das.update(row.tid, daEdit(row, next));
  await db.tree.put({ key: BB_LIST_MAX_KEY, value: true });
  return changed;
}

/** Marker key: the one-time Grok entry append has run for this store. */
const GR_APPEND_KEY = 'srcfeed.gr-appended.v1';

/**
 * Append the seeded Grok entry to an existing registry, once.
 *
 * `seedSrcFeedRows` only runs for a fresh installation, so a registry seeded before
 * `gr` existed would never learn it. Only the missing block is added, and a
 * tombstoned `extdom/gr` row is a deletion: neither its entry nor its body is added
 * back. A registry that is absent or tombstoned is left for the normal seed.
 *
 * @returns the entry names added
 */
export async function ensureGrSrcFeedEntry(): Promise<string[]> {
  const marker = await db.tree.get(GR_APPEND_KEY);
  if (marker?.value === true) return [];
  const row = await daRead(SRCFEED_REF, 'md');
  if (row === undefined) {
    await db.tree.put({ key: GR_APPEND_KEY, value: true });
    return [];
  }
  const held: Da[] = await db.das.filter((candidate) => candidate.ref === EXTDOM_GR_REF).toArray();
  const dead = held.some((candidate) => (candidate.tags ?? []).includes('[del]'));
  const { text, added } = appendSourceEntries(row.txt, dead ? [] : GR_SOURCE_ENTRIES);
  if (added.length > 0 && row.tid !== undefined) await db.das.update(row.tid, daEdit(row, text));
  await sdbSrcFeedStore().ensure(EXTDOM_GR_REF);
  await db.tree.put({ key: GR_APPEND_KEY, value: true });
  return added;
}
