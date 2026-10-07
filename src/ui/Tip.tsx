/**
 * `Tip.tsx` — the one hover preview used by the card list.
 *
 * A row registers itself with {@link setTip} and the `data-tip` marker; the
 * popover picks its body from the row type: `md` renders markdown (math included)
 * under the `.tip-md` typography, `src` shows the row through the same CodeMirror
 * setup the editor pane uses, and anything else — a plain row, a `http(s)` ref —
 * prints its text.
 *
 * The whole list shares one popover and one pair of listeners, because a page
 * holds hundreds of rows. The popover sits flush under the row so the pointer can
 * travel from the row into the preview without leaving both, and its left edge
 * carries the list container's, so every row's preview opens in the same column;
 * the close runs on a grace timer the popover cancels when entered.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
 * Languages the preview highlights, matching the editor pane's suffix choice. A
 * `type='src'` row is a script body the app runs through `runsrc`, so a ref whose
 * suffix names no language grammar still gets JavaScript rather than no grammar.
 *
 * @param ref - Row ref, whose suffix names the language.
 * @returns CodeMirror extensions for that suffix.
 */
const srcExtensions = (ref: string) =>
  ref.toLowerCase().endsWith('.md') ? [markdown()] : [javascript({ jsx: true })];

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

/** Smallest gap the popover keeps from the viewport's right edge. */
const EDGE_GAP = 8;

/** A fit within this many pixels of {@link EDGE_GAP} counts as converged, so the correction stops. */
const FIT_EPS = 0.5;

/**
 * Anchor of the popover: the list container's left edge, under the hovered row.
 */
export interface TipAnchor {
  /** Distance from the viewport's left edge to the panel's left edge. */
  left: number;
  /** Distance from the viewport's top to the panel's top. */
  top: number;
}

/**
 * Places the popover flush under the row with its left edge on the list
 * container's, so every row of one list previews in the same column.
 *
 * @param rect - Hovered row's viewport rectangle; only its bottom is read.
 * @param boxLeft - Left edge of the list container the row belongs to; a row's own
 *   left edge when the container cannot be measured.
 * @param viewportWidth - Window inner width.
 * @returns The panel's fixed-position `left` and `top`.
 */
export function tipAnchor(
  rect: { bottom: number }, boxLeft: number, viewportWidth: number,
): TipAnchor {
  return {
    left: Math.max(0, Math.min(boxLeft, viewportWidth - EDGE_GAP)),
    top: rect.bottom - 1,
  };
}

/**
 * Slides the anchored panel left until it clears the viewport's right edge. The
 * panel's width is only known once it has rendered, and a source body is wider
 * than the column the rows use.
 *
 * @param left - Anchored distance from the viewport's left edge.
 * @param panelRight - Rendered panel's distance from the viewport's left edge.
 * @returns The anchor to re-render with; unchanged when the panel already fits.
 */
export function tipFittedLeft(left: number, panelRight: number, viewportWidth: number): number {
  const over = panelRight - (viewportWidth - EDGE_GAP);
  return over > FIT_EPS ? Math.max(0, Math.round(left - over)) : left;
}

/**
 * Wraps a list with hover previews for its rows.
 *
 * @param props.children - List content; rows opt in through {@link setTip}.
 * @returns The wrapped list plus, while open, one portal popover.
 */
export function TipHost({ children }: { children: React.ReactNode }) {
  const [row, setRow] = useState<(TipAnchor & { da: Da }) | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const popover = useRef<HTMLDivElement | null>(null);
  /* `display: contents` gives the wrapper no box, so the list is its first child. */
  const list = useRef<HTMLDivElement | null>(null);

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
    openTimer.current = window.setTimeout(() => {
      const rect = el.getBoundingClientRect();
      const boxLeft = list.current?.firstElementChild?.getBoundingClientRect().left ?? rect.left;
      setRow({ da, ...tipAnchor(rect, boxLeft, window.innerWidth) });
    }, HOVER_DELAY_MS);
  }, []);

  /* The panel's width is unknown until it renders, so the anchor is fitted after. */
  useLayoutEffect(() => {
    const el = popover.current;
    if (!row || !el) return;
    const fitted = tipFittedLeft(row.left, el.getBoundingClientRect().right, window.innerWidth);
    if (fitted !== row.left) setRow((prev) => (prev ? { ...prev, left: fitted } : prev));
  }, [row]);

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
      return <div className="tip-md" dangerouslySetInnerHTML={{ __html: cachedHtml(row.da.txt) }} />;
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
    /* A plain or `http(s)` row: the full text the row preview crops. */
    return <div style={{ whiteSpace: 'pre-wrap', maxWidth: '44ch' }}>{row.da.txt || row.da.ref}</div>;
  }, [row]);

  const isSrc = row?.da.type === 'src';

  return (
    <>
      <div ref={list} style={{ display: 'contents' }} {...host}>
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
