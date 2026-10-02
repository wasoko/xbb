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

type ToastFn = (message: string, options?: { description?: string }) => void;

/** Injected at call-site so this module stays free of direct sonner imports. */
export interface NoticeOptions {
  /** Supabase Realtime channel to broadcast the notice on (optional). */
  channel?: RealtimeChannel;
  /** Sonner toast helpers, keyed by level. Falls back to `toast.info` when omitted. */
  toast?: Partial<Record<NoticePayload['level'], ToastFn>> & { info: ToastFn };
  /** When true the notice is also broadcast to the Realtime channel. */
  broadcast?: boolean;
}

function fireToast(payload: NoticePayload, toast: NoticeOptions['toast']): void {
  const { scope, message, level } = payload;
  const fn = toast?.[level] ?? toast?.info;
  if (!fn) {
    console.warn('[handleNotice] No toast function available for level:', level);
    return;
  }
  fn(scope, { description: message });
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

  // 2. Notification
  fireToast(payload, toast);

  // 3. Supabase Realtime broadcast (fire-and-forget, opt-in)
  if (broadcast && channel) {
    void broadcastNotice(payload, channel);
  }
}

import React, { useState, useEffect } from 'react';

// // Assuming these types match your project
// type NoticeItem = { message: string; timestamp: number };
// type NoticeGroup = { id: string; count: number; items: NoticeItem[]; lastSeen: number; level: string; scope: string; title?: string };
// type NoticeHistory = Record<string, NoticeGroup>;


export function NotificationDropdown() {
  const [history, setHistory] = useState<NoticeHistory>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
      setHistory(data || {});
    } catch {
      setHistory({});
    }
  }, []);

  const toggleGroup = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const clearHistory = async () => {
    localStorage.removeItem(STORAGE_KEY);
    setHistory({});
  };

  const groups = Object.values(history).sort((a, b) => b.lastSeen - a.lastSeen);

  if (groups.length === 0) {
    return (
      <div className="w-[320px] bg-gray-100/80 backdrop-blur-md rounded-xl p-4 shadow-lg border border-gray-200/50">
        <div className="text-center opacity-50 cursor-default text-sm py-4">        No notifications</div>
      </div>
    );
  }

  return (
    <div className="w-[340px] max-h-[500px] overflow-y-auto bg-gray-100/90 backdrop-blur-xl rounded-xl shadow-2xl border border-gray-200/50 flex flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 flex justify-between items-center px-4 py-3 bg-gray-100/90 backdrop-blur-xl border-b border-gray-200/50">
      <span className="text-sm font-semibold tracking-wide text-gray-800">Notification Center</span>
        <button 
          className="text-xs font-medium text-blue-600 hover:text-blue-800 transition-colors bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded-full" 
onClick={clearHistory}
>
        Clear All
      </button>
</div>

{/* Notifications List */}
      <div className="p-2 flex flex-col gap-2">
      {groups.map(group => {
// Fallback safely if items are empty
        const latestItem = group.items[0];
        if (!latestItem) return null;

        const isExpanded = expanded[group.id];

          // Determine status color
        const colorClass =
          group.level === 'error' ? 'bg-red-500' :
          group.level === 'warning' ? 'bg-yellow-500' :                                       'bg-blue-500';

        return (
          <div
            key={group.id}
            className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm overflow-hidden transition-all duration-200 border border-white/40 cursor-pointer hover:bg-white"
            onClick={(e) => toggleGroup(group.id, e)}
          >
{/* Card Header & Latest Message (Always visible) */}
              <div className="p-3.5">
            <div className="flex justify-between items-center mb-1.5">
              <div className="flex items-center gap-1.5">
                <div className={`w-2 h-2 rounded-full ${colorClass}`} />
                <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                  {group.title || group.scope}
                </span>
              </div>
              <span className="text-[11px] text-gray-400 font-medium">
                {fmtAgo(latestItem.timestamp)}
              </span>
            </div>

            <div className={`text-sm text-gray-800 ${!isExpanded && 'line-clamp-2'} leading-snug`}>
              {latestItem.message}
            </div>

{/* Collapsed Hint */}
            {group.count > 1 && !isExpanded && (
              <div className="text-[12px] text-gray-400 mt-1.5 font-medium">
                {group.count - 1} more notification{group.count > 2 ? 's' : ''}
              </div>
            )}
</div>

{/* Expanded History List */}
            {isExpanded && group.count > 1 && (
              <div className="bg-gray-50/80 border-t border-gray-100 divide-y divide-gray-100/80">
{/* Skip the first item since it's already shown in the card body */}
                {group.items.slice(1).map((item, i) => (
                  <div key={i} className="p-3.5 pl-4 flex flex-col gap-1 hover:bg-gray-100/50 transition-colors">
                      <div className="flex justify-between items-start gap-3">
                    <span className="text-sm text-gray-600 leading-snug break-words">
{item.message}
</span>
                    <span className="text-[10px] text-gray-400 whitespace-nowrap mt-0.5">
                      {fmtAgo(item.timestamp)}
                    </span>
</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
</div>
    </div>
  );
}