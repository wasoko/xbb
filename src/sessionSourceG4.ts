/**
 * sessionSourceG4.ts — the recr chat pinned to the `fb g4` provider and its `g4` model.
 *
 * The picker lists sessions from every registered source, and this is a second
 * reader over recr's own `sess/*` rows: it answers only for sessions whose meta
 * pins that pair, so the pinned chat gets its own label without a second row
 * format. `createBranchingSession(id, title, G4_PIN)` is what puts the pin on the
 * meta this filter reads, and `rcr` resolves the turn through it with
 * `parseSecrets(store, sessionModelOverride(session))`.
 *
 * The pin is what keeps this chat off `treeCacCurrent['provider-model']`, the
 * in-memory selection the provider picker writes and every unpinned chat shares.
 */

import type { IRecrStore } from './recr';
import { registerSessionSource, type SessionSourceAdapter } from './sessionSource';
import { listSessions, loadSessionTree, type SessionNode, type SessionSummary } from './sessionTree';

/** Source id of the pinned chat, and what its sessions' meta rows carry. */
export const G4_SOURCE_ID = 'recr-g4';
/** Provider heading the pinned chat resolves out of `secret.md`. */
export const G4_PROVIDER = 'fb g4';
/** `Models` alias the pinned chat resolves out of `secret.md`. */
export const G4_MODEL = 'g4';

/** The pin a chat of this source is created with. */
export const G4_PIN = { provider: G4_PROVIDER, model: G4_MODEL, source: G4_SOURCE_ID } as const;

/**
 * Whether a listed session belongs to this source.
 *
 * @param s session summary read from the store
 * @returns true when the meta pins this provider and model
 */
export function isG4Session(s: SessionSummary): boolean {
  return s.provider === G4_PROVIDER && s.model === G4_MODEL;
}

/** The pinned chat's reader: recr's own rows, narrowed to the sessions that pin the pair. */
export const g4Source: SessionSourceAdapter = {
  id: G4_SOURCE_ID,
  label: `recr · ${G4_PROVIDER}`,
  listSessions: async (store: IRecrStore): Promise<SessionSummary[]> =>
    (await listSessions(store)).filter(isG4Session),
  loadTree: (store: IRecrStore, sessionId: string): Promise<SessionNode[]> =>
    loadSessionTree(store, sessionId),
};

/**
 * Registers the pinned chat with the picker. Called at boot beside
 * `installSrctagGlobal`, because a source that is never registered is invisible.
 *
 * @returns the disposer that removes the adapter again
 */
export function registerG4Source(): () => void {
  return registerSessionSource(g4Source);
}
