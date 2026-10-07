/**
 * sessionSource.ts — the seam that lets the chat browser read session trees that
 * a writer other than recr produced.
 *
 * The recr adapter ships today and reads `db.das` directly. A deepseek-harness or
 * VS Code chat adapter registers the same interface and becomes indistinguishable
 * to the picker, which asks every registered source and merges the answers.
 */

import type { IRecrStore } from './recr';
import { RECR_SOURCE_ID } from './recrConst';
import {
  listSessions, loadSessionTree, type SessionNode, type SessionSummary,
} from './sessionTree';

/** One writer of sessions the browser can list and open. */
export interface SessionSourceAdapter {
  id: string;
  /** Name the picker shows beside a session from this source. */
  label: string;
  /** Sessions of this source, any order; the caller sorts the merged list. */
  listSessions(store: IRecrStore): Promise<SessionSummary[]>;
  /** Tree of one session of this source, empty when it holds no readable node. */
  loadTree(store: IRecrStore, sessionId: string): Promise<SessionNode[]>;
}

/** The only source that ships: recr's own `sess/*` rows. */
export const recrSource: SessionSourceAdapter = {
  id: RECR_SOURCE_ID,
  label: 'recr',
  // A session whose meta names another source is that source's to list, so a pinned
  // chat appears once in the merged picker instead of under both readers.
  listSessions: async (store: IRecrStore): Promise<SessionSummary[]> =>
    (await listSessions(store)).filter((s) => s.source === RECR_SOURCE_ID),
  loadTree: loadSessionTree,
};

const sources = new Map<string, SessionSourceAdapter>([[recrSource.id, recrSource]]);

/**
 * Add a source to the picker.
 *
 * @param adapter - Source to add; an id already registered is replaced.
 * @returns A disposer that removes the adapter when it is still the registered one.
 */
export function registerSessionSource(adapter: SessionSourceAdapter): () => void {
  sources.set(adapter.id, adapter);
  return () => {
    if (sources.get(adapter.id) === adapter) sources.delete(adapter.id);
  };
}

/** Every registered source, in registration order. */
export function listSessionSources(): SessionSourceAdapter[] {
  return [...sources.values()];
}

/** One registered source by id. */
export function getSessionSource(id: string): SessionSourceAdapter | undefined {
  return sources.get(id);
}

/** A source that throws must not hide the sessions of the others. */
async function tryList(adapter: SessionSourceAdapter, store: IRecrStore): Promise<SessionSummary[]> {
  try {
    return await adapter.listSessions(store);
  } catch (e) {
    console.error(`session source ${adapter.id} failed to list: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Sessions of every registered source, newest first.
 *
 * @param store - Store the adapters read.
 * @returns The merged list.
 */
export async function listAllSessions(store: IRecrStore): Promise<SessionSummary[]> {
  const perSource = await Promise.all(listSessionSources().map((s) => tryList(s, store)));
  return perSource.flat().sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/**
 * The tree of one session, read by the source that owns it.
 *
 * @param store - Store the adapter reads.
 * @param sessionId - Session to read.
 * @param source - Owning source id; the recr adapter answers for an unknown id.
 * @returns The tree, or an empty array.
 */
export async function loadTreeFor(
  store: IRecrStore,
  sessionId: string,
  source?: string,
): Promise<SessionNode[]> {
  const adapter = (source && getSessionSource(source)) || recrSource;
  try {
    return await adapter.loadTree(store, sessionId);
  } catch (e) {
    console.error(`session source ${adapter.id} failed to read ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
