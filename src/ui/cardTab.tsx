// src/ui/cardTab.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { fmtAgo, sideLog } from '../fc';
import { iqWithCrumbs, type Da } from '../sdb';
import { cardDoubleClick, Cs1Renderer, matchedRefsByPins } from './cs1';

/** Rows read per page; the sentinel widens the read window by this much. */
const PAGE = 555;

const SELECTED_BG = 'rgba(59, 130, 246, 0.3)';

/**
 * Preview-row caption width. The whole `txt` stays in the DOM and is cropped by
 * clipping instead of `slice`, so browser find-in-page can still reach the
 * hidden tail; `33ch` is the character budget the rows used to slice to.
 */
const PREVIEW_CROP: React.CSSProperties = {
  display: 'inline-block',
  maxWidth: '22ch',
  whiteSpace: 'nowrap',
  overflow: 'auto',
  // scrollbarColor: '#bbb transparent', 
};

/**
 * `dt` is a Date on locally written rows, but the sync writes `res.server_now`
 * (`src/greet.ts:289`), so the durable value can also be an ISO string or an
 * epoch number. `fmtAgo` ends in `new Date(ts)`, so convert before use.
 */
const dtMs = (dt: unknown): number => (dt ? new Date(dt as string | number).getTime() : 0);

const isPinCardRow = (da: Da) =>
  da.type === 'md' && typeof da.ref === 'string' && da.ref.startsWith('pin');

export interface CardTabProps {
  filters: string[];
  onSelectTag: (ref: string) => void;
  /** Ref currently open in the editor pane, rendered as selected. */
  selectedRef?: string;
  /** Locate target; pins the read window to one tid and disables growth. */
  tidLoc?: string | null;
  /** Reserved for locate-by-tid navigation; not consumed yet. */
  onLocate?: (tid: number) => void;
  /** Pin-row renderer: `cs1` markdown card, `cs2` cropped preview row. */
  renderer: 'cs1' | 'cs2';
}

/**
 * Card list over `iqWithCrumbs`: pin card rows on top, ungrouped preview rows
 * below, and a bottom sentinel that grows the read window by {@link PAGE} rows
 * while the last page came back full.
 *
 * @param props - Card list props; search is deliberately not part of them.
 * @returns The card tab view.
 */
export function CardTab({ filters, onSelectTag, selectedRef, tidLoc, renderer }: CardTabProps) {
  const [limit, setLimit] = useState(PAGE);

  const filtersKey = filters.join(',');
  const filtersStable = useMemo(() => filters, [filtersKey]);

  const das = useLiveQuery(
    async () => {
      const { finalDas } = await iqWithCrumbs(filtersStable, undefined, Number(tidLoc), limit);
      return (finalDas ?? []) as Da[];
    },
    [filtersKey, tidLoc, limit],
    [] as Da[],
  );

  /* A new filter set or locate target restarts the window at one page. */
  useEffect(() => {
    setLimit(PAGE);
  }, [filtersKey, tidLoc]);

  const { pinRows, ungrouped } = useMemo(() => {
    const pin: Da[] = [];
    const rest: Da[] = [];
    for (const d of das) (isPinCardRow(d) ? pin : rest).push(d);
    return { pinRows: pin, ungrouped: rest };
  }, [das]);

  /* Every ref a pin card renders is dropped from the list below it. */
  const pinKey = useMemo(
    () => pinRows.map((p) => `${p.ref}\u0000${p.tid}\u0000${p.txt}`).join('\u0001'),
    [pinRows],
  );
  const pinMatchedRefs = useLiveQuery(
    async () => matchedRefsByPins(pinRows),
    [pinKey],
    new Set<string>(),
  );
  const listedUngrouped = useMemo(
    () => ungrouped.filter((d) => !pinMatchedRefs.has(d.ref)),
    [ungrouped, pinMatchedRefs],
  );

  /* A page shorter than asked for means the table is exhausted. */
  const canGrow = !tidLoc && das.length >= limit;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !canGrow) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setLimit((prev) => prev + PAGE);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [canGrow]);

  const pinHeightVh = pinRows.length > 0 ? 66 / pinRows.length : 0;

  return (
    <div className="card-tab">
      {pinRows.length > 0 && (
        <div className="pin-cards" style={{ height: '66vh', overflow: 'hidden' }}>
          {pinRows.map((p) => (
            <div
              key={p.ref + String(p.tid)}
              className="pin-card-row"
              style={{ height: `${pinHeightVh}vh`, overflow: 'auto', touchAction: 'manipulation' }}
              onDoubleClick={cardDoubleClick(p.ref, onSelectTag)}
            >
              {sideLog(`rend:`,renderer) === 'cs1'
                ? <Cs1Renderer da={p} onSelectTag={onSelectTag} />
                : <Cs2Renderer da={p} onSelectTag={onSelectTag} selectedRef={selectedRef} />}
            </div>
          ))}
        </div>
      )}

      <div className="ungrouped-das">
        {listedUngrouped.map((d) => (
          <Cs2Renderer
            key={d.ref + String(d.tid)}
            da={d}
            onSelectTag={onSelectTag}
            selectedRef={selectedRef}
          />
        ))}
      </div>

      <div ref={sentinelRef} className="load-more-trigger">
        {das.length === 0 ? 'No data found' : canGrow ? 'Loading more...' : 'No more data'}
      </div>
    </div>
  );
}

/**
 * Preview row: `http(s)` refs open in a new tab, `md` refs open the editor,
 * any other ref navigates; the caption is `txt` cropped to a fixed
 * {@link PREVIEW_CROP} width by CSS, so the clip does not remove text from find.
 *
 * @param props.da - Row to render.
 * @param props.onSelectTag - Opens the row's ref in the editor pane.
 * @param props.selectedRef - Ref currently open, rendered as selected.
 * @returns The preview row element.
 */
function Cs2Renderer({
  da, onSelectTag, selectedRef,
}: { da: Da; onSelectTag: (ref: string) => void; selectedRef?: string }) {
  const [isHovered, setIsHovered] = useState(false);
  const preview = da.txt || da.ref;
  const isUrl = /^https?:\/\//i.test(da.ref);

  const visitTime = (da.rec as { visitTime?: number } | undefined)?.visitTime ?? 0;
  const otherTags = (da.tags || []).filter((s) => s !== 'pin');
  const title = ` ${fmtAgo(visitTime)} synced:${fmtAgo(dtMs(da.dt))} \n` +
    `${otherTags.map((s) => `#${s}`).join(' ')} ${da.txt}`;

  const rowStyle: React.CSSProperties = {
    textDecoration: isHovered ? 'underline' : 'none',
    cursor: 'pointer',
    ...PREVIEW_CROP,
    ...(selectedRef === da.ref ? { background: SELECTED_BG } : {}),
  };
  const hover = {
    onMouseEnter: () => setIsHovered(true),
    onMouseLeave: () => setIsHovered(false),
  };

  if (isUrl) {
    return (
      <a className="da-row" href={da.ref} target="_blank" rel="noreferrer"
        title={title} style={rowStyle} {...hover}>
        {preview}
      </a>
    );
  }
  if (da.type === 'md') {
    return (
      <button className="da-row" onClick={() => onSelectTag(da.ref)}
        title={title} style={rowStyle} {...hover}>
        {preview}
      </button>
    );
  }
  return (
    <Link className="da-row" to={da.ref} onClick={() => onSelectTag(da.ref)}
      title={title} style={rowStyle} {...hover}>
      {preview}
    </Link>
  );
}
