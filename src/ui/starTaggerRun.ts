/**
 * starTaggerRun.ts — the sea's `star.tagger.md` seed and its generated taxonomy.
 *
 * The seed itself is `seaPinGraph.loadPinGraph`; this module owns the row that is
 * seeded when missing and the `## Taxonomy` section the sea writes back after a
 * seed. The text builder lives in `starTaggerTrace.ts`, where it stays pure and
 * testable without Dexie.
 */

import { greet } from '../greet';
import { daEdit, daRead, db } from '../sdb';
import {
  STAR_TAGGER_DOC, STAR_TAGGER_REF, parseStarTaggerDoc, setSection, setSetupValue,
  type StarTaggerSetup,
} from '../starTagger';
import { buildStarTaxonomy } from '../starTaggerTrace';
import type { PinGraphSeed, StarTiming } from './seaPinGraph';

export { buildStarTaxonomy } from '../starTaggerTrace';
export type { StarTaxonomy, StarTaxonomyRow } from '../starTaggerTrace';

/** A seed in flight, so StrictMode and two mounts cannot add two rows. */
let ensuring: Promise<void> | undefined;

/**
 * Seed `star.tagger.md` when it is missing.
 *
 * An existing row is never overwritten, including one the user left empty, so
 * the call is safe on every mount.
 *
 * @returns the in-flight seed, so a caller can await it
 */
export function ensureStarTaggerRow(): Promise<void> {
  ensuring ??= (async () => {
    const row = await daRead(STAR_TAGGER_REF, 'md');
    if (row !== undefined) return;
    await db.das.add({
      ref: STAR_TAGGER_REF, type: 'md', txt: STAR_TAGGER_DOC,
      tags: ['tagger'], rec: {}, modAt: new Date(),
    });
  })().finally(() => { ensuring = undefined; });
  return ensuring;
}

/** What one trace write did. */
export interface StarTraceReport {
  /** Whether the row was changed and pushed. */
  wrote: boolean;
  /** The generated section body. */
  text: string;
  /** Table rows written, after the cap. */
  nodes: number;
}

/**
 * Write the generated `## Taxonomy` section back to `star.tagger.md`.
 *
 * Only that section is replaced; `## Setup` and `## Notes` stay as the user
 * wrote them. A second identical seed writes and pushes nothing. A one-shot
 * `reset: yes` is cleared after the write.
 *
 * @param seed the sea's seed
 * @param setup its overrides
 * @param timings stage timings
 * @param now seed stamp, injectable for a deterministic test
 * @returns whether the row changed, and the section that was written
 */
export async function writeStarTaggerTrace(
  seed: PinGraphSeed, setup: StarTaggerSetup, timings: StarTiming, now: Date = new Date(),
): Promise<StarTraceReport> {
  const built = buildStarTaxonomy(seed, setup, timings, now);
  const row = await daRead(STAR_TAGGER_REF, 'md');
  const held = row?.txt ?? STAR_TAGGER_DOC;
  /* The stamp and timing line change on every seed even when the taxonomy does
     not, so compare only the table and relation sections. */
  const payload = (text: string): string => text.split('\n')
    .filter((line) => !line.startsWith('seeded ') && !line.startsWith('time: '))
    .join('\n');
  const previous = parseStarTaggerDoc(held).taxonomy;
  if (row !== undefined && !setup.reset && payload(previous) === payload(built.text)) {
    return { wrote: false, text: built.text, nodes: built.nodes };
  }
  let next = setSection(held, 'Taxonomy', built.text);
  if (setup.reset) next = setSetupValue(next, 'reset', 'no');
  if (row?.tid !== undefined) {
    await db.das.update(row.tid, daEdit(row, next));
  } else {
    await db.das.add({
      ref: STAR_TAGGER_REF, type: 'md', txt: next,
      tags: ['tagger'], rec: {}, modAt: new Date(),
    });
  }
  await greet(db.das);
  return { wrote: true, text: built.text, nodes: built.nodes };
}
