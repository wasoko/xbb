// src/ui/reapply.ts
/** Re-apply the keystrokes typed while a sync round ran.
 *
 *  The editor keeps its own in-memory text, and a greet round can replace the row underneath it.
 *  `sdb.patchMod` does the same job for two stored rows: diff the version the local edit was
 *  authored against, then apply that diff onto the fetched text. This is that recipe for the
 *  live buffer, so typing never has to stop while a round is in flight.
 *
 *  Pure; the caller owns the buffer and the baseline.
 */
import * as diffmp from 'diff-match-patch';

export interface ReapplyResult {
  /** Text the editor should show. */
  txt: string;
  /** Hunks the patch could not place; the fetched text is kept for those regions. */
  failed: number;
  /** Whether the displayed text differs from the buffer that went in. */
  changed: boolean;
}

/**
 * @param buffer text the editor holds, including keystrokes typed during the round
 * @param baseline text the buffer was loaded from, i.e. the ancestor of the local edits
 * @param fetched text the row now carries
 * @returns the text to display and how many hunks could not be placed
 */
export function reapplyBuffer(buffer: string, baseline: string, fetched: string): ReapplyResult {
  if (buffer === baseline) return { txt: fetched, failed: 0, changed: fetched !== buffer };
  if (buffer === fetched) return { txt: fetched, failed: 0, changed: false };
  const dmp = new diffmp.diff_match_patch();
  const [txt, flags] = dmp.patch_apply(dmp.patch_make(baseline, buffer), fetched);
  const failed = flags.filter(ok => !ok).length;
  return { txt, failed, changed: txt !== buffer };
}

/** What a persist does with the buffer it holds.
 *  `skip` the row already carries it, `adopt` the buffer follows the fetched text,
 *  `merged` the keystrokes were placed on it, `conflict` a hunk was not placed and the edit
 *  is filed as `cr` instead of written. */
export type PersistPlan =
  | { action: 'skip'; txt: string }
  | { action: 'adopt'; txt: string }
  | { action: 'merged'; txt: string }
  | { action: 'conflict'; txt: string; failed: number }

/**
 * Decide how the buffer is written against the text its row carries now.
 * @param buffer text the editor holds, including keystrokes typed since `baseline`
 * @param baseline text the buffer was last based on
 * @param fetched text the row carries now
 * @returns the action and the text to write, or to display when nothing is written
 */
export function planPersist(buffer: string, baseline: string, fetched: string): PersistPlan {
  if (buffer === fetched) return { action: 'skip', txt: fetched };
  if (buffer === baseline) return { action: 'adopt', txt: fetched };
  const { txt, failed } = reapplyBuffer(buffer, baseline, fetched);
  return failed > 0 ? { action: 'conflict', txt, failed } : { action: 'merged', txt };
}
