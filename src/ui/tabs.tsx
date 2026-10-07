// src/ui/tabs.tsx
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import React from 'react';
import { fmtAgo } from '../fc';
import { iqWithCrumbs, treeCac, type Da } from '../sdb';
import { recrRowLabel, recrTabRef, recrTargetOf, type RecrTarget } from '../sessionTree';
import { RECR_TYPE } from '../recrConst';
import { EditorSplitPane } from './editor';
import { Cs1Renderer } from './cs1';
import { CardTab, type CardTabProps } from './cardTab';
import { setTip, TipHost, TIP_ATTR } from './Tip';
import { useTreeCac } from './useTreeCac';
import { subscribeNav } from './navStore';

/* ─────────────────────────────────────────────────────────────
 * Small shared utilities
 * ────────────────────────────────────────────────────────────*/

/** Reactive mobile check (replaces `const isMobile = window.innerWidth < 768`) */
function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth < breakpoint : false,
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return isMobile;
}

/** Encode / decode tabs csv so refs containing `/` or `,` survive a round-trip. */
const encodeTabs = (refs: string[]) => refs.map(encodeURIComponent).join(',');
const decodeTabs = (csv: string) =>
  csv ? csv.split(',').map((s) => { try { return decodeURIComponent(s); } catch { return s; } }) : [];

/* ─────────────────────────────────────────────────────────────
 * BadCardTab — legacy ungrouped pinCard rows + DaRows
 * ────────────────────────────────────────────────────────────*/

const isPinCardRow = (da: Da) =>
  da.type === 'md' && typeof da.ref === 'string' && da.ref.startsWith('pin');

export function BadCardTab({ filters, onSelectTag, tidLoc, renderer, onJump }: CardTabProps) {
  const limit = 555;

  const filtersKey = filters.join(',');
  const filtersStable = useMemo(() => filters, [filtersKey]);

  const das = useLiveQuery(
    async () => {
      const { finalDas } = await iqWithCrumbs(filtersStable, undefined, Number(tidLoc), limit);
      return (finalDas ?? []) as Da[];
    },
    [filtersKey, tidLoc],
    [] as Da[],
  );

  const { pinRows, ungrouped } = useMemo(() => {
    const pin: Da[] = [];
    const rest: Da[] = [];
    for (const d of das) (isPinCardRow(d) ? pin : rest).push(d);
    return { pinRows: pin, ungrouped: rest };
  }, [das]);

  const pinHeightVh = pinRows.length > 0 ? 66 / pinRows.length : 0;

  return (
    <TipHost>
      <div className="card-tab">
        {pinRows.length > 0 && (
          <div className="pin-cards" style={{ height: '66vh', overflow: 'hidden' }}>
            {pinRows.map((p) => (
              <div
                key={p.ref + String(p.tid)}
                className="pin-card-row"
                style={{ height: `${pinHeightVh}vh`, overflow: 'auto' }}
              >
                {renderer === 'cs1'
                  ? <Cs1Renderer da={p} onSelectTag={onSelectTag} />
                  : <Cs2Renderer da={p} onSelectTag={onSelectTag} onJump={onJump} />}
              </div>
            ))}
          </div>
        )}

        <div className="ungrouped-das" style={{ overflowY: 'auto' }}>
          {ungrouped.map((d) => (
            <Cs2Renderer key={d.ref + String(d.tid)} da={d} onSelectTag={onSelectTag} onJump={onJump} tip />
          ))}
          {ungrouped.length === 0 && das.length === 0 && (
            <div className="end-message">No data found</div>
          )}
        </div>
      </div>
    </TipHost>
  );
}

/* ─────────────────────────────────────────────────────────────
 * DaRow — 33-char preview; URL → link, md → editor button
 * ────────────────────────────────────────────────────────────*/

function Cs2Renderer({ da, onSelectTag, onJump, tip = false }: {
  da: Da;
  onSelectTag: (ref: string) => void;
  onJump?: (target: RecrTarget) => void;
  /** Whether the row opens the hover preview instead of the native tooltip. */
  tip?: boolean;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const preview = da.type === RECR_TYPE ? recrRowLabel(da) : (da.txt || '').slice(0, 33);
  const isUrl = /^https?:\/\//i.test(da.ref);

  const visitTime = (da.rec as any)?.visitTime;
  const remainingTags = (da.tags || []).filter((s) => s !== 'pin'); // the pin board tag stays out of the tooltip
  const tooltip = ` ${fmtAgo(visitTime)} synced: ${fmtAgo(da.dt as any)} \n` +
    `${remainingTags.map((s) => `#${s}`).join(' ')} ${da.txt}`;

  const rowStyle: React.CSSProperties = {
    textDecoration: isHovered ? 'underline' : 'none',
    cursor: 'pointer',
  };

  if (da.type === RECR_TYPE) {
    /* A recr row jumps into the chat pane rather than opening as a file. */
    return (
      <button
        className="da-row"
        onClick={() => onJump?.(recrTargetOf(da.ref))}
        style={rowStyle}
        title={tip ? undefined : da.ref}
        {...(tip ? { [TIP_ATTR]: '', ref: (el: HTMLButtonElement | null) => setTip(el, da) } : {})}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {preview}
      </button>
    );
  }
  if (isUrl) {
    return (
      <a 
        className="da-row" 
        href={da.ref} 
        target="_blank" 
        rel="noreferrer" 
        style={rowStyle}
        title={tip ? undefined : tooltip}
        {...(tip ? { [TIP_ATTR]: '', ref: (el: HTMLAnchorElement | null) => setTip(el, da) } : {})}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {preview || da.ref}
      </a>
    );
  }
  if (da.type === 'md') {
    return (
      <button 
        className="da-row" 
        onClick={() => onSelectTag(da.ref)} 
        style={rowStyle}
        title={tip ? undefined : tooltip}
        {...(tip ? { [TIP_ATTR]: '', ref: (el: HTMLButtonElement | null) => setTip(el, da) } : {})}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {preview || da.ref}
      </button>
    );
  }
  return (
    <Link 
      className="da-row" 
      to={da.ref} 
      onClick={() => onSelectTag(da.ref)} 
      style={rowStyle}
      title={tip ? undefined : tooltip}
      {...(tip ? { [TIP_ATTR]: '', ref: (el: HTMLAnchorElement | null) => setTip(el, da) } : {})}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {preview || da.ref}
    </Link>
  );
}

/* ─────────────────────────────────────────────────────────────
 * VbCard — public entrypoint (unchanged signature)
 * ────────────────────────────────────────────────────────────*/

export function VbCard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [splitWidth, setSplitWidth] = useState(600);
  const [isDragging, setIsDragging] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  const isMobile = useIsMobile();

  /* The NavBar floats outside this route: `tables` closes the drawer, `agent` opens it. */
  useEffect(() => subscribeNav((kind) => {
    if (isMobile) setIsDrawerOpen(kind === 'agent');
  }), [isMobile]);

  const f = searchParams.get('f') || '';
  const filters = useMemo(() => (f ? f.split(',') : []), [f]);
  const activeEditor = searchParams.get('e') || '';
  const tabsCsv = searchParams.get('tabs') || '';
  const sessionId = searchParams.get('sid') || 'default';
  /** Node the chat view focuses; empty means the session head. */
  const nodeId = searchParams.get('node') || '';
  const tidLoc = searchParams.get('tid');

  /* decoded refs (issue 3 fix) */
  const openTabs = useMemo(() => decodeTabs(tabsCsv), [tabsCsv]);

  /* live view-mode switches (no remount) */
  const tabSeerSett = treeCac['tabSeer'];
  /* `treeCac` is a plain object, so only a live read repaints when the menu edits `cardSeer`. */
  const cardSeerSett = useTreeCac<string>('cardSeer');
  console.log('Current tabSeerSett value:', tabSeerSett); // <--- Add this

  useEffect(() => {
    const titlePrefix = filters.length > 0 ? filters.join(' ') + ' - ' : '';
    document.title = `${titlePrefix}Tab Seer`;
  }, [filters]);

  const updateUrl = useCallback((updates: Record<string, string | null>) => {
    const newParams = new URLSearchParams(searchParams);
    Object.entries(updates).forEach(([k, v]) => {
      if (v === null || v === '') newParams.delete(k);
      else newParams.set(k, v);
    });
    setSearchParams(newParams);
  }, [searchParams, setSearchParams]);

  const handleSelectTag = useCallback((ref: string) => {
    const newTabs = openTabs.includes(ref) ? openTabs : [...openTabs, ref];
    updateUrl({ e: ref, tabs: encodeTabs(newTabs) });     // encoded (issue 3 fix)
    if (isMobile) setIsDrawerOpen(true);
  }, [openTabs, updateUrl, isMobile]);

  const handleEditorChange = useCallback((active: string, tabs: string[]) => {
    updateUrl({ e: active, tabs: encodeTabs(tabs) });
  }, [updateUrl]);

  /** A recr row's jump: a session or node row focuses the chat, a config row opens a tab. */
  const handleJump = useCallback((target: RecrTarget) => {
    if (target.kind === 'tab') {
      handleSelectTag(recrTabRef(target.ref));
      return;
    }
    updateUrl(target.kind === 'node'
      ? { sid: target.sessionId, node: target.nodeId }
      : { sid: target.sessionId, node: null });
    if (isMobile) setIsDrawerOpen(true);
  }, [updateUrl, handleSelectTag, isMobile]);

  /** The chat follows this node; null clears the focus so it shows the session head. */
  const handleNodeChange = useCallback((next: string | null) => {
    updateUrl({ node: next });
  }, [updateUrl]);

  /** Picker selection: the session changes, so the node focus resets. */
  const handleSwitchSession = useCallback((next: string) => {
    updateUrl({ sid: next, node: null });
  }, [updateUrl]);

  /* Desktop resize drag */
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;
    const newWidth = e.clientX;
    if (newWidth > 300 && newWidth < window.innerWidth - 300) setSplitWidth(newWidth);
  }, [isDragging]);

  useEffect(() => {
    if (!isDragging) return;
    const up = () => setIsDragging(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', up);
    };
  }, [isDragging, handleMouseMove]);

  const listProps: Omit<CardTabProps, 'renderer'> = {
    filters,
    onSelectTag: handleSelectTag,
    onJump: handleJump,
    selectedRef: activeEditor,
    tidLoc,
  };

  /* `card` keeps the legacy card view; every other value renders CardTab. */
  const renderer: 'cs1' | 'cs2' = cardSeerSett === 'cs2' ? 'cs2' : 'cs1';
  console.log('[tabs] renderer switch:', {
    tabSeerSett, cardSeerSett, renderer, pinRowsProvider: tabSeerSett === 'card' ? 'BadCardTab' : 'CardTab',
  });

  const mainView = tabSeerSett === 'card'
    ? <BadCardTab {...listProps} renderer={renderer} />
    : <CardTab {...listProps} renderer={renderer} />;

  const editorPane = (
    <EditorSplitPane
      openTabs={openTabs}
      activeTab={activeEditor}
      sessionId={sessionId}
      nodeId={nodeId || undefined}
      onNodeChange={handleNodeChange}
      onSwitchSession={handleSwitchSession}
      onTabChange={handleEditorChange}
    />
  );

  /* Mobile: overlay drawer (WeChat / Taobao style slide-in) */
  if (isMobile) {
    return (
      <div className="tabs-page">
        <div className="split-container" style={{ flexDirection: 'column' }}>
          <div className="left-panel" style={{ width: '100%', height: '100%' }}>
            {mainView}
          </div>
        </div>

        <div
          className={`editor-drawer ${isDrawerOpen ? 'open' : ''}`}
          style={{
            position: 'fixed', top: 0, right: 0, bottom: 0,
            width: '100%', maxWidth: '100vw',
            transform: isDrawerOpen ? 'translateX(0)' : 'translateX(100%)',
            transition: 'transform 220ms ease-out',
            background: 'var(--bg, #fff)', zIndex: 40,
            display: 'flex', flexDirection: 'column',
            pointerEvents: isDrawerOpen ? 'auto' : 'none',
          }}
        >
          {isDrawerOpen && editorPane /* lazily mounted (issue 2 / spec §5) */}
        </div>
      </div>
    );
  }

  /* Desktop: original split layout */
  return (
    <div className="tabs-page">
      <div className="split-container" style={{ flexDirection: 'row' }}>
        <div className="left-panel" style={{ width: splitWidth, height: '100%' }}>
          {mainView}
        </div>

        <div className="resize-handle" onMouseDown={() => setIsDragging(true)} />

        <div className="right-panel" style={{ flex: 1, height: '100%' }}>
          {editorPane}
        </div>
      </div>
    </div>
  );
}