import type { RealtimeChannel } from '@supabase/supabase-js';
import {fmtAgo} from '../fc'
export interface NoticePayload {
  scope: string;
  message: string;
  level: 'status' | 'info' | 'warning' | 'error';
}

export interface NoticeItem {
  timestamp: number;
  message: string;
}

export interface NoticeGroup {
  id: string; // fingerprint: level + scope
  scope: string;
  level: 'status' | 'info' | 'warning' | 'error';
  count: number;
  lastSeen: number;
  items: NoticeItem[];
}

export type NoticeHistory = Record<string, NoticeGroup>;


// ─── Storage layer ────────────────────────────────────────────────────────────
// Web-app    → localStorage           (same NoticeHistory schema, string-serialised)

const STORAGE_KEY = 'noticeHistory';

async function readHistory(): Promise<NoticeHistory> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as NoticeHistory;
  } catch {
    return {};
  }
}

async function writeHistory(history: NoticeHistory): Promise<void> {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

const noticeListeners = new Set<() => void>()
/** Subscribe to notice history writes, so an open panel repaints instead of waiting for a
 *  remount.
 * @param listener - called after every `noticeStore` write
 * @returns the unsubscribe function */
export function subscribeNotices(listener: () => void) {
  noticeListeners.add(listener)
  return () => { noticeListeners.delete(listener) }
}

/** The stored history, read synchronously for a panel that paints on subscription. */
function readHistorySync(): NoticeHistory {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as NoticeHistory;
  } catch {
    return {};
  }
}

// ─── Local error log (fallback sink, webapp-safe) ─────────────────────────────

export const logStoreSlice = (error: unknown): void => {
  try {
    const logs: unknown[] = JSON.parse(localStorage.getItem('error_logs') ?? '[]');
    const newLog = {
      id: Date.now(),
      time: new Date().toISOString(),
      msg: error instanceof Error ? error.message : String(error ?? 'Unknown'),
    };
    localStorage.setItem(
      'error_logs',
      JSON.stringify([newLog, ...logs].slice(0, 111)),
    );
  } catch {
    /* localStorage unavailable (SSR / private mode) — silently discard */
  }
};

// ─── Notification layer ───────────────────────────────────────────────────────
// Tier 3 — sonner toast                 (always available, zero-permission)

/** One button on a toast, e.g. the next-key fallback a failed request offers. */
export interface NoticeAction {
  label: string;
  onClick: () => void;
}

type ToastFn = (message: string, options?: {
  description?: string;
  action?: NoticeAction;
  /** Milliseconds the toast lives; Infinity keeps it until it is dismissed. */
  duration?: number;
  onDismiss?: () => void;
  onAutoClose?: () => void;
}) => void;

/** Injected at call-site so this module stays free of direct sonner imports. */
export interface NoticeOptions {
  /** Supabase Realtime channel to broadcast the notice on (optional). */
  channel?: RealtimeChannel;
  /** Sonner toast helpers, keyed by level. Falls back to `toast.info` when omitted. */
  toast?: Partial<Record<NoticePayload['level'], ToastFn>> & { info: ToastFn };
  /** When true the notice is also broadcast to the Realtime channel. */
  broadcast?: boolean;
  /** Button shown on the toast. Not stored in history: it is not serialisable. */
  action?: NoticeAction;
  /** Toast lifetime in milliseconds; omitted uses the toast library's default. */
  duration?: number;
  /** Called when the user closes the toast without taking its action. */
  onDismiss?: () => void;
  /** Called when the toast's own timer ends it without its action being taken. */
  onAutoClose?: () => void;
}

function fireToast(payload: NoticePayload, options: NoticeOptions): void {
  const { scope, message, level } = payload;
  const { toast, action, duration, onDismiss, onAutoClose } = options;
  const fn = toast?.[level] ?? toast?.info;
  if (!fn) {
    console.warn('[handleNotice] No toast function available for level:', level);
    return;
  }
  fn(scope, { description: message, action, duration, onDismiss, onAutoClose });
}

// ─── Supabase broadcast ───────────────────────────────────────────────────────

async function broadcastNotice(
  payload: NoticePayload,
  channel: RealtimeChannel,
): Promise<void> {
  try {
    await channel.send({
      type: 'broadcast',
      event: 'notice',
      payload,
    });
  } catch (e) {
    logStoreSlice(e);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function noticeStore(
  payload: NoticePayload,
  options: NoticeOptions = {},
): Promise<void> {
  const { scope, message } = payload;
  const { channel, toast, broadcast = false } = options;
  // If payload.level is not set, fall back to toast.level, then to 'info'
  const level = payload.level ?? toast ?? 'info';

  // 1. Upsert history (env-aware storage, shared schema)
  try {
    const fingerprint = `${level}:${scope}`;
    const history = await readHistory();

    if (history[fingerprint]) {
      const group: NoticeGroup = history[fingerprint];
      group.count++;
      group.lastSeen = Date.now();
      group.items.unshift({ timestamp: Date.now(), message });
      if (group.items.length > 20) group.items.pop();
    } else {
      history[fingerprint] = {
        id: fingerprint,
        scope,
        level,
        count: 1,
        lastSeen: Date.now(),
        items: [{ timestamp: Date.now(), message }],
      };
    }

    await writeHistory(history);
  } catch (e) {
    logStoreSlice(e);
  }

  // 2. Live panels (the bell menu while it is open)
  noticeListeners.forEach((l) => l());

  // 3. Notification
  fireToast(payload, options);

  // 4. Supabase Realtime broadcast (fire-and-forget, opt-in)
  if (broadcast && channel) {
    void broadcastNotice(payload, channel);
  }
}

import React, { useState, useEffect } from 'react';

// // Assuming these types match your project
// type NoticeItem = { message: string; timestamp: number };
// type NoticeGroup = { id: string; count: number; items: NoticeItem[]; lastSeen: number; level: string; scope: string; title?: string };
// type NoticeHistory = Record<string, NoticeGroup>;


/** Dot colour per notice level; `status` and `info` share the neutral blue. */
const LEVEL_DOT: Record<NoticeGroup['level'], string> = {
  error: '#ef4444', warning: '#f59e0b', status: '#3b82f6', info: '#3b82f6',
};

/** A folded row keeps the first two lines of its newest message. */
const CLAMP2: React.CSSProperties = {
  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
};

/** The bell menu: one row per topic (`level:scope`), newest topic first. A row shows that
 *  topic's newest message and, folded open, the older ones of the same topic. */
export function NotificationDropdown() {
  const [history, setHistory] = useState<NoticeHistory>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const read = () => setHistory(readHistorySync());
    read();
    return subscribeNotices(read);
  }, []);

  const toggleGroup = (id: string) => {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const clearHistory = async () => {
    localStorage.removeItem(STORAGE_KEY);
    setHistory({});
  };

  const groups = Object.values(history).sort((a, b) => b.lastSeen - a.lastSeen);

  if (groups.length === 0) {
    return <div className="user-dropdown-item" style={{ opacity: 0.6, cursor: 'default' }}>no notifications</div>;
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px'
        , fontSize: 11, opacity: 0.6 }}>
        <span style={{ flex: '1 1 auto' }}>Notification Center</span>
        <button className="user-dropdown-item" style={{ flex: '0 0 auto', width: 'auto'
          , padding: '2px 6px', fontSize: 11 }} onClick={clearHistory}>Clear All</button>
      </div>
      {groups.map(group => {
        // Fallback safely if items are empty
        const latestItem = group.items[0];
        if (!latestItem) return null;
        const isOpen = expanded[group.id];

        return (
          <button
            key={group.id}
            className="user-dropdown-item"
            title="fold or unfold this topic"
            onClick={() => toggleGroup(group.id)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ flex: '0 0 auto', width: 6, height: 6, borderRadius: '50%'
                , background: LEVEL_DOT[group.level] }} />
              <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden'
                , textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, opacity: 0.6 }}
              >{group.scope}</span>
              {group.count > 1 && (
                <span style={{ flex: '0 0 auto', fontSize: 11, opacity: 0.5 }}>
                  {isOpen ? '\u25be' : '\u25b8'} {group.count}
                </span>
              )}
              <span style={{ flex: '0 0 auto', fontSize: 11, opacity: 0.45 }}>
                {fmtAgo(latestItem.timestamp)}
              </span>
            </div>
            <div style={isOpen ? undefined : CLAMP2}>{latestItem.message}</div>
            {/* cropped to a window height: a topic with many notices scrolls inside its own row
                instead of growing the panel past the screen */}
            {isOpen && group.count > 1 && (
              <div style={{ maxHeight: '45vh', overflowY: 'auto', overflowX: 'hidden' }}>
                {group.items.slice(1).map((item, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, marginTop: 4, paddingLeft: 8
                    , borderLeft: '1px solid rgba(255, 255, 255, 0.15)' }}>
                    <span style={{ flex: '1 1 auto', minWidth: 0, opacity: 0.7, whiteSpace: 'pre-wrap' }}
                    >{item.message}</span>
                    <span style={{ flex: '0 0 auto', fontSize: 10, opacity: 0.45, whiteSpace: 'nowrap' }}>
                      {fmtAgo(item.timestamp)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </button>
        );
      })}
    </>
  );
}