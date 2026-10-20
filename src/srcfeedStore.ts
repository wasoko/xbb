/**
 * srcfeedStore.ts — the page store behind `srcfeed`'s port.
 *
 * Kept apart from `srcfeed.ts` so the engine stays free of Dexie: the app passes
 * this port, a test passes its own.
 */

import { greet } from './greet';
import { daEdit, daRead, daRows, db, type Da } from './sdb';
import { EXTSRC_REF, SRCFEED_REF, type SrcFeedStore } from './srcfeed';
import { WEBFEED_REF } from './srcfeedWeb';
import { SRCFEED_ROW_SEEDS, seedSrcFeedRows } from './srcfeedRows';

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
