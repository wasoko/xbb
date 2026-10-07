/**
 * sessionTree.ts — the session/node model over recr's rows in `db.das`.
 *
 * A session is rows `sess/{id}/meta` (`BranchingSession` JSON) and
 * `sess/{id}/node/{nodeId}` (`TurnNode` JSON), all `type='recr'`. Branch linkage
 * is `TurnNode.parentId` alone: nothing writes `TurnNode.version` (every writer
 * stores `1`) and no row records a sibling list, so "version 2 of 3" is derived
 * here from a node's position among the siblings sharing its parent.
 *
 * Reads go through `IRecrStore.scan`, which collapses the local-edit and synced
 * copies of one ref the way `daWin` does. Every parse is defensive: another
 * writer may leave a row this module does not understand, and one unreadable row
 * must not hide the rest of the tree.
 */

import type { IRecrStore } from './recr';
import { RECR_SOURCE_ID } from './recrConst';

/** Ref prefix of every session row. */
export const SESSION_PREFIX = 'sess/';
/** Suffix of a session's meta row. */
export const META_SUFFIX = '/meta';
/** Path segment between a session id and a node id. */
export const NODE_SEGMENT = '/node/';

/** `createBranchingSession`'s title, which the session list replaces with a preview. */
export const PLACEHOLDER_TITLE = 'New Session';

/** Ref of one node row. */
export const sessionNodeRef = (sessionId: string, nodeId: string): string =>
  `${SESSION_PREFIX}${sessionId}${NODE_SEGMENT}${nodeId}`;

/** The parts of a session row ref. */
export interface SessionRef {
  sessionId: string;
  kind: 'meta' | 'node';
  /** Node id, present for `kind: 'node'`. */
  nodeId?: string;
}

/**
 * Split a session row ref into its parts.
 *
 * @param ref - Row ref, e.g. `sess/abc/node/n1`.
 * @returns The parts, or undefined when the ref is not a session row.
 */
export function parseSessionRef(ref: string): SessionRef | undefined {
  if (!ref.startsWith(SESSION_PREFIX)) return undefined;
  const rest = ref.slice(SESSION_PREFIX.length);
  if (rest.endsWith(META_SUFFIX)) {
    const sessionId = rest.slice(0, -META_SUFFIX.length);
    return sessionId ? { sessionId, kind: 'meta' } : undefined;
  }
  const at = rest.indexOf(NODE_SEGMENT);
  if (at <= 0) return undefined;
  const nodeId = rest.slice(at + NODE_SEGMENT.length);
  if (!nodeId || nodeId.includes('/')) return undefined;
  return { sessionId: rest.slice(0, at), kind: 'node', nodeId };
}

/** One session an adapter found, as the picker lists it. */
export interface SessionSummary {
  id: string;
  /** Meta title when it is not the placeholder, else the first user turn, else the id. */
  title: string;
  /** Adapter that owns the session, for the source seam. */
  source: string;
  /** Provider heading the meta pins this chat to, absent when it follows the UI's selection. */
  provider?: string;
  /** `Models` alias the meta pins this chat to, absent when it follows the UI's selection. */
  model?: string;
  /** Newest of the meta `updatedAt` and the node timestamps. */
  updatedAt: number;
  nodeCount: number;
  /** First user turn of the session, empty when no node parses. */
  preview: string;
}

/** The tree-relevant fields of one node row. */
export interface NodeRecord {
  id: string;
  parentId: string | null;
  timestamp: number;
  /** User turn text, for the drawer row. */
  prompt: string;
  /** Assistant text, for the drawer row when the user turn is empty. */
  reply: string;
}

/** A `NodeRecord` placed in the tree, with the sibling position nothing stores. */
export interface SessionNode extends NodeRecord {
  /** Distance from the root, 0 for a root. */
  depth: number;
  /** 0-based position among the siblings sharing this node's parent. */
  siblingIndex: number;
  siblingCount: number;
  /** Ids of those siblings, in order. */
  siblingIds: string[];
  childCount: number;
}

/** Label of a node among its siblings: empty when it is an only child. */
export const siblingLabel = (n: SessionNode): string =>
  n.siblingCount > 1 ? `v${n.siblingIndex + 1}/${n.siblingCount}` : '';

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

const asNumber = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** First line of a text, cropped for a list row. */
export const oneLine = (txt: string, max = 60): string => {
  const line = txt.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/**
 * The meta fields this module reads.
 *
 * @param txt - Raw `sess/{id}/meta` row text.
 * @returns The fields, with absent ones left undefined, or undefined when the row is not JSON.
 */
function readMeta(
  txt: string,
): { title?: string; source?: string; provider?: string; model?: string; updatedAt?: number } | undefined {
  let o: unknown;
  try {
    o = JSON.parse(txt);
  } catch {
    return undefined;
  }
  if (typeof o !== 'object' || o === null) return undefined;
  const m = o as Record<string, unknown>;
  return {
    title: typeof m.title === 'string' ? m.title : undefined,
    source: typeof m.source === 'string' ? m.source : undefined,
    provider: typeof m.provider === 'string' ? m.provider : undefined,
    model: typeof m.model === 'string' ? m.model : undefined,
    updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : undefined,
  };
}

/**
 * Title of a meta row's text: empty when the row is unreadable or still carries
 * `createBranchingSession`'s placeholder.
 *
 * @param txt - Raw `sess/{id}/meta` row text.
 * @returns The title, or an empty string.
 */
export function metaTitle(txt: string): string {
  const title = readMeta(txt)?.title;
  return title && title !== PLACEHOLDER_TITLE ? title : '';
}

/**
 * One-line label of a recr row, for the card list. A session row reads as its title, a
 * node row as the turn it holds; a row's own text is JSON, so cropping it would show
 * braces instead of the conversation.
 *
 * @param row - Row to label, read for its `ref` and `txt` alone.
 * @returns The label, falling back to the row's ref.
 */
export function recrRowLabel(row: { ref: string; txt: string }): string {
  const ref = parseSessionRef(row.ref);
  if (ref?.kind === 'meta') return metaTitle(row.txt) || `${ref.sessionId} · session`;
  if (ref?.kind === 'node') {
    const node = readNodeRecord(row.txt);
    return node ? oneLine(node.prompt || node.reply || node.id, 80) : `${ref.sessionId} · ${ref.nodeId}`;
  }
  return row.ref;
}

/**
 * The tree-relevant fields of a node row.
 *
 * @param txt - Raw `sess/{id}/node/{nodeId}` row text.
 * @returns The record, or undefined when the row has no usable id.
 */
export function readNodeRecord(txt: string): NodeRecord | undefined {
  let o: unknown;
  try {
    o = JSON.parse(txt);
  } catch {
    return undefined;
  }
  if (typeof o !== 'object' || o === null) return undefined;
  const n = o as Record<string, unknown>;
  const id = asString(n.id);
  if (!id) return undefined;
  const user = (typeof n.userMessage === 'object' && n.userMessage !== null
    ? n.userMessage : {}) as Record<string, unknown>;
  const reply = (typeof n.assistantResponse === 'object' && n.assistantResponse !== null
    ? n.assistantResponse : {}) as Record<string, unknown>;
  return {
    id,
    parentId: asString(n.parentId) || null,
    timestamp: asNumber(n.timestamp),
    prompt: asString(user.content),
    reply: asString(reply.content),
  };
}

/** Node records ordered by `timestamp`, then by id so an equal stamp is stable. */
const byTime = (nodes: NodeRecord[]): NodeRecord[] =>
  [...nodes].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));

/**
 * Place node records in a tree, depth-first, siblings ordered by `timestamp`.
 *
 * A `parentId` naming a node the session does not hold makes the record a root,
 * so an orphan stays visible. A parent cycle leaves nodes unreachable from every
 * root; those follow as roots of their own, so no record is dropped.
 *
 * @param records - Node records of one session.
 * @returns Every record, in render order, with its depth and sibling position.
 */
export function buildSessionTree(records: NodeRecord[]): SessionNode[] {
  const byId = new Map<string, NodeRecord>();
  for (const r of records) byId.set(r.id, r);

  const childrenOf = new Map<string, NodeRecord[]>();
  const roots: NodeRecord[] = [];
  for (const r of byId.values()) {
    const parent = r.parentId && r.parentId !== r.id && byId.has(r.parentId) ? r.parentId : null;
    if (parent === null) {
      roots.push(r);
      continue;
    }
    const held = childrenOf.get(parent);
    if (held) held.push(r);
    else childrenOf.set(parent, [r]);
  }

  const out: SessionNode[] = [];
  const visited = new Set<string>();
  const emit = (r: NodeRecord, depth: number, siblings: NodeRecord[]): void => {
    if (visited.has(r.id)) return;
    visited.add(r.id);
    const kids = byTime(childrenOf.get(r.id) ?? []);
    const at = siblings.indexOf(r);
    out.push({
      ...r,
      depth,
      siblingIndex: at < 0 ? 0 : at,
      siblingCount: siblings.length,
      siblingIds: siblings.map((s) => s.id),
      childCount: kids.length,
    });
    for (const k of kids) emit(k, depth + 1, kids);
  };

  const sortedRoots = byTime(roots);
  for (const r of sortedRoots) emit(r, 0, sortedRoots);
  for (const r of byTime([...byId.values()].filter((n) => !visited.has(n.id)))) emit(r, 0, [r]);
  return out;
}

/**
 * The siblings of one node, itself included, in tree order.
 *
 * @param tree - Tree from {@link buildSessionTree}.
 * @param nodeId - Node to place.
 * @returns The sibling run, or an empty array when the node is not in the tree.
 */
export function siblingsOf(tree: SessionNode[], nodeId: string): SessionNode[] {
  const self = tree.find((n) => n.id === nodeId);
  if (!self) return [];
  const rank = new Map(self.siblingIds.map((id, i) => [id, i]));
  return tree.filter((n) => rank.has(n.id))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

/**
 * The chain from a root to one node, the node last.
 *
 * @param tree - Tree from {@link buildSessionTree}.
 * @param nodeId - Node to walk to.
 * @returns The chain, or an empty array when the node is not in the tree.
 */
export function pathToNode(tree: SessionNode[], nodeId: string): SessionNode[] {
  const byId = new Map(tree.map((n) => [n.id, n]));
  const chain: SessionNode[] = [];
  const seen = new Set<string>();
  let cur = byId.get(nodeId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

/**
 * The node a session opens on: its recorded head when the tree holds that node, else the
 * newest node, so a session whose meta row lost its head still shows a branch.
 *
 * @param tree - Tree from {@link buildSessionTree}.
 * @param headId - `currentHeadId` as stored, absent on a partial or foreign meta row.
 * @returns The node id, or null when the session holds no node.
 */
export function openNodeId(tree: SessionNode[], headId: string | null | undefined): string | null {
  if (headId && tree.some((n) => n.id === headId)) return headId;
  return tree.reduce<SessionNode | undefined>(
    (best, n) => (!best || n.timestamp > best.timestamp ? n : best), undefined,
  )?.id ?? null;
}

/**
 * Every session the store holds, newest first.
 *
 * One `scan` of the session prefix feeds both parts: the meta rows name the
 * sessions and the node rows supply counts, newest stamp, and the preview the
 * picker shows while `title` is still the placeholder. A session whose meta row
 * is missing or unreadable still lists, titled by its first user turn.
 *
 * @param store - Store holding the session rows.
 * @returns One summary per session, newest `updatedAt` first.
 */
export async function listSessions(store: IRecrStore): Promise<SessionSummary[]> {
  const rows = await store.scan(SESSION_PREFIX);
  interface Acc {
    title?: string;
    source?: string;
    provider?: string;
    model?: string;
    metaAt?: number;
    nodeCount: number;
    nodeAt: number;
    first?: NodeRecord;
  }
  const acc = new Map<string, Acc>();
  const at = (id: string): Acc => {
    const held = acc.get(id);
    if (held) return held;
    const fresh: Acc = { nodeCount: 0, nodeAt: 0 };
    acc.set(id, fresh);
    return fresh;
  };

  for (const { key, value } of rows) {
    const ref = parseSessionRef(key);
    if (!ref) continue;
    const entry = at(ref.sessionId);
    if (ref.kind === 'meta') {
      const meta = readMeta(value);
      if (!meta) continue;
      entry.title = meta.title;
      entry.source = meta.source;
      entry.provider = meta.provider;
      entry.model = meta.model;
      entry.metaAt = meta.updatedAt;
      continue;
    }
    const node = readNodeRecord(value);
    if (!node) continue;
    entry.nodeCount += 1;
    entry.nodeAt = Math.max(entry.nodeAt, node.timestamp);
    if (!entry.first || node.timestamp < entry.first.timestamp) entry.first = node;
  }

  const out: SessionSummary[] = [];
  for (const [id, e] of acc) {
    const preview = e.first ? oneLine(e.first.prompt || e.first.reply) : '';
    const title = e.title && e.title !== PLACEHOLDER_TITLE ? e.title : preview || id;
    out.push({
      id,
      title,
      source: e.source || RECR_SOURCE_ID,
      provider: e.provider,
      model: e.model,
      updatedAt: Math.max(e.nodeAt, e.metaAt ?? 0),
      nodeCount: e.nodeCount,
      preview,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/**
 * The node records of one session, in no particular order.
 *
 * @param store - Store holding the session rows.
 * @param sessionId - Session to read.
 * @returns One record per readable node row.
 */
export async function loadSessionNodes(store: IRecrStore, sessionId: string): Promise<NodeRecord[]> {
  const rows = await store.scan(sessionNodeRef(sessionId, ''));
  const out: NodeRecord[] = [];
  for (const { key, value } of rows) {
    const ref = parseSessionRef(key);
    if (ref?.kind !== 'node' || ref.sessionId !== sessionId) continue;
    const node = readNodeRecord(value);
    if (node) out.push(node);
  }
  return out;
}

/**
 * The tree of one session.
 *
 * @param store - Store holding the session rows.
 * @param sessionId - Session to read.
 * @returns The tree, or an empty array when the session holds no readable node.
 */
export async function loadSessionTree(
  store: IRecrStore,
  sessionId: string,
): Promise<SessionNode[]> {
  return buildSessionTree(await loadSessionNodes(store, sessionId));
}

/** Tab-ref prefix marking a tab that shows a recr row rather than a file. */
export const RECR_TAB_PREFIX = 'recr|';

/**
 * The tab ref of a recr row. The editor resolves a tab's row type from the ref's
 * extension, which would look for a `src` row beside the `recr` one, so the tab
 * carries the type instead.
 */
export const recrTabRef = (ref: string): string => `${RECR_TAB_PREFIX}${ref}`;

/** The recr row a tab shows, or undefined for every other tab. */
export const parseRecrTabRef = (tab: string): string | undefined =>
  tab.startsWith(RECR_TAB_PREFIX) && tab.length > RECR_TAB_PREFIX.length
    ? tab.slice(RECR_TAB_PREFIX.length)
    : undefined;

/** Where clicking a recr row sends the app. */
export type RecrTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'node'; sessionId: string; nodeId: string }
  | { kind: 'tab'; ref: string };

/**
 * The jump target of a recr row: a session or node row focuses the chat, every
 * other recr row (`settings/main`, `tools/*`) opens in the editor pane.
 *
 * @param ref - Row ref.
 * @returns The target to act on.
 */
export function recrTargetOf(ref: string): RecrTarget {
  const parsed = parseSessionRef(ref);
  if (parsed?.kind === 'meta') return { kind: 'session', sessionId: parsed.sessionId };
  if (parsed?.kind === 'node' && parsed.nodeId) {
    return { kind: 'node', sessionId: parsed.sessionId, nodeId: parsed.nodeId };
  }
  return { kind: 'tab', ref };
}
