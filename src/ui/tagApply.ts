/**
 * tagApply.ts — write srctag's suggestions through the app's own row recipe.
 *
 * `srctag.ts` scores tags and `planTagUpdates` decides what each row should
 * carry; this module is the only place that turns that into a `db.das` write.
 * The write goes through `daEdit`, the same recipe the editor uses, so an
 * auto-written tag shelves the pre-edit version and a later diff can show it,
 * which `dexieTagPort` alone would not do.
 *
 * Every write is add-only by default: a search or a suggestion never removes a
 * tag. The caller gets the pre-write fields back, so a toast can offer a revert.
 */

import { daEdit, db, isUiTag, type Da } from '../sdb';
import { greet } from '../greet';
import {
  planTagUpdates, tagRowsInteractive, tokenize,
  type PlanTagOptions, type TagRow, type TagUpdate,
} from '../srctag';

/** The pre-write fields a revert restores, per row. */
export interface TagUndo {
  tid: number;
  ref: string;
  tags: string[];
  rec: Record<string, unknown>;
}

/** Push function run once after a batch; the app's `greet` ships the dirty rows. */
export type TagPush = (table: typeof db.das) => Promise<unknown>;

/** Query tokens used as priority tags; a longer query would drown the row's own terms. */
export const MAX_QUERY_TAGS = 4;

/** Result of one tagging action: what was written, and how to undo it. */
export interface TagApplyResult {
  /** Rows actually written. */
  rows: number;
  /** Tags written, deduplicated and in write order. */
  tags: string[];
  undo: TagUndo[];
  updates: TagUpdate[];
}

/**
 * Drop updates that would change nothing, so a suggestion no row supports writes nothing.
 *
 * @param updates planned updates
 * @returns the updates that add or remove at least one tag
 */
function effective(updates: TagUpdate[]): TagUpdate[] {
  return updates.filter((u) => u.add.length > 0 || u.remove.length > 0);
}

/**
 * Write planned updates, shelving each row's pre-edit text.
 *
 * Provenance is merged over the shelf rather than replacing it, so `rec.ver`
 * survives and a later merge can still patch against the held ancestor.
 *
 * @param updates planned updates
 * @param push sync push run once when anything was written
 * @returns one undo entry per written row
 */
export async function applyTagUpdates(updates: TagUpdate[], push: TagPush = greet): Promise<TagUndo[]> {
  const undo: TagUndo[] = [];
  for (const u of updates) {
    const row = await db.das.get(u.tid);
    if (!row) continue;
    const spec = daEdit(row, row.txt);
    await db.das.update(u.tid, {
      ...spec,
      tags: u.tags,
      rec: { ...(spec.rec ?? row.rec ?? {}), ...u.rec },
    });
    undo.push({ tid: u.tid, ref: row.ref, tags: row.tags ?? [], rec: row.rec ?? {} });
  }
  if (undo.length > 0) await push(db.das);
  return undo;
}

/**
 * Restore the tags and provenance a batch replaced, then push.
 *
 * @param undo entries returned by {@link applyTagUpdates}
 * @param push sync push run once when anything was restored
 */
export async function revertTagUpdates(undo: TagUndo[], push: TagPush = greet): Promise<void> {
  for (const u of undo) {
    await db.das.update(u.tid, { tags: u.tags, rec: u.rec, modAt: new Date() });
  }
  if (undo.length > 0) await push(db.das);
}

/**
 * Tag rows with the query's own tokens, add-only.
 *
 * The tokens become priority tags for `tagRowsInteractive`, which keeps the
 * lexical channels only: no embedding or classifier call is made, so this is
 * safe to run from a keystroke-driven surface.
 *
 * @param rows candidate rows, usually the search dropdown's current matches
 * @param query the user's query text
 * @param opts push override and extra plan options
 * @returns what was written, and how to undo it
 */
export async function tagRowsWithQuery(
  rows: Da[],
  query: string,
  opts: { push?: TagPush; plan?: PlanTagOptions } = {},
): Promise<TagApplyResult> {
  const priority = [...new Set(tokenize(query))].slice(0, MAX_QUERY_TAGS);
  if (priority.length === 0) return { rows: 0, tags: [], undo: [], updates: [] };

  const targets = rows.filter((r): r is Da => typeof r.tid === 'number' && isUiTag(r));
  if (targets.length === 0) return { rows: 0, tags: [], undo: [], updates: [] };

  const results = await tagRowsInteractive(
    targets as TagRow[], targets.map((r) => r.tid as number), { priorityTags: priority },
  );
  const updates = effective(planTagUpdates(results, {
    mode: 'add', src: 'omnibox', keep: ['pin'], only: priority, ...opts.plan,
  }));
  const undo = await applyTagUpdates(updates, opts.push);
  const tags = [...new Set(updates.flatMap((u) => u.add))];
  return { rows: undo.length, tags, undo, updates };
}

/**
 * Tag rows with an explicit tag list, add-only.
 *
 * Each tag is a priority signal, so only the rows that support it are written:
 * a row is left alone when neither its own tokens nor a keyword match name the
 * tag. That is what makes a suggestion safe to click.
 *
 * @param rows candidate rows
 * @param tags the tags to write
 * @param opts push override, extra plan options, and the provenance channel
 * @returns what was written, and how to undo it
 */
export async function tagRowsWithTags(
  rows: Da[],
  tags: string[],
  opts: { push?: TagPush; plan?: PlanTagOptions; src?: string } = {},
): Promise<TagApplyResult> {
  const wanted = [...new Set(tags.filter(Boolean))];
  if (wanted.length === 0) return { rows: 0, tags: [], undo: [], updates: [] };

  const targets = rows.filter((r): r is Da => typeof r.tid === 'number' && isUiTag(r));
  if (targets.length === 0) return { rows: 0, tags: [], undo: [], updates: [] };

  const results = await tagRowsInteractive(
    targets as TagRow[], targets.map((r) => r.tid as number), { priorityTags: wanted },
  );
  const updates = effective(planTagUpdates(results, {
    mode: 'add', src: opts.src ?? 'suggest', keep: ['pin'], only: wanted, ...opts.plan,
  }));
  const undo = await applyTagUpdates(updates, opts.push);
  const written = [...new Set(updates.flatMap((u) => u.add))];
  return { rows: undo.length, tags: written, undo, updates };
}
