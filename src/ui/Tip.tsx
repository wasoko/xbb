/**
 * `Tip.tsx` — the one hover preview used by the card list.
 *
 * A row registers itself with {@link setTip} and the `data-tip` marker; the
 * popover picks its body from the row type: `md` renders markdown (math included),
 * `src` shows the row through the same CodeMirror setup the editor pane uses,
 * anything else prints as plain text.
 *
 * The whole list shares one popover and one pair of listeners, because a page
 * holds hundreds of rows. The popover sits flush under the row's left edge so the
 * pointer can travel from the row into the preview without leaving both, and the
 * close runs on a grace timer the popover cancels when entered.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { dtMs, fmtAgo, getColorChar11 } from '../fc';
import type { Da } from '../sdb';
import { hydrateMath, renderMd } from '../md';

/** Marker attribute the delegated listener looks for. */
export const TIP_ATTR = 'data-tip';

/** Text per previewable element; a `WeakMap` so unmounted rows leave nothing behind. */
const tipData = new WeakMap<Element, Da>();

/**
 * Registers one row's preview. Call it from a `ref` callback; passing `null` on
 * unmount is a no-op because the `WeakMap` entry dies with the element.
 *
 * @param el - Element that should preview `da` on hover.
 * @param da - Row whose `type` chooses the body renderer.
 */
export function setTip(el: Element | null, da: Da): void {
  if (el) tipData.set(el, da);
}

/** Delay before a hover opens the popover, so a pointer crossing the list stays quiet. */
const HOVER_DELAY_MS = 160;

/** Grace after leaving a row, so the pointer can finish the trip into the popover. */
const CLOSE_GRACE_MS = 220;

/** Longest source preview; a longer row is cut instead of mounting a huge editor. */
const SRC_LIMIT = 4000;

/** Rendered markdown by text, so re-hovering a row does not re-parse it. */
const htmlCache = new Map<string, string>();

/** Tag chips to the first line, keyed the same way `cs1` colors its tag buttons. */
const CHIP: React.CSSProperties = {
  padding: '0 5px', marginLeft: 4, borderRadius: 4, color: 'white', fontSize: '0.85em',
};

/** Panel look shared with the app's dropdowns (`.tab-dropdown-content`). */
const PANEL: React.CSSProperties = {
  position: 'fixed', zIndex: 60,
  background: 'rgba(0, 0, 0, 0.85)', backdropFilter: 'blur(15px)',
  border: '1px solid rgba(255, 255, 255, 0.2)', borderRadius: 12,
  boxShadow: '0 8px 24px rgba(0,0,0,0.6)', color: 'white', fontSize: 13,
};

/**
 * Languages the preview highlights, matching the editor pane's suffix choice.
 *
 * @param ref - Row ref, whose suffix names the language.
 * @returns CodeMirror extensions for that suffix.
 */
const srcExtensions = (ref: string) => {
  if (ref.endsWith('.md')) return [markdown()];
  if (/\.(ts|tsx|js|jsx)$/.test(ref)) return [javascript({ jsx: true })];
  return [];
};

/**
 * Rendered markdown for one row, cached by text.
 *
 * @param txt - Markdown source.
 * @returns HTML whose math is still a placeholder.
 */
function cachedHtml(txt: string): string {
  const hit = htmlCache.get(txt);
  if (hit) return hit;
  const html = renderMd(txt);
  htmlCache.set(txt, html);
  if (htmlCache.size > 200) htmlCache.delete(htmlCache.keys().next().value as string);
  return html;
}

/**
 * The popover's first line: sync ages, the row id, and its tags.
 *
 * @param da - Row being previewed.
 * @returns Header element with color-coded tag chips.
 */
export function tipHead(da: Da) {
  const visitTime = (da.rec as { visitTime?: number } | undefined)?.visitTime ?? 0;
  const tags = (da.tags || []).filter((s) => s !== 'pin');
  return (
    <div style={{ opacity: 0.75, fontSize: 12, marginBottom: 6, whiteSpace: 'nowrap' }}>
      {fmtAgo(visitTime)} synced:{fmtAgo(dtMs(da.dt))}
      {da.tid !== undefined && <span> · tid: {da.tid}</span>}
      {tags.map((tag) => (
        <span key={tag} style={{ ...CHIP, backgroundColor: getColorChar11(tag) }}>#{tag}</span>
      ))}
    </div>
  );
}

/**
 * Wraps a list with hover previews for its rows.
 *
 * @param props.children - List content; rows opt in through {@link setTip}.
 * @returns The wrapped list plus, while open, one portal popover.
 */
export function TipHost({ children }: { children: React.ReactNode }) {
  const [row, setRow] = useState<{ da: Da; left: number; top: number } | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const popover = useRef<HTMLDivElement | null>(null);

  const cancelClose = useCallback(() => window.clearTimeout(closeTimer.current), []);
  const close = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    setRow(null);
  }, []);
  const closeSoon = useCallback(() => {
    window.clearTimeout(openTimer.current);
    closeTimer.current = window.setTimeout(() => setRow(null), CLOSE_GRACE_MS);
  }, []);

  const open = useCallback((el: Element) => {
    const da = tipData.get(el);
    if (!da) return;
    window.clearTimeout(closeTimer.current);
    /* Sits flush under the row and shares its left edge; the row is already
       highlighted, so the preview needs no other anchor. */
    const rect = el.getBoundingClientRect();
    const width = da.type === 'src' ? Math.min(720, window.innerWidth - 16) : 420;
    const left = Math.max(0, Math.min(rect.left, window.innerWidth - width - 8));
    openTimer.current = window.setTimeout(
      () => setRow({ da, left, top: rect.bottom - 1 }),
      HOVER_DELAY_MS,
    );
  }, []);

  useEffect(() => () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }, []);

  /* Math fills in after the popover is on screen, so text paints first. */
  useEffect(() => {
    if (row?.da.type === 'md' && popover.current) void hydrateMath(popover.current);
  }, [row]);

  useEffect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [row, close]);

  const host = {
    onMouseOver: (e: React.MouseEvent) => {
      const el = (e.target as Element).closest(`[${TIP_ATTR}]`);
      if (el) open(el);
      else closeSoon();
    },
    onMouseLeave: closeSoon,
    onFocus: (e: React.FocusEvent) => {
      const el = (e.target as Element).closest(`[${TIP_ATTR}]`);
      if (el) open(el);
    },
    onBlur: closeSoon,
  };

  const body = useMemo(() => {
    if (!row) return null;
    if (row.da.type === 'md') {
      return <div dangerouslySetInnerHTML={{ __html: cachedHtml(row.da.txt) }} />;
    }
    if (row.da.type === 'src') {
      return (
        <CodeMirror
          value={row.da.txt.slice(0, SRC_LIMIT)}
          editable={false}
          extensions={srcExtensions(row.da.ref)}
          theme={oneDark}
          height="100%"
          basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
        />
      );
    }
    return <div style={{ whiteSpace: 'pre-wrap', maxWidth: '44ch' }}>{row.da.txt}</div>;
  }, [row]);

  const isSrc = row?.da.type === 'src';

  return (
    <>
      <div style={{ display: 'contents' }} {...host}>
        {children}
      </div>
      {row && createPortal(
        <div
          ref={popover}
          className="tip"
          role="tooltip"
          onMouseEnter={cancelClose}
          onMouseLeave={close}
          style={{
            ...PANEL,
            left: row.left,
            top: row.top,
            maxWidth: isSrc ? 'min(720px, 96vw)' : '44ch',
            padding: '8px 10px',
          }}
        >
          {tipHead(row.da)}
          <div style={{ maxHeight: '46vh', overflow: 'auto', minWidth: isSrc ? 420 : 0 }}>
            {body}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
