// src/ui/tabState.ts
/** Observable sync state of one editor tab, derived from `db.das` rows plus the last
 *  `greet()` outcome. Two independent facts are kept apart:
 *  the persisted row's obligation (nothing / a local edit awaiting push / a local edit
 *  shadowed by a newer server row / a discarded local edit awaiting the diff tab / a failed
 *  sync round) and the in-memory buffer
 *  (typed text the editor has not written to Dexie yet, since `saveToDb` runs on blur).
 *
 *  Pure: the live React binding is `useTabSyncState` in `./tabSync`.
 */
import type { CSSProperties } from 'react';
import * as fc from '../fc';
import { daLive, daNewest, daWin, type Da } from '../sdb';
import type { GreetStat } from '../greet';

export type TabRowState = 'draft' | 'clean' | 'pending' | 'diverged' | 'stale' | 'failed';

export interface TabSyncState {
  row: TabRowState;
  /** The buffer differs from the row the editor displays, i.e. keystrokes not yet in Dexie. */
  bufferUnsaved: boolean;
  /** Detail line for the tab tooltip and the dropdown meta row. */
  detail: string;
  /** Non-fatal alarm raised by the row itself, e.g. hunks a patch could not place. */
  warn?: string;
  /** Local edits a server-wins merge discarded, still held in `rec.cr` for a diff/apply. */
  conflicts: number;
  /** The row the editor shows for the buffer comparison, when one exists. */
  shown?: Da;
}

const ago = (d?: Date | string | null) => fc.fmtAgo(d ? new Date(d).getTime() : 0);

/** Derive the state of one tab. Every live row for the ref is grouped by `type`, because
 *  `ref`+`type` is the unit the store and the server resolve.
 *
 * @param rows live rows for the ref, or `undefined` while the live query is unresolved.
 * @param buffer the editor's in-memory text for the tab.
 * @param greet the last `greet()` outcome; a failed round is reported against this row only
 *  while the row itself is dirty, so an unrelated failure cannot blame a clean tab.
 * @returns the state, or `undefined` when `rows` is not resolved yet.
 */
export function tabSyncState({ rows, buffer, greet }: {
  rows: Da[] | undefined;
  buffer: string | undefined;
  greet: GreetStat;
}): TabSyncState | undefined {
  if (!rows) return undefined;
  const live = daLive(rows);
  if (live.length === 0) return { row: 'draft', bufferUnsaved: false, conflicts: 0, detail: 'untitled — no saved row' };

  const byType = new Map<string, Da[]>();
  for (const r of live) byType.set(r.type, [...(byType.get(r.type) ?? []), r]);

  let dirty: Da | undefined;
  let shadow: { local: Da; srv: Da } | undefined;
  for (const group of byType.values()) {
    const winner = daWin(group);
    const newest = daNewest(group);
    if (winner?.modAt != null && !dirty) dirty = winner;
    // The two resolution rules disagree: a local edit is not the newest server row.
    if (winner && newest && winner.tid !== newest.tid) shadow = { local: winner, srv: newest };
  }

  const shown = daWin(live);
  const bufferUnsaved = shown !== undefined && buffer !== undefined && buffer !== shown.txt;
  /** Discarded local edits the row still carries, offered by the diff tab. */
  const conflicts = Object.keys((shown?.rec?.cr ?? {}) as Record<string, unknown>).length;
  const tail = [bufferUnsaved ? 'unsaved buffer — saves when the editor loses focus' : ''
    , conflicts > 0 ? `${conflicts} discarded local edit(s) — diff from the tab menu` : ''
  ].filter(Boolean).join(' · ');
  const detail = (rowDetail: string) => [rowDetail, tail].filter(Boolean).join(' · ');
  const patchFail = shown?.rec?.patchFail as { at: string; hunks: number } | undefined;

  if (shadow)
    return { row: 'diverged', bufferUnsaved, conflicts, shown,
      warn: patchFail ? `${patchFail.hunks} hunk(s) not reapplied within this row` : undefined,
      detail: detail(`server has a newer version (${ago(shadow.srv.dt)})`
        + `; your edit is kept in row #${shadow.local.tid}`
        + (patchFail ? ` · ${patchFail.hunks} hunk(s) not reapplied` : '')
        + (greet.lastError ? ` · last sync failed: ${greet.lastError}` : '')) };
  if (conflicts > 0)
    return { row: 'stale', bufferUnsaved, conflicts, shown,
      warn: patchFail ? `${patchFail.hunks} hunk(s) not reapplied` : undefined,
      detail: detail('a discarded local edit was not reapplied'
        + ' — the version it was based on is not held') };
  if (greet.lastError && dirty)
    return { row: 'failed', bufferUnsaved, conflicts, shown,
      detail: detail(`last sync failed: ${greet.lastError} · local edit pending`) };
  if (dirty)
    return { row: 'pending', bufferUnsaved, conflicts, shown,
      warn: patchFail ? `${patchFail.hunks} hunk(s) not reapplied` : undefined,
      detail: detail(`local edit pending push · ${ago(dirty.modAt)}`
        + (patchFail ? ` · ${patchFail.hunks} hunk(s) not reapplied` : '')) };
  return { row: 'clean', bufferUnsaved, conflicts, shown, detail: detail(`synced ${ago(shown?.dt)}`) };
}

/** Attention states tint the whole tab; the rest stays on the label so the active tab
 *  keeps its accent. Emoji is reserved for the states that need a look. */
export function tabVisual(state: TabSyncState | undefined): {
  tabStyle?: CSSProperties;
  labelStyle?: CSSProperties;
  glyph: string;
  /** Count rendered next to the label, e.g. the discarded local edits held on the row. */
  badge?: string;
  title?: string;
} {
  if (!state) return { glyph: '' };
  const attention = state.row === 'diverged' || state.row === 'failed' || state.row === 'stale';
  const amber = Boolean(state.warn) || state.conflicts > 0;
  const labelStyle: CSSProperties = {};
  if (state.row === 'pending') labelStyle.background = 'rgba(245, 158, 11, 0.22)';
  if (state.bufferUnsaved) {
    labelStyle.fontStyle = 'italic';
    labelStyle.borderBottom = '1px dashed rgba(255, 255, 255, 0.45)';
  }
  return {
    tabStyle: attention
      ? { background: state.row === 'failed' ? 'rgba(239, 68, 68, 0.42)' : 'rgba(239, 68, 68, 0.26)',
          boxShadow: 'inset 0 0 0 1px rgba(248, 113, 113, 0.55)' }
      : amber
        ? { background: 'rgba(245, 158, 11, 0.26)' }
        : undefined,
    labelStyle,
    glyph: attention || amber ? '⚠' : '',
    badge: state.conflicts > 0 ? String(state.conflicts) : undefined,
    title: state.warn ? `${state.detail} · ${state.warn}` : state.detail,
  };
}
