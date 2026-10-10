// src/ui/cardTab.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { fmtAgo, getColorChar11, sideLog } from '../fc';
import { iqWithCrumbs, type Da } from '../sdb';
import { RECR_TYPE } from '../recrConst';
import { recrRowLabel, recrTargetOf, type RecrTarget } from '../sessionTree';
import { cardDoubleClick, Cs1Renderer, matchedRefsByPins } from './cs1';
import { setTip, TipHost, TIP_ATTR } from './Tip';
import { dtMs, groupRest, isRestGrouperScript, isTagGrouper, restGroupsFor, restProfileMap, restTagContributors, restTagMap, restTagStore, restVizMode, RSSESS_GROUPER, REST_PROFILES, type RestGroup, type RestHyperState } from './restGrouper';
import { RestTuner } from './restTuner';
import { RestViz } from './restViz';
import { vizBlocks } from './restVizData';
import { explanationText, type RowTagReport } from '../srctag';
import { useTreeCac } from './useTreeCac';

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

const isPinCardRow = (da: Da) =>
  da.type === 'md' && typeof da.ref === 'string' && da.ref.startsWith('pin');

export interface CardTabProps {
  filters: string[];
  onSelectTag: (ref: string) => void;
  /** Target of a recr row click; the `f=recr` list renders those rows as buttons. */
  onJump: (target: RecrTarget) => void;
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
 * Card list over `iqWithCrumbs`: pin card rows on top, the rest rows below
 * grouped by `treeCac['restGrouper']`, and a bottom sentinel that grows the read
 * window by {@link PAGE} rows while the last page came back full.
 *
 * @param props - Card list props; search is deliberately not part of them.
 * @returns The card tab view.
 */
export function CardTab({ filters, onSelectTag, onJump, selectedRef, tidLoc, renderer }: CardTabProps) {
  const [limit, setLimit] = useState(PAGE);

  const filtersKey = filters.join(',');
  const filtersStable = useMemo(() => filters, [filtersKey]);

  /* `f=recr` lists recr's own rows; `iq` returns those instead of the tag rows. */
  const recrMode = filtersStable.length === 1 && filtersStable[0] === RECR_TYPE;

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

  const { pinRows, restRows } = useMemo(() => {
    const pin: Da[] = [];
    const rest: Da[] = [];
    for (const d of das) (isPinCardRow(d) ? pin : rest).push(d);
    return { pinRows: pin, restRows: rest };
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
  const listedRest = useMemo(
    () => restRows.filter((d) => !pinMatchedRefs.has(d.ref)),
    [restRows, pinMatchedRefs],
  );

  /*
   * Built-in groupers run synchronously during render; a script grouper row is
   * read in a live query, so its blocks arrive one tick later.
   */
  const restGrouperSett = useTreeCac<string>('restGrouper');
  /* recr rows carry no `dt`, so a dt-based grouper would put every row in one block;
     a `type='src'` grouper row is still the caller's choice. */
  const restGrouper = recrMode && !isRestGrouperScript(restGrouperSett)
    ? RSSESS_GROUPER
    : restGrouperSett;
  const syncGroups = useMemo(
    () => restGroupsFor(listedRest, restGrouper),
    [listedRest, restGrouper],
  );
  const scriptGroups = useLiveQuery(
    async () => (syncGroups === null ? groupRest(listedRest, restGrouper) : []),
    [listedRest, restGrouper, syncGroups],
    [] as RestGroup[],
  );
  const restGroups = syncGroups ?? scriptGroups;

  /*
   * The tag groupers keep the rsdt blocks and add srctag's suggestions as chips.
   * The tags are scored in a live query because the lexical pass is asynchronous,
   * and the row cap keeps a 555-row page cheap. The pass runs for every grouper —
   * the omnibox's suggestion zone ranks the same reports — and only the chips are
   * tag-specific.
   */
  const restTagging = isTagGrouper(restGrouper);
  const restTagKey = useMemo(
    () => listedRest.map((d) => `${String(d.tid)}:${d.ref}`).join('|'),
    [listedRest],
  );
  /* Tuner overrides are component state, so an experiment costs a keystroke and a
     reload restores the profile's defaults. */
  const [hyperState, setHyperState] = useState<RestHyperState>({});
  const hyper = hyperState[restGrouper];
  const hyperKey = JSON.stringify(hyper ?? null);
  /* `profile` is what a grouper has a pass to tune; the rest only feed the store. */
  const profile = REST_PROFILES[restGrouper];
  const restTags = useLiveQuery(
    async () => (profile
      ? restProfileMap(listedRest, restGrouper, hyper, { pins: pinRows })
      : restTagMap(listedRest)),
    [restTagKey, restGrouper, hyperKey, profile !== undefined],
    new Map<number, RowTagReport>(),
  );
  /* The panel's reading; `priority` and `themes` also replace the `rsdt` blocks. */
  const viz = profile ? restVizMode(profile, hyper) : undefined;
  const vizGroups = useMemo(
    () => (viz ? vizBlocks(viz, listedRest, restTags) : undefined),
    [viz, restTagKey, restTags],
  );
  /* Which rows propose each tag, for the chip tooltips. */
  const restContributors = useMemo(
    () => restTagContributors(listedRest, restTags),
    [listedRest, restTags],
  );
  useEffect(() => { restTagStore.set(restTags, listedRest); }, [restTags, restTagKey]);

  const renderRestRow = (d: Da) => {
    const report = restTagging && d.tid !== undefined ? restTags.get(d.tid) : undefined;
    return (
      /* A fragment, not a div: `.da-row` is inline-block and `.rest-group` has no
         rule, so same-block rows flow on one line until they wrap. */
      <React.Fragment key={d.ref + String(d.tid)}>
        {/* A tag precedes the row it delimits, so the chips read as the row's key. */}
        {report && report.tags.length > 0 && (
          <DynamicTagChips report={report} contributors={restContributors} />
        )}
        <Cs2Renderer da={d} onSelectTag={onSelectTag} onJump={onJump} selectedRef={selectedRef} tip />
      </React.Fragment>
    );
  };

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
    <TipHost>
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
                  : <Cs2Renderer da={p} onSelectTag={onSelectTag} onJump={onJump}
                      selectedRef={selectedRef} />}
              </div>
            ))}
          </div>
        )}

        <div className="rest-das">
          {profile && (
            <RestTuner
              grouper={restGrouper}
              hyper={hyper}
              onChange={(h) => setHyperState((s) => ({ ...s, [restGrouper]: h }))}
            />
          )}
          {viz && (
            <RestViz grouper={restGrouper} mode={viz} rows={listedRest} reports={restTags}
              dyn={hyper?.dyn === true} />
          )}
          {(vizGroups ?? restGroups).map((g) => (
            <div key={g.key} className="rest-group">
              <RestGroupHead label={g.label} />
              {g.items.map(renderRestRow)}
              {g.subgroups?.map((s) => (
                <div key={s.key} className="rest-subgroup">
                  <RestGroupHead label={s.label} level={2} />
                  {s.items.map(renderRestRow)}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div ref={sentinelRef} className="load-more-trigger">
          {das.length === 0 ? 'No data found' : canGrow ? 'Loading more...' : 'No more data'}
        </div>
      </div>
    </TipHost>
  );
}

/**
 * One rest-block heading; `level` 2 is a visit-time subgroup nested in a date
 * block. An empty label renders nothing, which is what the flat grouper emits.
 *
 * @param props.label - Heading text.
 * @param props.level - 1 for a date block, 2 for a visit-time subgroup.
 * @returns The heading element.
 */
function RestGroupHead({ label, level = 1 }: { label: string; level?: 1 | 2 }) {
  if (!label) return null;
  return (
    <div
      className="rest-group-head"
      style={{
        position: 'sticky',
        top: 0,
        fontSize: level === 1 ? '0.78em' : '0.72em',
        opacity: level === 1 ? 0.65 : 0.5,
        padding: level === 1 ? '2px 6px' : '2px 6px 2px 18px',
      }}
    >
      {label}
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
 * @param props.tip - Whether the row opens the hover preview instead of the native
 *   `title`; the pin-row caller leaves it off, the rest-list caller sets it.
 * @returns The preview row element.
 */
function Cs2Renderer({
  da, onSelectTag, onJump, selectedRef, tip = false,
}: {
  da: Da;
  onSelectTag: (ref: string) => void;
  onJump: (target: RecrTarget) => void;
  selectedRef?: string;
  tip?: boolean;
}) {
  const [isHovered, setIsHovered] = useState(false);
  /* recr rows hold JSON; their label comes from the turn the row names, not from the text. */
  const preview = da.type === RECR_TYPE ? recrRowLabel(da) : (da.txt || da.ref);
  const isUrl = /^https?:\/\//i.test(da.ref);

  const visitTime = (da.rec as { visitTime?: number } | undefined)?.visitTime ?? 0;
  const otherTags = (da.tags || []).filter((s) => s !== 'pin');
  const title = ` ${fmtAgo(visitTime)} synced:${fmtAgo(dtMs(da.dt))} \n` +
    `${otherTags.map((s) => `#${s}`).join(' ')} ${da.txt}`;

  const rowStyle: React.CSSProperties = {
    cursor: 'pointer',
    ...PREVIEW_CROP,
    ...(selectedRef === da.ref ? { background: SELECTED_BG } : {}),
    textDecoration: isHovered ? 'underline' : 'none',
  };
  const hover = {
    onMouseEnter: () => setIsHovered(true),
    onMouseLeave: () => setIsHovered(false),
  };

  if (da.type === RECR_TYPE) {
    /* A recr row opens the chat at its session or node, or opens a config row as a tab. */
    return (
      <button className="da-row" onClick={() => onJump(recrTargetOf(da.ref))}
        title={tip ? undefined : da.ref}
        {...(tip ? { [TIP_ATTR]: '', ref: (el: HTMLButtonElement | null) => setTip(el, da) } : {})}
        style={rowStyle} {...hover}>
        {preview}
      </button>
    );
  }
  if (isUrl) {
    return (
      <a className="da-row" href={da.ref} target="_blank" rel="noreferrer"
        title={tip ? undefined : title}
        {...(tip ? { [TIP_ATTR]: '', ref: (el: HTMLAnchorElement | null) => setTip(el, da) } : {})}
        style={rowStyle} {...hover}>
        {preview}
      </a>
    );
  }
  if (da.type === 'md') {
    return (
      <button className="da-row" onClick={() => onSelectTag(da.ref)}
        title={tip ? undefined : title}
        {...(tip ? { [TIP_ATTR]: '', ref: (el: HTMLButtonElement | null) => setTip(el, da) } : {})}
        style={rowStyle} {...hover}>
        {preview}
      </button>
    );
  }
  return (
    <Link className="da-row" to={da.ref} onClick={() => onSelectTag(da.ref)}
      title={tip ? undefined : title}
      {...(tip ? { [TIP_ATTR]: '', ref: (el: HTMLAnchorElement | null) => setTip(el, da) } : {})}
      style={rowStyle} {...hover}>
      {preview}
    </Link>
  );
}

/**
 * The tag's own hue, lifted for the dark panel. `getColorChar11` draws a tag at
 * lightness 0.2 — right for the filled chips the hover preview and cs1 paint,
 * too close to the panel color for an outline — so the same hue is mixed toward
 * the row text color. Chip text and border share it.
 */
const tagCue = (tag: string): string =>
  `color-mix(in srgb, ${getColorChar11(tag)} 70%, rgb(230, 236, 244))`;

/**
 * A `rstag` chip: a suggestion `srctag` found, not a tag the row carries. An
 * outline-only dotted border keeps it apart from the filled `#tag` buttons the
 * persisted tags render as. Border longhands rather than the `border` shorthand,
 * because the last chip of a strip unsets its right side. The native title
 * carries the channel breakdown and the rows that proposed the tag, so a chip
 * holds no state.
 */
const DYNAMIC_CHIP: React.CSSProperties = {
  display: 'inline-block',
  marginLeft: 4,
  padding: '0 5px',
  borderRadius: 4,
  background: 'transparent',
  borderWidth: 1,
  borderStyle: 'dotted',
  fontSize: '0.78em',
  cursor: 'help',
  whiteSpace: 'nowrap',
};

/**
 * Chip strip: cropped to a fixed width and scrolled, the way a preview row is, so
 * a row with many suggestions cannot widen the list.
 */
const CHIP_STRIP: React.CSSProperties = {
  display: 'inline-block',
  maxWidth: 'max(33.33%, 222px)',
  overflowX: 'auto',
  overflowY: 'hidden',
  whiteSpace: 'nowrap',
  verticalAlign: 'bottom',
  marginRight: 2,
};

/**
 * A promoted sub-tag's chip: same hue, but a solid border and italic text, so a
 * `parent/theme` the aim pass minted is not read as a term the row's own text
 * scored.
 */
const SUB_CHIP: React.CSSProperties = {
  borderStyle: 'solid',
  fontStyle: 'italic',
};

/**
 * The `srctag` suggestions of one rest row, rendered in front of that row. The
 * chip nearest the row drops its right border, so the box reads as open against
 * the item it delimits instead of boxing the item off. Hovering a chip names the
 * channels that produced the tag and every scored row that proposes it;
 * nothing here is written to the store.
 *
 * @param props.report - Row report returned by the rest pass.
 * @param props.contributors - Rows proposing each tag, for the hover text.
 * @returns The chip strip, or nothing when the row has no suggestion.
 */
function DynamicTagChips({ report, contributors }: {
  report: RowTagReport;
  contributors?: Map<string, Da[]>;
}) {
  return (
    <span className="rest-tag-chips" style={CHIP_STRIP}>
      {report.tags.map((t, i) => {
        const rows = contributors?.get(t.tag) ?? [];
        const title = [
          explanationText(t, { dim: report.dim, window: report.window }),
          ...(rows.length === 0 ? [] : [
            `suggested by ${rows.length}:`,
            ...rows.map((r) => r.txt || r.ref),
          ]),
        ].join('\n');
        return (
          <span
            key={t.tag}
            style={{
              ...DYNAMIC_CHIP,
              color: tagCue(t.tag),
              borderColor: tagCue(t.tag),
              ...(t.origin === 'sub' ? SUB_CHIP : {}),
              ...(i === report.tags.length - 1 ? { borderRightStyle: 'none' } : {}),
            }}
            title={title}
          >
            #{t.tag}
          </span>
        );
      })}
    </span>
  );
}
