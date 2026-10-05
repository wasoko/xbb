// src/ui/tabSync.ts
/** Live React binding for `./tabState`: Dexie rows of one tab plus the last `greet()` outcome. */
import { useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { daRows } from '../sdb';
import { getGreetStat, subscribeGreetStat } from '../greet';
import { tabSyncState, type TabSyncState } from './tabState';

/** State of one tab; `undefined` until the first live-query result arrives. */
export function useTabSyncState(ref: string, buffer: string | undefined): TabSyncState | undefined {
  const rows = useLiveQuery(() => (ref ? daRows(ref) : Promise.resolve([])), [ref]);
  const greet = useSyncExternalStore(subscribeGreetStat, getGreetStat);
  return tabSyncState({ rows, buffer, greet });
}
