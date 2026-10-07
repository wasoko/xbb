/**
 * recr.ts — VS Code-inspired Agentic Tool-Calling Loop
 *
 * Implements a while(true) loop that mirrors VS Code's ToolCallingLoop:
 * buildPrompt -> fetchLLM (SSE streaming, incremental tool_calls via callback)
 * -> check toolCalls.length -> execute -> append tool results -> loop
 *
 * Storage: pluggable via IRecrStore, backed by `sdb`'s `db.das` rows under
 * `type='recr'`. Markdown keys (`secret.md`, `gate.md`) resolve in the `md`
 * namespace, so one table serves both the agent and the tag UI.
 * Message passing: unified wrapper for chrome.runtime.sendMessage / window.postMessage.
 * Built-in tools: Dexie-backed file tools plus `run_src` script and module execution.
 *
 * Reference: /mnt/c/q/t/vscode/extensions/copilot/src/extension/intents/node/toolCallingLoop.ts
 */

import type { Table } from 'dexie';
import { db, DEL_TAG, daDirty, daEdit, daLive, daType as fileType, daWin, treeCac, treeCacOpts, treeCacCurrent } from './sdb';
import type { Da } from './sdb';
import * as fc from './fc';
import { bulletKv, bulletList, splitSections, subSections } from './recrMd';
import { GATE_REF, RECR_SOURCE_ID, RECR_TYPE, SECRET_REF, TASK_COMPLETE } from './recrConst';
import { filterTools, gateTools, loadGate, type GateConfig } from './recrGate';
import { runBody, type RecrScriptContext } from './runsrc';
import {
  recrHost, buildContext, buildRequestState, defaultToolMeta,
  initDefaultPlugins,
} from './recrPlugin';
import type {
  RecrPlugin, RecrPluginHost, RecrContext,
  RequestState, RequestInputState, TokenUsageDetail, RequestTokenUsage,
  RequestTimings, ToolInvocationMeta,
  AgentMetadata, ModelIdentity, ModelConfiguration, ModeInfo, AttachmentRef,
  WebhookTarget,
} from './recrPlugin';

// Re-export plugin types so consumers import from recr.ts only
export type {
  RecrPlugin, RecrPluginHost, RecrContext,
  RequestState, RequestInputState, TokenUsageDetail, RequestTokenUsage,
  RequestTimings, ToolInvocationMeta,
  AgentMetadata, ModelIdentity, ModelConfiguration, ModeInfo, AttachmentRef,
  WebhookTarget,
};
export { recrHost, initDefaultPlugins };
export { GATE_REF, RECR_TYPE, SECRET_REF, TASK_COMPLETE };
// the src-row evaluator lives in `runsrc.ts`; re-exported so consumers keep one import site
export { isModuleSource, moduleSourceUrl, runBody } from './runsrc';
export type { RecrScriptContext } from './runsrc';

// ─── Pluggable Storage Interface ───────────────────────────────────────────

/** Tag marking a file the agent created, so its rows stay identifiable in the tag UI. */
export const AI_TAG = 'ai';

/** Row type for a file ref, matching the `src`/`md` pair the editor offers. */
export { fileType };

export interface IRecrStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  /** prefix scan: returns {key, value} pairs where key starts with prefix */
  scan(prefix: string): Promise<{ key: string; value: string }[]>;
  delete(key: string): Promise<void>;

  // ── file layer: `ref` is a path, `type` comes from the extension ──
  /** Body of the file row `ref`, or undefined when no live row exists. */
  readFile(ref: string): Promise<string | undefined>;
  /** Replace the body of `ref`, shelving the pre-edit version. Creates the row when absent. */
  writeFile(ref: string, txt: string): Promise<void>;
  /** Every live file row under `prefix`, excluding recr's own rows. */
  scanFiles(prefix: string): Promise<{ ref: string; txt: string }[]>;
  /** Body of the `type='src'` row `ref`, for `run_src`. */
  readScript(ref: string): Promise<string | undefined>;
}

/**
 * Store over `sdb`'s `db.das`.
 *   type = 'recr'   for agent bookkeeping, ref = pseudo-path "sess/{id}/node/{n}"
 *   type = 'md'     for a `.md`-suffixed key, so `secret.md` sits with its own kind
 *
 * A key wins over its synced copy the way the rest of the app resolves rows: a
 * row carrying `modAt` is a local edit that has not been pushed yet.
 */
class DexieTagStore implements IRecrStore {
  constructor(private table: Table<Da> = db.das) {}

  private refKey(key: string): string {
    return key.replace(/\\/g, '/').replace(/^\/+/, '');
  }

  /** Namespace a store key belongs to: markdown keys live beside the tag UI's own rows. */
  private split(key: string): { ref: string; type: string } {
    const ref = this.refKey(key);
    return ref.toLowerCase().endsWith('.md') ? { ref, type: 'md' } : { ref, type: RECR_TYPE };
  }

  /** The row that currently wins for `ref`+`type`, skipping tombstones. */
  private async row(ref: string, type: string): Promise<Da | undefined> {
    const rows = await this.table.where('[ref+type]').equals([ref, type]).toArray();
    return daWin(daLive(rows));
  }

  async get(key: string): Promise<string | undefined> {
    const { ref, type } = this.split(key);
    return (await this.row(ref, type))?.txt;
  }

  async put(key: string, value: string): Promise<void> {
    const { ref, type } = this.split(key);
    const existing = await this.row(ref, type);
    if (existing?.tid != null) {
      // `modAt` marks the row dirty, which is what `greet` pushes to the server.
      await this.table.update(existing.tid, daEdit(existing, value));
      return;
    }
    await this.table.put({ ref, type, txt: value, modAt: new Date(), rec: {} });
  }

  async scan(prefix: string): Promise<{ key: string; value: string }[]> {
    const norm = this.refKey(prefix);
    const rows = await this.table.where('type').equals(RECR_TYPE)
      .filter(r => r.ref.startsWith(norm) && !r.tags?.includes(DEL_TAG))
      .toArray();
    // one entry per ref: a local edit shadows the synced copy of the same ref
    const byRef = new Map<string, Da>();
    for (const r of rows) {
      const held = byRef.get(r.ref);
      if (!held || (!daDirty(held) && daDirty(r))) byRef.set(r.ref, r);
    }
    return [...byRef.values()].map(r => ({ key: r.ref, value: r.txt }));
  }

  async delete(key: string): Promise<void> {
    const { ref, type } = this.split(key);
    const existing = await this.row(ref, type);
    if (existing?.tid == null) return;
    if (type === RECR_TYPE) {
      await this.table.delete(existing.tid);
      return;
    }
    // `secret.md` and friends are shared rows: tombstone so the deletion can propagate
    await this.table.update(existing.tid, { tags: [...(existing.tags ?? []), DEL_TAG], modAt: new Date() });
  }

  async readFile(ref: string): Promise<string | undefined> {
    const norm = this.refKey(ref);
    return (await this.row(norm, fileType(norm)))?.txt;
  }

  async writeFile(ref: string, txt: string): Promise<void> {
    const norm = this.refKey(ref);
    const type = fileType(norm);
    const existing = await this.row(norm, type);
    if (existing?.tid != null) {
      // the editor's own write recipe, so a later sync can patch against the shelved ancestor
      await this.table.update(existing.tid, daEdit(existing, txt));
      return;
    }
    await this.table.put({ ref: norm, type, txt, tags: [AI_TAG], modAt: new Date(), rec: {} });
  }

  async scanFiles(prefix: string): Promise<{ ref: string; txt: string }[]> {
    const norm = this.refKey(prefix);
    const rows = await this.table.filter(r => r.type !== RECR_TYPE
      && r.ref.startsWith(norm) && !r.tags?.includes(DEL_TAG)).toArray();
    return [...new Map(rows.map(r => [r.ref, r])).values()].map(r => ({ ref: r.ref, txt: r.txt }));
  }

  async readScript(ref: string): Promise<string | undefined> {
    return (await this.row(this.refKey(ref), 'src'))?.txt;
  }
}

/** Default store; can be swapped for WebDAV/S3 later. */
let _store: IRecrStore = new DexieTagStore();
export function setStore(s: IRecrStore) { _store = s; }
export function getStore(): IRecrStore { return _store; }

// ─── Unified Message Bus (chrome.runtime.sendMessage / window.postMessage) ──

export type RecrMessage =
  | { kind: 'recr-progress'; sessionId: string; text: string }
  | { kind: 'recr-tool-call'; sessionId: string; toolName: string; args: unknown }
  | { kind: 'recr-tool-result'; sessionId: string; toolName: string; result: string }
  | { kind: 'recr-done'; sessionId: string; finalText: string }
  | { kind: 'recr-error'; sessionId: string; error: string }
  | { kind: 'recr-fork-created'; sessionId: string; nodeId: string; parentId: string | null };

type RecrListener = (msg: RecrMessage) => void;

/**
 * The extension messaging API, reached through `globalThis` because a plain page
 * still defines a `chrome` object, just without `runtime`.
 */
interface ExtRuntime {
  id?: string;
  sendMessage?(msg: RecrMessage): Promise<unknown>;
  onMessage?: { addListener(fn: (msg: RecrMessage) => void): void };
}

/** `chrome.runtime`, or undefined when the page is not an extension context. */
function extRuntime(): ExtRuntime | undefined {
  return (globalThis as { chrome?: { runtime?: ExtRuntime } }).chrome?.runtime;
}

export class RecrMessageBus {
  private listeners = new Set<RecrListener>();
  private extBound = false;
  private domBound = false;

  /** Send a message: auto-detects chrome.runtime or window.postMessage */
  send(msg: RecrMessage): void {
    const runtime = extRuntime();
    if (runtime?.sendMessage) {
      runtime.sendMessage(msg).catch(() => {
        // Extension context may not have a listener; fall through
      });
    }
    if (fc.defDoc()) {
      window.postMessage(msg, '*');
    }
  }

  /** Listen for messages (works in extension or webapp context) */
  on(fn: RecrListener): () => void {
    this.listeners.add(fn);
    this.ensureBound();
    return () => { this.listeners.delete(fn); };
  }

  private ensureBound(): void {
    const runtime = extRuntime();
    if (runtime?.onMessage && !this.extBound) {
      this.extBound = true;
      runtime.onMessage.addListener((msg: RecrMessage) => {
        if (msg.kind?.startsWith('recr-')) {
          for (const fn of this.listeners) fn(msg);
        }
      });
    }
    if (fc.defDoc() && !this.domBound) {
      this.domBound = true;
      window.addEventListener('message', (e: MessageEvent) => {
        if (e.data?.kind?.startsWith('recr-')) {
          for (const fn of this.listeners) fn(e.data as RecrMessage);
        }
      });
    }
  }
}

export const recrBus = new RecrMessageBus();

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SecretsConfig {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  /** Provider heading the selection came from, for display. */
  providerName?: string;
  /** Key under that provider's `Models` list, for display. */
  modelAlias?: string;
  /** `API Keys` alias `apiKey` was read from, for display and for the next-key fallback. */
  keyAlias?: string;
  /** Every alias listed under the provider's `API Keys`, in document order. */
  keyAliases?: string[];
  /** Additional HTTP headers for the fetch call */
  headers?: Record<string, string>;
}

export interface RuntimeSettings {
  temperature?: number;
  maxTokens?: number;
  maxIterations: number;
  maxToolCalls: number;
  /** For models that support reasoning_effort / thinking */
  thinkLevel?: 'low' | 'medium' | 'high';
  /** Extra HTTP headers to merge with provider headers */
  extraHeaders?: Record<string, string>;
}

/** OpenAI Chat Completion message roles */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface SystemMessage { role: 'system'; content: string; }
export interface UserMessage { role: 'user'; content: string; }
export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
}
export interface ToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}
export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

export interface ToolCallRound {
  response: string;
  toolCalls: ToolCall[];
  timestamp: number;
}

export interface AgentSession {
  id: string;
  messages: ChatMessage[];
  toolCallRounds: ToolCallRound[];
  iterationCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * A TurnNode represents a single interaction step (User $\rightarrow$ Assistant $\rightarrow$ Tools).
 * In a branching session, nodes form a tree.
 */
export interface TurnNode {
  id: string;
  parentId: string | null;
  version: number;
  timestamp: number;
  userMessage: UserMessage;
  assistantResponse: AssistantMessage | null;
  toolResults: ToolMessage[];
  metadata: Record<string, unknown>;
}

export interface BranchingSession {
  id: string;
  rootNodeId: string | null;
  currentHeadId: string | null;
  title: string;
  /** Writer that produced the session, so the browser can pick the reader. Absent reads as
   *  `recr`. */
  source?: string;
  /** Provider heading this chat is pinned to; absent follows the UI's selection. */
  provider?: string;
  /** `Models` alias this chat is pinned to; absent follows the UI's selection. */
  model?: string;
  createdAt: number;
  updatedAt: number;
}

/** Provider and model a chat is pinned to, and the source that owns it. */
export interface ChatPin {
  provider: string;
  model: string;
  /** Session source id the chat belongs to; absent keeps recr's own. */
  source?: string;
}

/** Returned by fetchLLM after a single API call */
export interface FetchResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// ─── Secret Parser: Markdown schema -> Dexie tags -> SecretsConfig ──────────

/**
 * Reads `secret.md` (`ref='secret.md'`, `type='md'`) and resolves the selection
 * it names. The document is Markdown:
 *
 *   ## Default
 *   * Provider: fb g4
 *   * Model: qw35
 *   * Keys: v13, v55
 *
 *   ## Providers
 *   ### ds
 *   * API: openai-completions
 *   * Base URL: https://api.deepseek.com
 *   * Models:
 *     - dsv4pro: deepseek-v4-pro
 *     - dsv4f: deepseek-v4-flash
 *   * API Keys:
 *     - wasgsd: sk-...
 *
 * A provider heading may contain spaces. A non-blank `* Keys:` line naming a listed
 * alias is a manual pin and wins. An empty one, or one matching nothing, falls back
 * to *auto track*: the alias this provider's rotation last settled on in
 * {@link KEYS_REF}, else the provider's first listed key. The choice is recorded in
 * `settings/keys` rather than edited into the document, so a rotation stays client
 * state and the shared `secret.md` keeps whatever a human wrote there.
 *
 * @param store store whose `secret.md` key holds the document
 * @param override `'<provider>:<model>'` a chat is pinned to; `'Default'`, absent, or
 *   the UI's own selection when the caller pins nothing
 * @returns resolved endpoint, model, credential, and the provider's key aliases
 * @throws when the document, the named provider, the model alias, or every key is missing
 */
export async function parseSecrets(store: IRecrStore, override?: string): Promise<SecretsConfig> {
  const md = await store.get(SECRET_REF);
  if (!md) throw new Error(`Secret not found: ref=${SECRET_REF}`);

  const sections = splitSections(md);
  const defaults = bulletKv(sections.get('Default') ?? '');
  
  // Populate treeCacOpts with available provider-model pairs
  const provsSection = sections.get('Providers') ?? '';
  const provs = subSections(provsSection);
  const choices = ['Default'];
  for (const [pName, pBody] of provs) {
    const models = bulletList(pBody, 'Models');
    for (const mAlias of Object.keys(models)) {
      choices.push(`${pName}:${mAlias}`);
    }
  }
  treeCacOpts['provider-model'] = choices;

  // Resolve active provider/model: the caller's pin > the UI's selection > Default
  const pinned = override ?? treeCacCurrent['provider-model'];
  let provName: string;
  let modelAlias: string;

  if (pinned && pinned !== 'Default') {
    const [p, m] = pinned.split(':');
    provName = p;
    modelAlias = m;
  } else {
    provName = defaults['provider'] ?? '';
    modelAlias = defaults['model'] ?? '';
  }

  const body = provs.get(provName);
  if (!body) throw new Error(`Provider not found in ${SECRET_REF}: "${provName}"`);

  const prov = bulletKv(body);
  const baseUrl = prov['base url'] ?? '';
  if (!baseUrl) throw new Error(`Provider "${provName}" has no "Base URL"`);

  const model = bulletList(body, 'Models')[modelAlias];
  if (!model) throw new Error(`Model not found in provider "${provName}": "${modelAlias}"`);

  const keys = bulletList(body, 'API Keys');
  const keyAliases = Object.keys(keys);
  const wanted = (defaults['keys'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  // A non-blank `* Keys:` line is the document's own manual pin, ahead of any rotation.
  let keyName = wanted.find(k => keys[k]);
  if (!keyName && wanted.length === 0) {
    // Auto track: the alias this provider's rotation settled on, else the first listed
    // key. The choice lands in `settings/keys`, so `secret.md` keeps its own text and a
    // key that starts failing can be rotated without editing the shared document.
    const tracked = (await readKeyPrefs(store))[provName];
    keyName = tracked && keys[tracked] ? tracked : keyAliases[0];
    if (keyName && keyName !== tracked) {
      await setKeyPref(store, provName, keyName).catch((e: unknown) =>
        console.warn(`[recr] ${KEYS_REF}: could not record key "${keyName}":`, e));
    }
  } else if (!keyName) {
    keyName = keyAliases[0];
    console.warn(`[recr] ${SECRET_REF}: no key matched ${wanted.join(', ')} in "${provName}"`
      + `; using "${keyName ?? '(none listed)'}"`);
  }
  if (!keyName) throw new Error(`Provider "${provName}" lists no API key`);

  return { apiBaseUrl: baseUrl, apiKey: keys[keyName], model
    , providerName: provName, modelAlias, keyAlias: keyName, keyAliases, headers: undefined };
}

/**
 * The alias after `current` in provider order, wrapping to the first. `current`
 * absent or not listed means the first alias, which is also what auto track picks.
 *
 * @param aliases every alias listed under `API Keys`, in document order
 * @param current alias in use, if known
 * @returns the next alias, or undefined when the provider lists fewer than two
 */
export function nextKeyAlias(aliases: string[], current?: string): string | undefined {
  if (aliases.length < 2) return undefined;
  const at = current ? aliases.indexOf(current) : -1;
  return aliases[(at + 1) % aliases.length];
}

/**
 * Rewrites the `* Keys:` line of `secret.md`'s `## Default` section, leaving the
 * rest of the document byte-for-byte. A document without that section gets the
 * line after its first heading.
 *
 * @param md the `secret.md` document
 * @param aliases aliases the Default section should name, in order
 * @returns the rewritten document
 */
export function withSecretKeys(md: string, aliases: string[]): string {
  const lines = md.split('\n');
  const line = `* Keys: ${aliases.join(', ')}`;
  const head = lines.findIndex(l => /^##\s*default\s*$/i.test(l));
  const start = head >= 0 ? head + 1 : 0;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  const at = lines.findIndex((l, i) => i >= start && i < end && /^\*\s*keys\s*:/i.test(l));
  if (at >= 0) lines[at] = line;
  else lines.splice(head >= 0 ? head + 1 : 0, 0, line);
  return lines.join('\n');
}

/**
 * Writes an explicit choice into `secret.md`'s Default `* Keys:` line. A manual pin
 * belongs in the shared document, which is why this edits it; an automatic rotation
 * goes to {@link KEYS_REF} instead.
 *
 * @param store store whose `secret.md` key holds the document
 * @param aliases aliases to write into the Default `* Keys:` line
 * @throws when the document is missing from the store
 */
export async function setSecretKeys(store: IRecrStore, aliases: string[]): Promise<void> {
  const md = await store.get(SECRET_REF);
  if (!md) throw new Error(`Secret not found: ref=${SECRET_REF}`);
  await store.put(SECRET_REF, withSecretKeys(md, aliases));
}

// ─── Key rotation state: settings/keys ─────────────────────────────────────

/**
 * Row recording which `API Keys` alias each provider's automatic rotation last
 * used, one `## <provider>` section per provider that has rotated:
 *
 *   ## fb g4
 *   * Key: v13
 *
 * This is deliberately not `secret.md`: a rotation is client state that changes
 * whenever a key starts failing, while `secret.md` is the document a human edits
 * and every client syncs.
 */
export const KEYS_REF = 'settings/keys';

/**
 * Reads the rotation state.
 *
 * @param store store whose `settings/keys` key holds the document
 * @returns provider heading -> alias; `{}` when the row is absent or names none
 */
export async function readKeyPrefs(store: IRecrStore): Promise<Record<string, string>> {
  const md = await store.get(KEYS_REF);
  if (!md) return {};
  const out: Record<string, string> = {};
  for (const [provider, body] of splitSections(md)) {
    const alias = bulletKv(body)['key'];
    if (provider && alias) out[provider] = alias;
  }
  return out;
}

/** `text` with every regular-expression metacharacter escaped, for a literal heading match. */
const escapeRx = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Rewrites one provider's `* Key:` line, leaving every other byte alone. A provider
 * without a section gets one appended, so the file keeps the order it was written in.
 *
 * @param md the `settings/keys` document, empty when the row does not exist yet
 * @param provider provider heading to write
 * @param alias alias that provider's rotation settled on
 * @returns the rewritten document
 */
export function withKeyPref(md: string, provider: string, alias: string): string {
  const lines = md.split('\n');
  const line = `* Key: ${alias}`;
  const head = lines.findIndex(l => new RegExp(`^##\\s+${escapeRx(provider)}\\s*$`, 'i').test(l));
  if (head < 0) {
    const sep = md === '' || md.endsWith('\n') ? '' : '\n';
    return `${md}${sep}\n## ${provider}\n${line}\n`;
  }
  let end = lines.length;
  for (let i = head + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  const at = lines.findIndex((l, i) => i > head && i < end && /^\*\s*key\s*:/i.test(l));
  if (at >= 0) lines[at] = line;
  else lines.splice(head + 1, 0, line);
  return lines.join('\n');
}

/**
 * Records one provider's rotated key.
 *
 * @param store store whose `settings/keys` key holds the document
 * @param provider provider heading the alias belongs to
 * @param alias alias the rotation settled on
 */
export async function setKeyPref(store: IRecrStore, provider: string, alias: string): Promise<void> {
  const md = (await store.get(KEYS_REF)) ?? '';
  await store.put(KEYS_REF, withKeyPref(md, provider, alias));
}

// ─── Tool Parser: Dexie tags (type='recr', ref='tools/...') -> ToolDef[] ────

/**
 * Each tool is stored as a Dexie tag:
 *   type = 'recr'
 *   ref  = 'tools/builtin/{toolName}'
 *   txt  = markdown AST: name, description, JSON schema
 *   rec  = { parameters: JSONSchema }
 *
 * Markdown format:
 *   ## {toolName}
 *   {description paragraph}
 *   ```json
 *   { "type": "object", "properties": {...}, "required": [...] }
 *   ```
 */
export async function parseTools(store: IRecrStore): Promise<ToolDef[]> {
  const rows = await store.scan('tools/');
  const tools: ToolDef[] = [];

  for (const row of rows) {
    try {
      const name = row.key.split('/').pop() || row.key;
      const md = row.value;

      // Extract description: everything between ## name and the code fence
      const headingEnd = md.indexOf('\n');
      const fenceStart = md.indexOf('```');
      const description = headingEnd >= 0
        ? md.slice(headingEnd, fenceStart >= 0 ? fenceStart : undefined).trim()
        : '';

      // Extract JSON schema from code fence
      const fenceMatch = md.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
      const parameters = fenceMatch
        ? JSON.parse(fenceMatch[1])
        : { type: 'object', properties: {} };

      tools.push({ name, description, parameters });
    } catch (e) {
      console.warn(`[recr] Failed to parse tool ${row.key}:`, e);
    }
  }
  return tools;
}

// ─── Settings Parser ───────────────────────────────────────────────────────

/**
 * Settings stored in Dexie tag with type='recr', ref='settings/main'.
 * Markdown key-value pairs:
 *   * temperature: 0.7
 *   * maxTokens: 4096
 *   * maxIterations: 10
 *   * maxToolCalls: 50
 *   * thinkLevel: medium
 */
export async function parseSettings(store: IRecrStore): Promise<RuntimeSettings> {
  const defaults: RuntimeSettings = {
    temperature: 0.7,
    maxTokens: 4096,
    maxIterations: 10,
    maxToolCalls: 50,
  };

  const md = await store.get('settings/main');
  if (!md) return defaults;

  for (const line of md.split('\n')) {
    const m = line.match(/^\*\s*(\w+):\s*(.+)$/);
    if (!m) continue;
    const k = m[1].trim();
    const v = m[2].trim();

    if (k === 'temperature') defaults.temperature = parseFloat(v);
    else if (k === 'maxTokens') defaults.maxTokens = parseInt(v, 10);
    else if (k === 'maxIterations') defaults.maxIterations = parseInt(v, 10);
    else if (k === 'maxToolCalls') defaults.maxToolCalls = parseInt(v, 10);
    else if (k === 'thinkLevel' && ['low', 'medium', 'high'].includes(v)) {
      defaults.thinkLevel = v as RuntimeSettings['thinkLevel'];
    }
  }
  return defaults;
}

// ─── Session Persistence ───────────────────────────────────────────────────

const SESSION_PREFIX = 'sess/';

export function createSession(id?: string): AgentSession {
  const now = Date.now();
  return {
    id: id ?? `sess-${now}-${Math.random().toString(36).slice(2, 8)}`,
    messages: [],
    toolCallRounds: [],
    iterationCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function createBranchingSession(
  id?: string, title: string = 'New Session', pin?: ChatPin,
): BranchingSession {
  const now = Date.now();
  return {
    id: id ?? `sess-${now}-${Math.random().toString(36).slice(2, 8)}`,
    rootNodeId: null,
    currentHeadId: null,
    title,
    source: pin?.source ?? RECR_SOURCE_ID,
    provider: pin?.provider,
    model: pin?.model,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The selection a session pins, in the form {@link parseSecrets} takes as its override.
 * A session naming only one of provider or model pins nothing, so a half-written meta
 * row falls back to the UI's selection instead of failing the next turn.
 *
 * @param session session whose meta may carry a pin
 * @returns `'<provider>:<model>'`, or undefined when the session follows the UI
 */
export function sessionModelOverride(session: BranchingSession): string | undefined {
  return session.provider && session.model ? `${session.provider}:${session.model}` : undefined;
}

export async function loadSession(store: IRecrStore, id: string): Promise<AgentSession> {
  const raw = await store.get(`${SESSION_PREFIX}${id}/state`);
  if (raw) {
    try { return JSON.parse(raw) as AgentSession; }
    catch { /* fall through to create new */ }
  }
  return createSession(id);
}

export async function loadBranchingSession(store: IRecrStore, id: string): Promise<BranchingSession> {
  const raw = await store.get(`${SESSION_PREFIX}${id}/meta`);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as BranchingSession;
      // a meta row written before the field, or by another writer, reads as recr's
      return { ...parsed, source: parsed.source ?? RECR_SOURCE_ID };
    } catch { /* fall through to create new */ }
  }
  return createBranchingSession(id);
}

export async function saveSession(store: IRecrStore, session: AgentSession): Promise<void> {
  session.updatedAt = Date.now();
  await store.put(`${SESSION_PREFIX}${session.id}/state`, JSON.stringify(session));
}

export async function saveBranchingSession(store: IRecrStore, session: BranchingSession): Promise<void> {
  session.updatedAt = Date.now();
  await store.put(`${SESSION_PREFIX}${session.id}/meta`, JSON.stringify(session));
}

export async function saveTurnNode(store: IRecrStore, session: BranchingSession, node: TurnNode): Promise<void> {
  await store.put(`${SESSION_PREFIX}${session.id}/node/${node.id}`, JSON.stringify(node));
  session.currentHeadId = node.id;
  await saveBranchingSession(store, session);
}

/**
 * Forks a session from a specific node by creating a new branch head.
 */
export async function forkSession(
  store: IRecrStore,
  session: BranchingSession,
  nodeId: string,
  newPrompt: string
): Promise<TurnNode> {
  const newNodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const newNode: TurnNode = {
    id: newNodeId,
    parentId: nodeId,
    version: 1, // Should be derived from parent
    timestamp: Date.now(),
    userMessage: { role: 'user', content: newPrompt },
    assistantResponse: null,
    toolResults: [],
    metadata: {},
  };

  await saveTurnNode(store, session, newNode);
  return newNode;
}

// ─── Tool Executor ─────────────────────────────────────────────────────────

export type ToolImpl = (
  args: Record<string, unknown>,
  store: IRecrStore,
) => Promise<string>;

export class ToolExecutor {
  private registry = new Map<string, ToolImpl>();
  private denied = new Set<string>();

  register(name: string, impl: ToolImpl): void {
    this.registry.set(name, impl);
  }

  /**
   * Refuse `names` for this executor. Both `execute` and the per-call path
   * `runLoop` uses consult `denial`, so a tool filtered out of the tool list
   * is also refused when a model calls it from memory.
   */
  setDeny(names: Iterable<string>): void {
    this.denied = new Set(names);
  }

  /** Message for a gate-refused call, or undefined when `name` may run. */
  denial(name: string): string | undefined {
    return this.denied.has(name)
      ? `Error: tool "${name}" is not permitted at the configured gate level`
      : undefined;
  }

  /** Get a single tool implementation (for per-call hook dispatch) */
  getImpl(name: string): ToolImpl | undefined {
    return this.registry.get(name);
  }

  async execute(calls: ToolCall[], store: IRecrStore): Promise<ToolMessage[]> {
    const results: ToolMessage[] = [];
    for (const call of calls) {
      const impl = this.registry.get(call.function.name);
      let content: string;
      try {
        const refusal = this.denial(call.function.name);
        if (refusal) {
          content = refusal;
        } else if (!impl) {
          content = `Error: unknown tool "${call.function.name}"`;
        } else {
          const args = JSON.parse(call.function.arguments || '{}');
          content = await impl(args, store);
        }
      } catch (e) {
        content = `Error executing ${call.function.name}: ${e instanceof Error ? e.message : String(e)}`;
      }
      results.push({
        role: 'tool',
        tool_call_id: call.id,
        content,
      });
    }
    return results;
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }
}

// ─── Built-in Tools ────────────────────────────────────────────────────────

/**
 * read_file: read a file row — `ref` is the path, `type` comes from the extension.
 */
async function readFile(args: Record<string, unknown>, store: IRecrStore): Promise<string> {
  const filePath = String(args.filePath ?? args.path ?? '');
  if (!filePath) return 'Error: filePath is required';
  const content = await store.readFile(filePath);
  if (content === undefined) return `Error: file not found: ${filePath}`;
  const startLine = typeof args.startLine === 'number' ? args.startLine : undefined;
  const endLine = typeof args.endLine === 'number' ? args.endLine : undefined;
  if (startLine !== undefined || endLine !== undefined) {
    const lines = content.split('\n');
    const s = Math.max(0, (startLine ?? 1) - 1);
    const e = Math.min(lines.length, endLine ?? lines.length);
    return lines.slice(s, e).join('\n');
  }
  const limit = typeof args.limit === 'number' ? args.limit : undefined;
  if (limit !== undefined) {
    return content.slice(0, limit);
  }
  return content;
}

/**
 * write_file: create or replace a file row, shelving the pre-edit version so a
 * later sync can patch the local edit onto the server copy.
 */
async function writeFile(args: Record<string, unknown>, store: IRecrStore): Promise<string> {
  const filePath = String(args.filePath ?? args.path ?? '');
  const content = String(args.content ?? '');
  if (!filePath) return 'Error: filePath is required';
  await store.writeFile(filePath, content);
  return `Wrote ${content.length} chars to ${filePath}`;
}

/**
 * search_content: case-insensitive substring scan over file rows, one line per hit.
 * args.query is the search string, args.directory an optional ref prefix.
 */
async function searchContent(args: Record<string, unknown>, store: IRecrStore): Promise<string> {
  const query = String(args.query ?? args.pattern ?? '');
  if (!query) return 'Error: query is required';
  const directory = String(args.directory ?? args.path ?? '').replace(/^\/+|\/+$/g, '');

  const rows = await store.scanFiles(directory ? `${directory}/` : '');
  const needle = query.toLowerCase();
  const matches: string[] = [];

  for (const row of rows) {
    if (matches.length >= 50) break;
    const lines = row.txt.split('\n');
    for (let i = 0; i < lines.length && matches.length < 50; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        matches.push(`${row.ref}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      }
    }
  }
  return matches.length > 0
    ? matches.join('\n')
    : `No matches found for "${query}"`;
}

/**
 * list_dir: one level of file refs below `args.path`. A ref that continues past
 * the child segment is shown with a trailing slash; file types are not listed.
 */
async function listDir(args: Record<string, unknown>, store: IRecrStore): Promise<string> {
  const dirPath = String(args.path ?? args.directory ?? '').replace(/^\/+|\/+$/g, '');
  const prefix = dirPath ? `${dirPath}/` : '';
  const rows = await store.scanFiles(prefix);

  const children = new Set<string>();
  for (const row of rows) {
    const relative = row.ref.slice(prefix.length);
    if (!relative) continue;
    const slash = relative.indexOf('/');
    children.add(slash >= 0 ? `${relative.slice(0, slash)}/` : relative);
  }

  if (children.size === 0) return '(empty directory)';
  return [...children].sort().join('\n');
}

/**
 * run_src: run the body of a `type='src'` row in page context.
 *
 * The script receives one `ctx` argument — `{ db, ref, args, console }` — so it
 * can reach the Dexie tables and the live DOM directly. That reach is why the
 * gate level, not this tool, is the authorization point: only `rwr` and above
 * offer it. A module row must export a default function that takes `ctx`.
 *
 * @param args `ref` names the script row; `args` is forwarded to the script as `ctx.args`
 * @param store store holding the script row
 * @returns the script's string result, or its JSON form, truncated to 8000 chars
 */
async function runSrc(args: Record<string, unknown>, store: IRecrStore): Promise<string> {
  const ref = String(args.ref ?? args.filePath ?? args.path ?? '');
  if (!ref) return 'Error: ref is required';
  const body = await store.readScript(ref);
  if (body === undefined) return `Error: script not found: ${ref}`;
  const ctx: RecrScriptContext = { db, ref, args: args.args ?? {}, console };
  try {
    const out = await runBody(body, ctx);
    if (out === undefined) return `${ref} completed with no result`;
    return (typeof out === 'string' ? out : JSON.stringify(out, null, 2)).slice(0, 8000);
  } catch (e) {
    return `Error running ${ref}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * run_command: REST call to an endpoint listed under `## Endpoints` in `gate.md`.
 *
 * The list is the whole authorization: an empty list refuses every endpoint, so an
 * unconfigured deployment cannot be talked into arbitrary requests.
 *
 * @param args `endpoint` (required), `method`, `body`, `headers`
 * @param endpoints prefixes allowed by the gate document
 */
async function runCommand(args: Record<string, unknown>, endpoints: string[]): Promise<string> {
  const endpoint = String(args.endpoint ?? args.url ?? '');
  if (!endpoint) return 'Error: endpoint is required';
  if (!endpoints.some(allowed => endpoint.startsWith(allowed))) {
    return `Error: endpoint not listed in gate.md Endpoints: ${endpoint}`;
  }

  const method = String(args.method ?? 'POST').toUpperCase();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(args.headers as Record<string, string> ?? {}),
  };
  const body = args.body ? JSON.stringify(args.body) : undefined;

  try {
    const res = await fetch(endpoint, { method, headers, body, mode: 'cors' });
    const text = await res.text();
    return text.slice(0, 8000); // Truncate for LLM context
  } catch (e) {
    return `Command failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * task_complete: special tool that signals the agentic loop to stop.
 * Mirrors VS Code's TASK_COMPLETE_TOOL_NAME pattern.
 */
async function taskComplete(_args: Record<string, unknown>, _store: IRecrStore): Promise<string> {
  return 'Task marked as complete.';
}

/** Every tool `createDefaultExecutor` can register, in gate-map order. */
export const BUILTIN_TOOL_NAMES = [
  'read_file', 'write_file', 'search_content', 'list_dir', 'run_src', 'run_command', TASK_COMPLETE,
];

/**
 * Creates the tool executor with the built-in tools, refusing the ones `gate` excludes.
 *
 * @param gate level and endpoint list from `gate.md`; a missing gate means `read`,
 *   which denies every writing tool
 */
export function createDefaultExecutor(gate?: GateConfig): ToolExecutor {
  const allowed = gateTools(gate?.level ?? 'read');
  const ex = new ToolExecutor();
  ex.setDeny(BUILTIN_TOOL_NAMES.filter(n => !allowed.has(n)));
  ex.register('read_file', readFile);
  ex.register('write_file', writeFile);
  ex.register('search_content', searchContent);
  ex.register('list_dir', listDir);
  ex.register('run_src', runSrc);
  ex.register('run_command', (args) => runCommand(args, gate?.endpoints ?? []));
  ex.register(TASK_COMPLETE, taskComplete);
  return ex;
}

// ─── Message Validation ────────────────────────────────────────────────────

/**
 * Validates that every tool message has a preceding assistant message
 * with a matching tool_call id. Strips orphaned tool_calls from assistant
 * messages that lack corresponding tool results.
 *
 * Mirrors VS Code's validateToolMessagesCore (~L1830 in toolCallingLoop.ts).
 */
export function validateToolMessages(
  messages: ChatMessage[],
  opts?: { stripOrphanedToolCalls?: boolean },
): ChatMessage[] {
  let prevAssistant: AssistantMessage | undefined;
  const filtered = messages.filter(m => {
    if (m.role === 'assistant') {
      prevAssistant = m as AssistantMessage;
    } else if (m.role === 'tool') {
      if (!prevAssistant?.tool_calls?.length) return false;
      const match = prevAssistant.tool_calls.some(tc => tc.id === m.tool_call_id);
      if (!match) return false;
    }
    return true;
  });

  if (!opts?.stripOrphanedToolCalls) return filtered;

  for (let i = 0; i < filtered.length; i++) {
    const m = filtered[i];
    if (m.role !== 'assistant' || !(m as AssistantMessage).tool_calls?.length) continue;

    // Collect tool result IDs that follow this assistant message
    const resultIds = new Set<string>();
    for (let j = i + 1; j < filtered.length; j++) {
      const next = filtered[j];
      if (next.role === 'assistant') break;
      if (next.role === 'tool') resultIds.add(next.tool_call_id);
    }

    const tc = (m as AssistantMessage).tool_calls!;
    const valid = tc.filter(t => resultIds.has(t.id));
    (m as AssistantMessage).tool_calls = valid.length > 0 ? valid : undefined;
  }

  return filtered;
}

// ─── Prompt Builder ────────────────────────────────────────────────────────

export interface BuildPromptOptions {
  systemPrompt: string;
  session: AgentSession;
  tools: ToolDef[];
}

/**
 * Assembles the ChatMessage array for the next API call by traversing the tree
 * from a specific node back to the root.
 */
export async function buildPromptFromNode(
  nodeId: string,
  session: BranchingSession,
  store: IRecrStore,
  systemPrompt: string,
  tools: ToolDef[]
): Promise<ChatMessage[]> {
  const chain: TurnNode[] = [];
  let currentId: string | null = nodeId;

  while (currentId) {
    const raw = await store.get(`${SESSION_PREFIX}${session.id}/node/${currentId}`);
    if (!raw) break;
    const node = JSON.parse(raw) as TurnNode;
    chain.unshift(node);
    currentId = node.parentId;
  }

  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  for (const node of chain) {
    messages.push(node.userMessage);
    if (node.assistantResponse) {
      messages.push(node.assistantResponse);
    }
    if (node.toolResults.length > 0) {
      messages.push(...node.toolResults);
    }
  }

  return validateToolMessages(messages, { stripOrphanedToolCalls: true });
}

export function buildPrompt(opts: BuildPromptOptions): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // System prompt
  if (opts.systemPrompt) {
    messages.push({ role: 'system', content: opts.systemPrompt });
  }

  // Conversation history
  for (const m of opts.session.messages) {
    messages.push({ ...m });
  }

  // If the last message is an assistant message with tool_calls,
  // and tool results have not yet been appended, the caller must do that.
  // (This function assembles existing state; the loop appends tool results
  // after execution and before the next buildPrompt call.)

  return validateToolMessages(messages, { stripOrphanedToolCalls: true });
}

// ─── LLM Fetch (OpenAI-compatible, SSE streaming) ──────────────────────────

export interface FetchLLMOptions {
  messages: ChatMessage[];
  tools: ToolDef[];
  config: SecretsConfig;
  settings: RuntimeSettings;
  /** Called per SSE delta chunk, like VS Code's finishedCb.
   *  Accumulates tool_calls incrementally. */
  onChunk?: (delta: { text?: string; toolCalls?: ToolCall[] }) => void;
  abortSignal?: AbortSignal;
}

/**
 * A provider answered a request with a non-OK status. Carries the key that was
 * sent and the provider's key aliases, so a caller can offer the next one; a
 * request that never reached the provider stays a plain `Error`, because a
 * different key cannot fix an unreachable host.
 */
export class LlmHttpError extends Error {
  constructor(
    /** HTTP status the provider answered with. */
    readonly status: number,
    message: string,
    /** Provider heading the request went to. */
    readonly providerName?: string,
    /** `API Keys` alias whose value was sent. */
    readonly keyAlias?: string,
    /** Every alias listed under that provider, in document order. */
    readonly keyAliases?: string[],
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

/** Path of the deployed Supabase function that fronts `ollama.com` (slug `v1a`). */
const OLLAMA_PROXY_PATH = '/functions/v1/v1a';

/**
 * The Supabase proxy URL that answers `base`, or undefined when the provider is
 * reached directly.
 *
 * Only `ollama.com` routes here: it answers `OPTIONS` with 405 and carries no
 * CORS header, so a page cannot call it at all. The function pins the upstream
 * host and accepts only `/v1/chat/completions`, so the page-side path is rebuilt
 * from the provider root and a trailing `/v1` on the configured base is dropped.
 *
 * @param base provider root, already trimmed of trailing slashes
 * @returns absolute function URL, or undefined for every other provider
 */
function ollamaProxyTarget(base: string): string | undefined {
  // A relative base such as `/llm` is already same-origin via the dev-server proxy.
  if (!/^https?:\/\//i.test(base) || new URL(base).hostname !== 'ollama.com') return undefined;
  const origin = String(treeCac['server']).replace(/\/+$/, '');
  return `${origin}${OLLAMA_PROXY_PATH}/v1/chat/completions`;
}

/**
 * Access token of the signed-in Supabase session, which the Ollama proxy
 * function verifies before it forwards a request.
 *
 * @returns the bearer token for `Authorization`
 * @throws when no session is stored or the token could not be refreshed
 */
async function supabaseAccessToken(): Promise<string> {
  // Imported here rather than at module scope: only an `ollama.com` request needs
  // the Supabase client, and `greet.ts` creates one as a module side effect.
  const { sbg } = await import('./greet');
  const { data, error } = await sbg.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new Error('The ollama.com proxy requires a Supabase session'
      + `: ${error?.message ?? 'not signed in'}`);
  }
  return token;
}

/**
 * Fetches from an OpenAI-compatible `/v1/chat/completions` endpoint.
 * Supports SSE streaming; accumulates both text and tool_calls incrementally.
 * Returns the final aggregated result.
 *
 * `config.apiBaseUrl` is the provider root without `/v1` (a trailing slash is
 * trimmed). It may be a relative path such as `/llm`, which resolves against the
 * page origin — that is how the dev-server proxy in `vite.config.ts` keeps the
 * call same-origin and avoids the CORS preflight the provider would refuse.
 *
 * An `ollama.com` base goes to the Supabase function instead; it takes the
 * request path rather than a target URL, and reads the Ollama key from
 * `x-ollama-auth` rather than `Authorization`
 * ([topology](docs/recr-agloop.md#5-reaching-a-provider-cors-decides-the-topology)).
 */
export async function fetchLLM(opts: FetchLLMOptions): Promise<FetchResult> {
  const { messages, tools, config, settings, onChunk, abortSignal } = opts;

  const base = config.apiBaseUrl.replace(/\/+$/, '');
  const ollamaProxy = ollamaProxyTarget(base);
  const url = ollamaProxy ?? `${base}/v1/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
    ...(config.headers ?? {}),
    ...(settings.extraHeaders ?? {}),
  };

  if (ollamaProxy) {
    headers['Authorization'] = `Bearer ${await supabaseAccessToken()}`;
    headers['apikey'] = String(treeCac['pub_key']);
    headers['x-ollama-auth'] = config.apiKey;
  }

  console.debug(`[recr] key used: ${config.apiKey.slice(0, 11)}... (model=${config.model}, url=${url})`);

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    tools: tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
    tool_choice: 'auto',
    stream: true,
    // include_usage makes the final chunk carry token counts, which arrive
    // without a `choices` entry
    stream_options: { include_usage: true },
  };

  if (settings.temperature !== undefined) body.temperature = settings.temperature;
  if (settings.maxTokens !== undefined) body.max_tokens = settings.maxTokens;
  // DeepSeek: reasoning_effort
  if (settings.thinkLevel) {
    (body as Record<string, unknown>)['reasoning_effort'] = settings.thinkLevel;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: abortSignal,
  }).catch((e: unknown) => {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    // A CORS refusal and an unreachable host are indistinguishable from the page:
    // both surface as an opaque TypeError, so name the likely cause.
    throw new Error(`Cannot reach ${url}: ${e instanceof Error ? e.message : String(e)}`
      + (ollamaProxy
        ? ' — the Ollama proxy function needs a Supabase session, its ALLOWED_ORIGIN'
          + ' must cover this origin, and the request path must be /v1/chat/completions'
        : ' — the provider may refuse browser origins; route it through a proxy'
          + ' (see the /llm entry in vite.config.ts).'));
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new LlmHttpError(res.status, `LLM API error ${res.status}: ${errText.slice(0, 500)}`
      , config.providerName, config.keyAlias, config.keyAliases);
  }

  // Parse SSE stream
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let fullText = '';
  const toolCalls: ToolCall[] = [];
  // Accumulate tool_calls by index (streaming deltas may be partial)
  const tcAccum: Map<number, ToolCall> = new Map();
  let finishReason = 'stop';
  let usage: FetchResult['usage'];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const json = JSON.parse(data);
        // the usage chunk carries no choices, so read it before skipping
        if (json.usage) {
          usage = {
            prompt_tokens: json.usage.prompt_tokens,
            completion_tokens: json.usage.completion_tokens,
          };
        }
        const choice = json.choices?.[0];
        if (!choice) continue;

        finishReason = choice.finish_reason || finishReason;

        const delta = choice.delta;
        if (!delta) continue;

        // Text delta
        if (delta.content) {
          fullText += delta.content;
          onChunk?.({ text: delta.content });
        }

        // Tool call delta (incremental)
        if (delta.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            const idx = tcDelta.index;
            let tc = tcAccum.get(idx);
            if (!tc) {
              tc = { id: tcDelta.id || '', type: 'function', function: { name: '', arguments: '' } };
              tcAccum.set(idx, tc);
            }
            if (tcDelta.id) tc.id = tcDelta.id;
            if (tcDelta.function?.name) tc.function.name += tcDelta.function.name;
            if (tcDelta.function?.arguments) tc.function.arguments += tcDelta.function.arguments;
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }

  // Finalize accumulated tool calls
  for (const tc of tcAccum.values()) {
    toolCalls.push(tc);
  }
  if (toolCalls.length > 0 && onChunk) {
    onChunk({ toolCalls });
  }

  return {
    text: fullText,
    toolCalls,
    finishReason,
    usage,
  };
}

// ─── Agentic Loop (while(true) — mirrors VS Code _runLoop) ─────────────────

export interface RunLoopOptions {
  session: BranchingSession;
  nodeId: string;
  /** Node this turn attaches under, for a fork; `null` starts a new root. Omitted follows
   *  `session.currentHeadId`. */
  parentNodeId?: string | null;
  /** The user turn this loop answers; recorded on the node before the first request. */
  prompt: string;
  systemPrompt: string;
  tools: ToolDef[];
  config: SecretsConfig;
  settings: RuntimeSettings;
  executor: ToolExecutor;
  store: IRecrStore;
  /** Optional per-iteration progress callback */
  onProgress?: (text: string) => void;
  /**
   * Asked when the provider answers a request with a non-OK status, so the caller
   * can offer another listed key. Returning secrets retries the same iteration
   * with them; returning undefined lets the error propagate.
   *
   * @param error the status the provider answered with, and the key it was sent
   * @returns secrets to retry with, or undefined to rethrow
   */
  onHttpError?: (error: LlmHttpError) => Promise<SecretsConfig | undefined>;
  abortSignal?: AbortSignal;
  /** Plugin context for hook dispatch */
  pluginCtx: RecrContext;
  /** Request state for hook dispatch */
  pluginReq: RequestState;
}

export interface RunLoopResult {
  session: BranchingSession;
  finalNode: TurnNode;
  toolCallRounds: ToolCallRound[];
}

/**
 * The core tool-calling loop, now branch-aware.
 *
 * Instead of building a linear prompt, it uses buildPromptFromNode to follow the
 * current branch back to the root. The node is written before the first request
 * and again after every round, because buildPromptFromNode reads the branch from
 * the store: without those writes the model would see neither the user turn nor
 * the tool results it just asked for.
 */
export async function runLoop(opts: RunLoopOptions): Promise<RunLoopResult> {
  const { session, nodeId, parentNodeId, prompt, systemPrompt, tools, config, settings, executor, store,
    onProgress, abortSignal, pluginCtx, pluginReq } = opts;
  let iter = 0;
  /** Config in use; a key fallback swaps in the secrets re-resolved after the swap. */
  let cfg = config;

  /**
   * One request, retried with another listed key while the caller keeps offering
   * one. A network failure never reaches `onHttpError`: it says nothing about the
   * key, so it propagates as the plain error it already is.
   */
  const request = async (msgs: ChatMessage[], onChunk: FetchLLMOptions['onChunk']): Promise<FetchResult> => {
    let swaps = 0;
    for (;;) {
      try {
        return await fetchLLM({ messages: msgs, tools, config: cfg, settings, abortSignal, onChunk });
      } catch (e) {
        const aliases = e instanceof LlmHttpError ? e.keyAliases ?? [] : [];
        if (!opts.onHttpError || !(e instanceof LlmHttpError) || swaps >= aliases.length - 1) throw e;
        const next = await opts.onHttpError(e);
        if (!next) throw e;
        cfg = next;
        swaps++;
      }
    }
  };

  // Initialize the TurnNode for this specific turn
  const currentTurn: TurnNode = {
    id: nodeId,
    // `null` is a deliberate new root; only an omitted value follows the head
    parentId: parentNodeId !== undefined ? parentNodeId : session.currentHeadId,
    version: 1,
    timestamp: Date.now(),
    userMessage: { role: 'user', content: prompt },
    assistantResponse: null,
    toolResults: [],
    metadata: {},
  };
  await saveTurnNode(store, session, currentTurn);

  while (true) {
    if (abortSignal?.aborted) break;
    if (iter >= settings.maxIterations) break;
    if (currentTurn.toolResults.length >= settings.maxToolCalls) break;

    iter++;

    // Build the prompt from the specific node in the graph
    const messages = await buildPromptFromNode(currentTurn.id, session, store, systemPrompt, tools);

    // ── Plugin hook: iteration start ──
    await recrHost.iterationStart(pluginCtx, iter, messages);

    // Fetch from LLM with incremental tool call accumulation
    let accToolCalls: ToolCall[] = [];
    let firstProgressEmitted = false;

    const result = await request(messages, (delta) => {
      if (delta.text) {
        if (!firstProgressEmitted) {
          firstProgressEmitted = true;
          pluginReq.timings.firstProgress = Date.now() - pluginReq.timings.startedAt;
        }
        onProgress?.(delta.text);
        // ── Plugin hook: stream chunk ──
        recrHost.streamChunk(pluginCtx, delta.text, iter);
        // ── Plugin hook: progress ──
        recrHost.progress(pluginCtx, delta.text, iter);
      }
      if (delta.toolCalls) {
        accToolCalls = delta.toolCalls;
        for (const tc of delta.toolCalls) {
          recrBus.send({
            kind: 'recr-tool-call',
            sessionId: session.id,
            toolName: tc.function.name,
            args: tc.function.arguments,
          });
        }
      }
    });

    // Record assistant response
    currentTurn.assistantResponse = {
      role: 'assistant',
      content: result.text || null,
      tool_calls: accToolCalls.length > 0 ? accToolCalls : undefined,
    };

    // Track token usage
    if (result.usage) {
      pluginReq.tokenUsage = {
        promptTokens: result.usage.prompt_tokens,
        completionTokens: result.usage.completion_tokens,
        details: [],
        outputBuffer: 8192,
      };
    }

    // ── Plugin hook: iteration end ──
    await recrHost.iterationEnd(pluginCtx, iter, result);

    const wantsTools = accToolCalls.length > 0;
    const done = accToolCalls.some(tc => tc.function.name === TASK_COMPLETE);

    // Execute tools with plugin hooks
    if (wantsTools && !done) for (const call of accToolCalls) {
      const toolStart = Date.now();

      // ── Plugin hook: tool call start ──
      const customMeta = await recrHost.toolCallStart(pluginCtx, call, iter);

      const impl = executor.getImpl(call.function.name);
      let content: string;
      let toolError: string | undefined;
      try {
        const refusal = executor.denial(call.function.name);
        if (refusal) {
          content = refusal;
          toolError = refusal;
        } else if (!impl) {
          content = `Error: unknown tool "${call.function.name}"`;
          toolError = `unknown tool: ${call.function.name}`;
        } else {
          const args = JSON.parse(call.function.arguments || '{}');
          content = await impl(args, store);
        }
      } catch (e) {
        content = `Error executing ${call.function.name}: ${e instanceof Error ? e.message : String(e)}`;
        toolError = e instanceof Error ? e.message : String(e);
      }
      const duration = Date.now() - toolStart;

      const tm: ToolMessage = {
        role: 'tool',
        tool_call_id: call.id,
        content,
      };
      currentTurn.toolResults.push(tm);

      const meta: ToolInvocationMeta = customMeta ?? defaultToolMeta(call, duration, toolError);
      meta.isComplete = !toolError;
      meta.duration = duration;

      recrBus.send({
        kind: 'recr-tool-result',
        sessionId: session.id,
        toolName: call.function.name,
        result: tm.content.slice(0, 200),
      });

      // ── Plugin hook: tool call end ──
      await recrHost.toolCallEnd(pluginCtx, call, tm, meta);
    }

    // Persist before the next iteration: buildPromptFromNode replays this round from the store.
    await saveTurnNode(store, session, currentTurn);

    if (!wantsTools || done) break;
  }

  // Finalize timings
  pluginReq.timings.totalElapsed = Date.now() - pluginReq.timings.startedAt;
  pluginReq.timings.completedAt = Date.now();

  return { session, finalNode: currentTurn, toolCallRounds: [] };
}

// ─── Main Entry Point ──────────────────────────────────────────────────────

export interface RcrOptions {
  /** User prompt */
  prompt: string;
  /** Optional session ID to resume; creates new if omitted */
  sessionId?: string;
  /** Provider and model this chat is pinned to; recorded on the session meta. */
  pin?: ChatPin;
  /** Node this turn attaches under, for a fork; `null` starts a new root. Defaults to the
   *  session head. */
  parentNodeId?: string | null;
  /** Override store; uses default DexieTagStore if omitted */
  store?: IRecrStore;
  /** Override tool executor; uses default tools if omitted */
  executor?: ToolExecutor;
  /** Override secrets; reads from store if omitted */
  config?: SecretsConfig;
  /** Override settings; reads from store if omitted */
  settings?: RuntimeSettings;
  /** System prompt */
  systemPrompt?: string;
  onProgress?: (text: string) => void;
  /**
   * Asked when the provider answers with a non-OK status, to offer another listed
   * key. The same turn continues with the returned secrets.
   *
   * @param error the status the provider answered with, and the key it was sent
   * @returns secrets to retry with, or undefined to fail the turn
   */
  onHttpError?: (error: LlmHttpError) => Promise<SecretsConfig | undefined>;
  abortSignal?: AbortSignal;

  // ── Plugin metadata (populated by UI/caller) ──────────────────────

  /** Agent descriptor — mirrors JSONL request.agent */
  agent?: AgentMetadata;
  /** Model identity — mirrors JSONL selectedModel */
  model?: ModelIdentity;
  /** Model runtime configuration */
  modelConfig?: ModelConfiguration;
  /** Agent mode info */
  mode?: ModeInfo;
  /** Attached files/context at request time */
  attachments?: AttachmentRef[];
  /** Editor selections at request time */
  selections?: RequestInputState['selections'];
  /** Permission level for this request */
  permissionLevel?: string;
}

/**
 * Main entry point: end-to-end agentic loop.
 *
 * Usage:
 *   const result = await rcr({
 *     prompt: 'Read the file at src/main.ts and fix the bug',
 *     sessionId: 'my-session',
 *     onProgress: (text) => console.log(text),
 *   });
 */
export async function rcr(opts: RcrOptions): Promise<RunLoopResult> {
  const store = opts.store ?? getStore();

  // Load or create the session before resolving the model: a pinned chat names its own
  // provider and model, and a caller may pin a chat it is about to start.
  const isNew = !opts.sessionId;
  const session = opts.sessionId
    ? await loadBranchingSession(store, opts.sessionId)
    : createBranchingSession(undefined, 'New Session', opts.pin);
  if (opts.pin) {
    session.provider = opts.pin.provider;
    session.model = opts.pin.model;
    session.source = opts.pin.source ?? session.source;
  }

  // Parse configs from store if not provided
  const config = opts.config ?? await parseSecrets(store, sessionModelOverride(session));
  const settings = opts.settings ?? await parseSettings(store);

  // The gate decides which tools reach the model and which the executor refuses
  const gate = await loadGate();

  // Load tool definitions
  const toolDefs = await parseTools(store);

  // Override with built-in tools if none defined
  const effectiveTools = filterTools(toolDefs.length > 0 ? toolDefs : getDefaultToolDefs(), gate.level);

  // Generate request identity
  const nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestId = `request_${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`;

  // Create executor
  const executor = opts.executor ?? createDefaultExecutor(gate);

  // Default system prompt
  const systemPrompt = opts.systemPrompt ?? getDefaultSystemPrompt(effectiveTools);

  // ── Build plugin context and request state ──────────────────────────

  const agent: AgentMetadata = opts.agent ?? {
    extensionId: 'local.recr',
    extensionVersion: '0.1.0',
    publisherDisplayName: 'recr',
    extensionDisplayName: 'recr Agent',
    id: 'recr.agent',
    name: 'recr',
    fullName: 'recr Agent',
    isDefault: true,
    locations: ['panel'],
    modes: ['agent'],
    capabilities: { toolCalling: true, agentMode: true },
  };

  const model: ModelIdentity = opts.model ?? {
    identifier: config.model,
    vendor: 'custom',
    name: config.model,
    family: 'custom',
    version: '1',
    maxInputTokens: 262144,
    maxOutputTokens: 2048,
    capabilities: { toolCalling: true, agentMode: true },
  };

  const modelConfig: ModelConfiguration = opts.modelConfig ?? {
    reasoningEffort: settings.thinkLevel as ModelConfiguration['reasoningEffort'],
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
  };

  const mode: ModeInfo = opts.mode ?? {
    kind: 'agent',
    isBuiltin: true,
    telemetryModeId: 'agent',
    telemetryModeName: 'agent',
  };

  const pluginCtx = buildContext(
    session, store, recrBus, config, settings, effectiveTools,
    requestId, agent, model,
  );

  const req = buildRequestState(
    requestId, agent, model, modelConfig, mode,
    opts.prompt,
    opts.selections ?? [],
    opts.attachments ?? [],
    opts.permissionLevel ?? 'default',
  );

  // ── Plugin hook: session lifecycle ──────────────────────────────────

  if (isNew) {
    await recrHost.sessionCreate(pluginCtx);
  } else {
    await recrHost.sessionLoad(pluginCtx);
  }

  // ── Plugin hook: request start ─────────────────────────────────────

  await recrHost.requestStart(pluginCtx, req);

  try {
    // Run the loop with the branch-aware logic
    const result = await runLoop({
      session,
      nodeId,
      parentNodeId: opts.parentNodeId,
      prompt: opts.prompt,
      systemPrompt,
      tools: effectiveTools,
      config,
      settings,
      executor,
      store,
      onProgress: opts.onProgress,
      onHttpError: opts.onHttpError,
      abortSignal: opts.abortSignal,
      pluginCtx,
      pluginReq: req,
    });

    recrBus.send({
      kind: 'recr-done',
      sessionId: result.session.id,
      finalText: result.finalNode.assistantResponse?.content ?? 'No response.',
    });

    // ── Plugin hook: request end ─────────────────────────────────────

    await recrHost.requestEnd(pluginCtx, req, result);

    return result;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    recrBus.send({ kind: 'recr-error', sessionId: session.id, error: err.message });
    await recrHost.requestError(pluginCtx, req, err);
    throw e;
  }
}

// ─── Defaults ──────────────────────────────────────────────────────────────

function getDefaultSystemPrompt(tools: ToolDef[]): string {
  const toolList = tools.map(t => `- ${t.name}: ${t.description}`).join('\n');
  return `You are an AI coding agent working on a store of tagged documents.
File refs are paths such as "src/main.ts" or "readme.md"; a ref's extension decides
whether it is a source row or a markdown row. Do not invent refs: use list_dir and
search_content to find them.

Available tools:
${toolList}

When you need to accomplish a task, use the appropriate tools. After each tool call,
you will receive the result. You can make multiple tool calls in sequence.

When you're done, call the ${TASK_COMPLETE} tool and provide a brief summary in text.

Be concise and direct. Do not repeat yourself.`;
}

function getDefaultToolDefs(): ToolDef[] {
  return [
    {
      name: 'read_file',
      description: 'Reads the file at filePath. Use startLine/endLine for a line range, or limit for a character cap.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Ref of the file' },
          startLine: { type: 'number', description: 'Optional: 1-based start line' },
          endLine: { type: 'number', description: 'Optional: inclusive end line' },
          limit: { type: 'number', description: 'Optional: max characters to read' },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'write_file',
      description: 'Writes content to the file at filePath, creating it when absent.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Ref of the file' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['filePath', 'content'],
      },
    },
    {
      name: 'search_content',
      description: 'Searches file contents for a query string, one result line per match.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          directory: { type: 'string', description: 'Optional: directory prefix to scope search' },
        },
        required: ['query'],
      },
    },
    {
      name: 'list_dir',
      description: 'Lists one level of file refs below path, directories marked with a trailing slash.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory prefix; empty lists the root' },
        },
        required: ['path'],
      },
    },
    {
      name: 'run_src',
      description: 'Runs a source row (type=src) in the page, awaiting its result. A function body receives one ctx argument: { db, ref, args, console }. A body that opens a line with import/export runs as an ES module instead and must export a default function(ctx).',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Ref of the script row to run' },
          args: { type: 'object', description: 'Optional: value passed as ctx.args' },
        },
        required: ['ref'],
      },
    },
    {
      name: 'run_command',
      description: 'Calls a REST endpoint listed under Endpoints in gate.md. Any other endpoint is refused.',
      parameters: {
        type: 'object',
        properties: {
          endpoint: { type: 'string', description: 'Full URL to call' },
          method: { type: 'string', description: 'HTTP method (GET, POST, etc.)' },
          body: { type: 'object', description: 'JSON body for POST requests' },
          headers: { type: 'object', description: 'Additional HTTP headers' },
        },
        required: ['endpoint'],
      },
    },
    {
      name: 'task_complete',
      description: 'Marks the current task as complete. Call this when you are done.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Brief summary of what was accomplished' },
        },
      },
    },
  ];
}

// ─── Streaming helper (for callers that want a readable stream of progress) ─

/**
 * Creates an async iterable that yields progress deltas from the agentic loop.
 * Use this for streaming UIs.
 */
export async function* rcrStream(opts: RcrOptions): AsyncGenerator<string, RunLoopResult, void> {
  let lastText = '';
  const result = await rcr({
    ...opts,
    onProgress: (text) => {
      lastText = text;
    },
  });

  // Yield accumulated text in chunks (simplified — real impl would use controller)
  if (lastText) yield lastText;
  return result;
}
