/**
 * recrConst.ts — identifiers shared by the recr store, the gate, and `sdb`.
 *
 * These live apart from `recr.ts` so `recrGate.ts` and `sdb.ts` can name them
 * without importing the loop module that imports them back.
 */

/** Row type holding recr's own keys: sessions, settings, tool definitions. */
export const RECR_TYPE = 'recr';
/** Row ref holding the secret document. */
export const SECRET_REF = 'secret.md';
/** Row ref holding the tool gate document. */
export const GATE_REF = 'gate.md';
/** Name of the tool that ends a turn. */
export const TASK_COMPLETE = 'task_complete';
