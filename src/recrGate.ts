/**
 * recrGate.ts — tool gate levels for the recr agentic loop.
 *
 * The level lives in `gate.md` (`ref='gate.md'`, `type='md'`), using the same
 * Markdown dialect as `secret.md`:
 *
 *   ## Selected
 *   * Level: rw
 *
 *   ## Endpoints
 *   - https://example.com
 *
 * Levels are cumulative: `read` is the floor and `all` the ceiling. A missing,
 * unreadable, or unrecognized level means `read`, so a client that has not been
 * configured never gets a writing tool.
 */

import { bulletKv, splitSections } from './recrMd';
import { daRead, DEL_TAG } from './sdb';
import { GATE_REF, TASK_COMPLETE } from './recrConst';
import type { ToolDef } from './recr';

export { GATE_REF };

export type GateLevel = 'read' | 'rw' | 'rwr' | 'all';

/** Levels from least to most privileged. */
const ORDER: GateLevel[] = ['read', 'rw', 'rwr', 'all'];

/** Tools each level adds on top of the ones below it. */
const ADDED: Record<GateLevel, string[]> = {
  read: ['read_file', 'search_content', 'list_dir'],
  rw: ['write_file'],
  rwr: ['run_src'],
  all: ['run_command'],
};

/** Everything `gate` leaves open: level `read` or absent means the least privilege. */
export interface GateConfig {
  level: GateLevel;
  /** Endpoint prefixes `run_command` may call; empty means none. */
  endpoints: string[];
}

/** Tools `level` allows, cumulative; ending a turn is never gated. */
export function gateTools(level: GateLevel): Set<string> {
  const upTo = ORDER.slice(0, ORDER.indexOf(level) + 1);
  return new Set([...upTo.flatMap(l => ADDED[l]), TASK_COMPLETE]);
}

/** `tools` minus everything `level` refuses. */
export function filterTools(tools: ToolDef[], level: GateLevel): ToolDef[] {
  const allowed = gateTools(level);
  return tools.filter(t => allowed.has(t.name));
}

/**
 * Reads `gate.md`.
 *
 * @returns the configured level and endpoint list; `read` with no endpoints when
 *   the document is absent, tombstoned, or names a level that does not exist
 */
export async function loadGate(): Promise<GateConfig> {
  const row = await daRead(GATE_REF, 'md');
  if (!row || row.tags?.includes(DEL_TAG)) {
    console.warn(`[recr] ${GATE_REF} not found; gate level defaults to "read"`);
    return { level: 'read', endpoints: [] };
  }

  const sections = splitSections(row.txt);
  const named = bulletKv(sections.get('Selected') ?? '')['level'] ?? '';
  const level = ORDER.find(l => l === named);
  if (!level) {
    // Fail closed: an unreadable level must not widen the gate.
    if (named) console.warn(`[recr] ${GATE_REF}: unknown level "${named}"; using "read"`);
    return { level: 'read', endpoints: [] };
  }

  const endpoints = (sections.get('Endpoints') ?? '').split('\n')
    .map(line => line.match(/^\s*-\s*(\S+)\s*$/)?.[1])
    .filter((url): url is string => url !== undefined);
  return { level, endpoints };
}
