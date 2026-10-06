// src/ui/useTreeCac.ts
import { useLiveQuery } from 'dexie-react-hooks';
import { db, treeCac } from '../sdb';

/**
 * Reads one `treeCac` setting reactively. `treeCac` is a plain mutable object
 * that the settings menu edits in place, so a component that reads it directly
 * never repaints on a change; this subscribes to the `tree` row instead and
 * falls back to the in-memory default until the row resolves.
 *
 * @param key - `treeCac` key, e.g. `cardSeer`.
 * @returns The current value of the setting.
 */
export function useTreeCac<T = string>(key: string): T {
  return useLiveQuery(
    async () => {
      const row = await db.tree.get(key);
      return (row?.value ?? treeCac[key]) as T;
    },
    [key],
    treeCac[key] as T,
  );
}
