/**
 * recr-plugin.ts — Pluggable Hook System for recr Agentic Loop
 *
 * Provides a RecrPlugin interface and RecrPluginHost that modules can implement
 * to intercept the agentic loop at every lifecycle point. Modules include:
 *   - DexiePersistPlugin: persist session/request/turn data to Dexie for sync engine
 *   - WebhookPlugin: forward events to Discord/Telegram/Slack for remote access
 *   - MobilePushPlugin: push notifications for live monitoring/chat
 *
 * Each plugin receives a RecrContext (session, store, bus, config) and can
 * read/write state, emit bus messages, or forward to external services.
 */

import type {
  BranchingSession, TurnNode, ToolCall, ToolMessage,
  ChatMessage, FetchResult, RunLoopResult,
  SecretsConfig, RuntimeSettings, ToolDef,
  IRecrStore, RecrMessageBus,
} from './recr';

// ─── Expanded Types (Phase 1: JSONL alignment) ─────────────────────────────

/** VS Code agent metadata — mirrors JSONL request.agent */
export interface AgentMetadata {
  extensionId: string;
  extensionVersion: string;
  publisherDisplayName: string;
  extensionDisplayName: string;
  id: string;
  name: string;
  fullName: string;
  isDefault: boolean;
  locations: string[];
  modes: string[];
  /** Capabilities derived from model metadata */
  capabilities?: {
    vision?: boolean;
    toolCalling?: boolean;
    agentMode?: boolean;
  };
}

/** Model identity + configuration — mirrors JSONL selectedModel */
export interface ModelIdentity {
  identifier: string;
  vendor: string;
  name: string;
  family: string;
  version: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities?: {
    vision?: boolean;
    toolCalling?: boolean;
    agentMode?: boolean;
  };
}

export interface ModelConfiguration {
  reasoningEffort?: 'none' | 'high' | 'max';
  temperature?: number;
  maxTokens?: number;
}

/** Mode info per request — mirrors JSONL modeInfo */
export interface ModeInfo {
  kind: 'agent' | 'plan' | 'custom';
  isBuiltin: boolean;
  /** URI to custom mode instructions file, if custom */
  modeInstructionsUri?: string;
  telemetryModeId?: string;
  telemetryModeName?: string;
}

/** An attached file or selection reference */
export interface AttachmentRef {
  kind: 'file' | 'selection';
  name: string;
  path: string;
  scheme?: string;
  authority?: string;
}

/** Snapshot of input state at request time */
export interface RequestInputState {
  promptText: string;
  /** truncated preview for storage */
  promptPreview: string;
  selections: { startLine: number; startCol: number; endLine: number; endCol: number }[];
  attachments: AttachmentRef[];
  mode: ModeInfo;
  model: ModelIdentity;
  modelConfig: ModelConfiguration;
  permissionLevel: string;
}

/** Token usage broken down by category — mirrors JSONL promptTokenDetails */
export interface TokenUsageDetail {
  category: string;
  label: string;
  percentageOfPrompt: number;
  tokenCount?: number;
}

export interface RequestTokenUsage {
  promptTokens: number;
  completionTokens: number;
  details: TokenUsageDetail[];
  outputBuffer: number;
}

/** Timing for a single request — mirrors JSONL timings */
export interface RequestTimings {
  startedAt: number;
  firstProgress?: number;
  totalElapsed?: number;
  completedAt?: number;
}

/** Full request state — mirrors JSONL requests[] entry */
export interface RequestState {
  requestId: string;
  responseId?: string;
  timestamp: number;
  agent: AgentMetadata;
  model: ModelIdentity;
  modelConfig: ModelConfiguration;
  mode: ModeInfo;
  inputState: RequestInputState;
  tokenUsage?: RequestTokenUsage;
  timings: RequestTimings;
  contentReferences: { path: string; scheme?: string; authority?: string }[];
  permissionLevel: string;
}

/** Tool invocation with full metadata — mirrors JSONL toolInvocationSerialized */
export interface ToolInvocationMeta {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Human-readable invocation message */
  invocationMessage: string;
  /** Past-tense completion message */
  pastTenseMessage?: string;
  /** Whether user confirmed */
  isConfirmed: boolean;
  /** Whether execution completed */
  isComplete: boolean;
  source: { type: string; label: string };
  duration?: number;
  /** Number of retries if tool failed */
  retryCount: number;
  error?: string;
}

// ─── RecrContext — passed to every plugin hook ──────────────────────────────

export interface RecrContext {
  sessionId: string;
  session: BranchingSession;
  store: IRecrStore;
  bus: RecrMessageBus;
  config: SecretsConfig;
  settings: RuntimeSettings;
  tools: ToolDef[];
  requestId: string;
  /** Current agent metadata; plugins can read for routing */
  agent: AgentMetadata;
  /** Current model identity */
  model: ModelIdentity;
}

// ─── RecrPlugin Interface ──────────────────────────────────────────────────

/**
 * A plugin that hooks into the recr agentic loop lifecycle.
 *
 * All hooks are optional — implement only what you need.
 * Hooks are called in registration order. If a hook throws, the error is
 * caught and logged but does not abort the loop.
 *
 * Plugins receive a RecrContext with full access to session state, storage,
 * message bus, and configuration. They can read/write state or forward events
 * to external services.
 */
export interface RecrPlugin {
  /** Unique plugin name for logging / registration */
  name: string;

  // ── Session lifecycle ──────────────────────────────────────────────

  /** Called when a new BranchingSession is created */
  onSessionCreate?: (ctx: RecrContext) => Promise<void>;

  /** Called when an existing BranchingSession is loaded */
  onSessionLoad?: (ctx: RecrContext) => Promise<void>;

  // ── Request lifecycle ──────────────────────────────────────────────

  /** Called before the loop starts. Use for persistence setup, webhook "started" notifications. */
  onRequestStart?: (ctx: RecrContext, req: RequestState) => Promise<void>;

  /** Called after the loop completes (success). */
  onRequestEnd?: (ctx: RecrContext, req: RequestState, result: RunLoopResult) => Promise<void>;

  /** Called when the loop encounters an unrecoverable error. */
  onRequestError?: (ctx: RecrContext, req: RequestState, error: Error) => Promise<void>;

  // ── Loop iteration ─────────────────────────────────────────────────

  /** Called at the start of each while(true) iteration */
  onIterationStart?: (ctx: RecrContext, iteration: number, messages: ChatMessage[]) => Promise<void>;

  /** Called at the end of each iteration (after tools executed or text returned) */
  onIterationEnd?: (ctx: RecrContext, iteration: number, fetchResult: FetchResult) => Promise<void>;

  // ── Tool invocation ────────────────────────────────────────────────

  /**
   * Called before a tool is executed.
   * Return a ToolInvocationMeta to override the auto-generated metadata;
   * return void to use defaults.
   */
  onToolCallStart?: (ctx: RecrContext, call: ToolCall, iteration: number) => Promise<ToolInvocationMeta | void>;

  /**
   * Called after a tool completes (success or error).
   * The result is the ToolMessage content; meta includes timing/retries.
   */
  onToolCallEnd?: (ctx: RecrContext, call: ToolCall, result: ToolMessage, meta: ToolInvocationMeta) => Promise<void>;

  // ── Streaming ──────────────────────────────────────────────────────

  /** Called for each SSE text delta chunk */
  onStreamChunk?: (ctx: RecrContext, delta: string, iteration: number) => Promise<void>;

  // ── Progress ───────────────────────────────────────────────────────

  /** Called for progress updates (text accumulation, milestone markers) */
  onProgress?: (ctx: RecrContext, text: string, iteration: number) => Promise<void>;

  // ── Forking ────────────────────────────────────────────────────────

  /** Called when a session is forked at a specific node */
  onFork?: (ctx: RecrContext, nodeId: string, parentId: string | null) => Promise<void>;
}

// ─── RecrPluginHost ────────────────────────────────────────────────────────

const PLUGIN_HOOK_TIMEOUT_MS = 5000;

/**
 * Manages plugin registration and dispatches lifecycle hooks.
 * Plugins are called in registration order. Hook errors are caught and logged.
 */
export class RecrPluginHost {
  private plugins: RecrPlugin[] = [];

  register(plugin: RecrPlugin): void {
    // Prevent duplicate names
    if (this.plugins.some(p => p.name === plugin.name)) {
      console.warn(`[recr-plugins] Duplicate plugin name "${plugin.name}" — skipping`);
      return;
    }
    this.plugins.push(plugin);
  }

  unregister(name: string): void {
    this.plugins = this.plugins.filter(p => p.name !== name);
  }

  list(): string[] {
    return this.plugins.map(p => p.name);
  }

  /** Fire a hook on all plugins, returning void. Errors are caught. */
  private async fire<K extends keyof RecrPlugin>(
    hook: K,
    ctx: RecrContext,
    ...args: unknown[]
  ): Promise<void> {
    for (const plugin of this.plugins) {
      const fn = plugin[hook] as ((...a: unknown[]) => Promise<void>) | undefined;
      if (!fn) continue;
      try {
        await Promise.race([
          fn.call(plugin, ctx, ...args),
          new Promise<void>((_, rej) =>
            setTimeout(() => rej(new Error(`Plugin "${plugin.name}" hook "${hook}" timed out`)), PLUGIN_HOOK_TIMEOUT_MS)
          ),
        ]);
      } catch (e) {
        console.warn(`[recr-plugins] Plugin "${plugin.name}" hook "${hook}" error:`, e);
      }
    }
  }

  /** Fire and collect results from all plugins. First non-void result wins. */
  private async fireCollect<K extends keyof RecrPlugin, R>(
    hook: K,
    ctx: RecrContext,
    ...args: unknown[]
  ): Promise<R | void> {
    for (const plugin of this.plugins) {
      const fn = plugin[hook] as ((...a: unknown[]) => Promise<R | void>) | undefined;
      if (!fn) continue;
      try {
        const result = await Promise.race([
          fn.call(plugin, ctx, ...args),
          new Promise<undefined>((_, rej) =>
            setTimeout(() => rej(new Error(`Plugin "${plugin.name}" hook "${hook}" timed out`)), PLUGIN_HOOK_TIMEOUT_MS)
          ),
        ]);
        if (result !== undefined && result !== null) return result;
      } catch (e) {
        console.warn(`[recr-plugins] Plugin "${plugin.name}" hook "${hook}" error:`, e);
      }
    }
  }

  // ── Public dispatch methods (called by recr.ts) ─────────────────────

  async sessionCreate(ctx: RecrContext): Promise<void> {
    await this.fire('onSessionCreate', ctx);
  }

  async sessionLoad(ctx: RecrContext): Promise<void> {
    await this.fire('onSessionLoad', ctx);
  }

  async requestStart(ctx: RecrContext, req: RequestState): Promise<void> {
    await this.fire('onRequestStart', ctx, req);
  }

  async requestEnd(ctx: RecrContext, req: RequestState, result: RunLoopResult): Promise<void> {
    await this.fire('onRequestEnd', ctx, req, result);
  }

  async requestError(ctx: RecrContext, req: RequestState, error: Error): Promise<void> {
    await this.fire('onRequestError', ctx, req, error);
  }

  async iterationStart(ctx: RecrContext, iteration: number, messages: ChatMessage[]): Promise<void> {
    await this.fire('onIterationStart', ctx, iteration, messages);
  }

  async iterationEnd(ctx: RecrContext, iteration: number, fetchResult: FetchResult): Promise<void> {
    await this.fire('onIterationEnd', ctx, iteration, fetchResult);
  }

  async toolCallStart(ctx: RecrContext, call: ToolCall, iteration: number): Promise<ToolInvocationMeta | void> {
    return this.fireCollect<'onToolCallStart', ToolInvocationMeta>('onToolCallStart', ctx, call, iteration);
  }

  async toolCallEnd(ctx: RecrContext, call: ToolCall, result: ToolMessage, meta: ToolInvocationMeta): Promise<void> {
    await this.fire('onToolCallEnd', ctx, call, result, meta);
  }

  async streamChunk(ctx: RecrContext, delta: string, iteration: number): Promise<void> {
    await this.fire('onStreamChunk', ctx, delta, iteration);
  }

  async progress(ctx: RecrContext, text: string, iteration: number): Promise<void> {
    await this.fire('onProgress', ctx, text, iteration);
  }

  async fork(ctx: RecrContext, nodeId: string, parentId: string | null): Promise<void> {
    await this.fire('onFork', ctx, nodeId, parentId);
  }
}

/** Singleton host — modules call host.register(myPlugin) to participate */
export const recrHost = new RecrPluginHost();

// ─── Helper: build RecrContext from rcr() options ──────────────────────────

export function buildContext(
  session: BranchingSession,
  store: IRecrStore,
  bus: RecrMessageBus,
  config: SecretsConfig,
  settings: RuntimeSettings,
  tools: ToolDef[],
  requestId: string,
  agent: AgentMetadata,
  model: ModelIdentity,
): RecrContext {
  return {
    sessionId: session.id,
    session,
    store,
    bus,
    config,
    settings,
    tools,
    requestId,
    agent,
    model,
  };
}

// ─── Helper: build RequestState from rcr() options ─────────────────────────

export function buildRequestState(
  requestId: string,
  agent: AgentMetadata,
  model: ModelIdentity,
  modelConfig: ModelConfiguration,
  mode: ModeInfo,
  promptText: string,
  selections: RequestInputState['selections'],
  attachments: AttachmentRef[],
  permissionLevel: string,
): RequestState {
  const now = Date.now();
  return {
    requestId,
    timestamp: now,
    agent,
    model,
    modelConfig,
    mode,
    inputState: {
      promptText,
      promptPreview: promptText.slice(0, 500),
      selections,
      attachments,
      mode,
      model,
      modelConfig,
      permissionLevel,
    },
    timings: { startedAt: now },
    contentReferences: [],
    permissionLevel,
  };
}

// ─── Helper: build ToolInvocationMeta for a tool call ──────────────────────

export function defaultToolMeta(
  call: ToolCall,
  duration?: number,
  error?: string,
): ToolInvocationMeta {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch { /* keep empty */ }

  const summary = Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 40) : JSON.stringify(v).slice(0, 40)}`)
    .join(', ') || '(no args)';

  return {
    toolCallId: call.id,
    toolName: call.function.name,
    args,
    invocationMessage: `${call.function.name}(${summary})`,
    pastTenseMessage: error
      ? `Error: ${call.function.name} — ${error}`
      : `Completed: ${call.function.name}`,
    isConfirmed: true,
    isComplete: !error,
    source: { type: 'internal', label: 'recr' },
    duration,
    retryCount: 0,
    error,
  };
}

// ─── Reference Plugin 1: DexiePersistPlugin ────────────────────────────────

/**
 * Persists every request, turn, tool invocation, and session update to the
 * Dexie tag store for offline access and sync engine integration.
 *
 * Stores data under:
 *   sess/{sessionId}/req/{requestId}  — RequestState JSON
 *   sess/{sessionId}/node/{nodeId}    — TurnNode JSON (already saved by recr.ts)
 *   sess/{sessionId}/tools/{reqId}    — ToolInvocationMeta[] JSON
 */
export function createDexiePersistPlugin(): RecrPlugin {
  return {
    name: 'dexie-persist',

    async onSessionCreate(ctx) {
      await ctx.store.put(
        `sess/${ctx.sessionId}/meta`,
        JSON.stringify({
          ...ctx.session,
          pluginVersion: 1,
          createdAt: ctx.session.createdAt,
        }),
      );
      console.debug(`[dexie-persist] Session ${ctx.sessionId} created`);
    },

    async onSessionLoad(ctx) {
      console.debug(`[dexie-persist] Session ${ctx.sessionId} loaded (head=${ctx.session.currentHeadId})`);
    },

    async onRequestStart(ctx, req) {
      await ctx.store.put(
        `sess/${ctx.sessionId}/req/${req.requestId}`,
        JSON.stringify(req),
      );
      console.debug(`[dexie-persist] Request ${req.requestId} started`);
    },

    async onRequestEnd(ctx, req, result) {
      const finalReq: RequestState = {
        ...req,
        responseId: `response_${req.requestId.slice(8)}`,
        timings: {
          ...req.timings,
          totalElapsed: Date.now() - req.timings.startedAt,
          completedAt: Date.now(),
        },
      };
      await ctx.store.put(
        `sess/${ctx.sessionId}/req/${req.requestId}`,
        JSON.stringify(finalReq),
      );

      // Persist tool invocations for this request
      if (result.finalNode.toolResults.length > 0) {
        await ctx.store.put(
          `sess/${ctx.sessionId}/tools/${req.requestId}`,
          JSON.stringify(result.finalNode.toolResults),
        );
      }

      console.debug(`[dexie-persist] Request ${req.requestId} completed (${finalReq.timings.totalElapsed}ms)`);
    },

    async onRequestError(ctx, req, error) {
      const finalReq: RequestState = {
        ...req,
        timings: {
          ...req.timings,
          totalElapsed: Date.now() - req.timings.startedAt,
          completedAt: Date.now(),
        },
      };
      await ctx.store.put(
        `sess/${ctx.sessionId}/req/${req.requestId}`,
        JSON.stringify({ ...finalReq, error: error.message }),
      );
    },

    async onToolCallEnd(ctx, _call, _result, meta) {
      // Append to tool trace file for this request
      const key = `sess/${ctx.sessionId}/tools/${ctx.requestId}`;
      const existing = await ctx.store.get(key);
      const list: ToolInvocationMeta[] = existing ? JSON.parse(existing) : [];
      list.push(meta);
      await ctx.store.put(key, JSON.stringify(list));
    },

    async onFork(ctx, nodeId, parentId) {
      await ctx.store.put(
        `sess/${ctx.sessionId}/forks`,
        JSON.stringify({ nodeId, parentId, timestamp: Date.now() }),
      );
    },
  };
}

// ─── Reference Plugin 2: WebhookPlugin ─────────────────────────────────────

export interface WebhookTarget {
  /** e.g. 'discord', 'telegram', 'slack', 'custom' */
  type: string;
  /** Webhook URL */
  url: string;
  /** Optional headers (e.g. auth for Slack) */
  headers?: Record<string, string>;
  /** Message format template */
  template?: 'compact' | 'detailed' | 'custom';
  /** Custom formatter: (event, data) => body string */
  format?: (event: string, data: Record<string, unknown>) => string;
}

/**
 * Forwards select lifecycle events to external webhooks (Discord, Telegram,
 * Slack, or custom). Useful for remote monitoring and mobile push via
 * channel-bridge bots.
 *
 * Events forwarded: request_start, request_end, request_error, tool_call
 *
 * Messages are sent fire-and-forget; failures are logged but never block.
 */
export function createWebhookPlugin(targets: WebhookTarget[]): RecrPlugin {
  async function send(target: WebhookTarget, event: string, data: Record<string, unknown>): Promise<void> {
    let body: string;
    if (target.format) {
      body = target.format(event, data);
    } else {
      body = JSON.stringify({ event, ...data, ts: Date.now() });
    }

    try {
      await fetch(target.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(target.headers ?? {}),
        },
        body,
      });
    } catch (e) {
      console.warn(`[webhook-plugin] Failed to send to ${target.type} (${target.url}):`, e);
    }
  }

  return {
    name: 'webhook',

    async onRequestStart(ctx, req) {
      const data = {
        sessionId: ctx.sessionId,
        requestId: req.requestId,
        prompt: req.inputState.promptPreview,
        model: req.model.identifier,
        agent: req.agent.name,
      };
      await Promise.all(targets.map(t => send(t, 'request_start', data)));
    },

    async onRequestEnd(ctx, req, result) {
      const finalText = result.finalNode.assistantResponse?.content?.slice(0, 300) ?? '(no text)';
      const elapsed = Date.now() - req.timings.startedAt;
      const data = {
        sessionId: ctx.sessionId,
        requestId: req.requestId,
        elapsed,
        finalTextPreview: finalText,
        toolCallCount: result.finalNode.toolResults.length,
      };
      await Promise.all(targets.map(t => send(t, 'request_end', data)));
    },

    async onRequestError(ctx, req, error) {
      const data = {
        sessionId: ctx.sessionId,
        requestId: req.requestId,
        error: error.message,
        prompt: req.inputState.promptPreview,
      };
      await Promise.all(targets.map(t => send(t, 'request_error', data)));
    },

    async onToolCallEnd(ctx, call, result, meta) {
      const data = {
        sessionId: ctx.sessionId,
        requestId: ctx.requestId,
        toolName: call.function.name,
        duration: meta.duration,
        error: meta.error,
        resultPreview: result.content.slice(0, 200),
      };
      await Promise.all(targets.map(t => send(t, 'tool_call', data)));
    },
  };
}

// ─── Auto-register default plugins ─────────────────────────────────────────

/**
 * Call once during app init to register the built-in plugins.
 * Additional plugins (e.g. mobile push) can be registered later.
 */
export function initDefaultPlugins(webhookTargets?: WebhookTarget[]): void {
  recrHost.register(createDexiePersistPlugin());
  if (webhookTargets?.length) {
    recrHost.register(createWebhookPlugin(webhookTargets));
  }
  console.debug(`[recr-plugins] Initialized plugins: ${recrHost.list().join(', ')}`);
}
