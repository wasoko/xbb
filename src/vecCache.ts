/**
 * vecCache.ts — `db.embs` as the `TagVectorCache` the embedding channel reads.
 *
 * A vector is a pure function of its text, so the store keys one by that text's
 * hash (`srctag.textHash`) rather than by the row that happens to hold it: the
 * same title in two rows is one vector, and an edited title is a different key
 * instead of a stale hit. `mdl` namespaces the whole thing, because two models
 * produce incomparable vectors from the same text.
 *
 * The table is `embs`, not the row-keyed `vecs` it replaces: Dexie aborts an
 * upgrade that changes a table's primary key, and nothing ever wrote that one.
 *
 * `modelVecCache` primes one model's namespace into a `Map` before returning, so
 * the cache satisfies the synchronous `get` a scoring pass needs; misses are
 * written back through Dexie as they arrive.
 */

import { db } from './sdb';
import { textHash, type TagVectorCache } from './srctag';

/**
 * A {@link modelVecCache} result: the cache interface plus what this session did
 * with it, for a status line.
 */
export interface VecCache extends TagVectorCache {
  /** Model namespace this cache owns; a lookup under another one is a miss. */
  model: string;
  /** Vectors the store already held when this cache primed. */
  primed: number;
  /** Texts this session missed and wrote back. */
  written(): number;
}

/**
 * Prime one model's vectors out of `db.embs` and return the cache over them.
 *
 * @param model the model id the vectors belong to
 * @returns the primed cache, which writes its misses back to the same table
 */
export async function modelVecCache(model: string): Promise<VecCache> {
  const held = new Map<string, ArrayLike<number>>();
  for (const row of await db.embs.where('mdl').equals(model).toArray()) {
    held.set(row.hash, row.vec);
  }
  let writes = 0;
  return {
    model,
    primed: held.size,
    written: () => writes,
    get: (mdl, text) => (mdl === model ? held.get(textHash(text)) : undefined),
    set: (mdl, text, vec) => {
      if (mdl !== model) return undefined;
      const hash = textHash(text);
      held.set(hash, vec);
      writes += 1;
      return db.embs.put({ hash, mdl: model, vec: Float32Array.from(vec) });
    },
  };
}
