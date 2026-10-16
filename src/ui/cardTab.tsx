// src/ui/cardTab.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { fmtAgo, sideLog } from '../fc';
import { IQ_CNT, iqWithCrumbs, type Da } from '../sdb';
import { RECR_TYPE } from '../recrConst';
import { recrRowLabel, recrTargetOf, type RecrTarget } from '../sessionTree';
import { cardDoubleClick, Cs1Renderer, matchedRefsByPins } from './cs1';
import { setTip, TipHost, TIP_ATTR } from './Tip';
import { dtMs, groupRest, isRestGrouperScript, isTagGrouper, restGroupsFor, restProfileMap, restTagContributors, restTagMap, restTagStore, restVizMode, RSSESS_GROUPER, REST_PROFILES, type RestGroup, type RestHyperState, type RestSubTag } from './restGrouper';
import { RestTuner } from './restTuner';
import { RestViz } from './restViz';
import { vizBlocks, tagTopExplanations, CLUSTER_SUB_MAX, type VizTagDetail } from './restVizData';
import { tagCue } from './restCue';
import { RestGraph } from './RestGraph';
import { buildTagGraph } from './restGraph';
import { REST_GRAPH_PARAM, openRestGraph, restGraphOpen } from './restGraphWindow';
import { explanationText, type RowTagReport } from '../srctag';
import { useTreeCac } from './useTreeCac';

/** Rows read per page; the sentinel widens the read window by this much. */
const PAGE = IQ_CNT;

/** Budget for one widened read before the sentinel reports it as slow and offers a retry. */
const LOAD_TIMEOUT_MS = 8000;

const SELECTED_BG = 'rgba(59, 130, 246, 0.3)';

/** The sentinel's manual grow/retry control; it inherits that line's `#888`. */
const LOAD_MORE_BUTTON: React.CSSProperties = {
  marginLeft: 8,
  padding: '2px 10px',
  background: 'transparent',
  color: 'inherit',
  border: '1px solid currentColor',
  borderRadius: 4,
  font: 'inherit',
  cursor: 'pointer',
};

/* Row cropping — the fixed width, the sideways scroll and the hairline bar —
   lives in the shared `.crop-scroll` rule of `index.html`, so a `.da-row` and a
   `.cs1-match` crop at the same `treeCac['cropWidth']`-driven width. The whole
   `txt` stays in the DOM and is cropped by clipping instead of `slice`, so
   browser find-in-page can still reach the hidden tail. */

/** Whether a row is one of the pin cards the list's rest region sits below. */
export const isPinCardRow = (da: Da) =>
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
 * The card and the graph side by side, in the wide view's window: the list keeps
 * two thirds and the graph takes the rest.
 */
const WIDE_ROW: React.CSSProperties = { display: 'flex', alignItems: 'flex-start' };
const WIDE_LEFT: React.CSSProperties = { flex: '0 0 62.5%', minWidth: 0 };
const WIDE_PANE: React.CSSProperties = {
  flex: '1 1 auto', minWidth: 0, height: '100vh', overflow: 'hidden',
  borderLeft: '1px solid rgba(128,128,128,0.35)',
};

/** The control that opens the graph's own window; the wide view does not repeat it. */
const GRAPH_BUTTON: React.CSSProperties = {
  display: 'block', margin: '2px 0 4px', padding: '2px 8px', fontSize: 12,
  background: 'transparent', color: 'inherit', cursor: 'pointer',
  border: '1px solid rgba(128,128,128,0.45)', borderRadius: 4,
};
const GRAPH_HELP = 'the same list, in a window of its own, with the tag graph beside it';

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
  /* Bumped to re-issue a read the user asked to retry. */
  const [retryKey, setRetryKey] = useState(0);

  const filtersKey = filters.join(',');
  const filtersStable = useMemo(() => filters, [filtersKey]);

  /* `f=recr` lists recr's own rows; `iq` returns those instead of the tag rows. */
  const recrMode = filtersStable.length === 1 && filtersStable[0] === RECR_TYPE;

  /* The rows carry the `limit` they were read at, which is what tells a widened window
     apart from one that has not been read yet: while the read is in flight the rows in
     hand are still the previous page. */
  const page = useLiveQuery(
    async () => {
      const { finalDas } = await iqWithCrumbs(filtersStable, undefined, Number(tidLoc), limit);
      return { rows: (finalDas ?? []) as Da[], limit };
    },
    [filtersKey, tidLoc, limit, retryKey],
    { rows: [] as Da[], limit: 0 },
  );
  const das = page.rows;
  /** The read for the current window has not landed yet. */
  const loading = page.limit !== limit;

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
      ? restProfileMap(listedRest, restGrouper, hyper, { pins: pinRows, filters: filtersStable })
      : restTagMap(listedRest)),
    [restTagKey, restGrouper, hyperKey, profile !== undefined],
    new Map<number, RowTagReport>(),
  );
  /* The panel's reading; `clusters`, `priority` and `themes` also replace the
     `rsdt` blocks. */
  const viz = profile ? restVizMode(profile, hyper) : undefined;
  /* The clustered reading heads each block with the tag itself. */
  const clustered = viz === 'clusters';
  const vizGroups = useMemo(
    () => (viz ? vizBlocks(viz, listedRest, restTags) : undefined),
    [viz, restTagKey, restTags],
  );
  /* Which rows propose each tag, for the chip tooltips, and what the pass said
     about each one, for the head chips the panel draws no bar for. */
  const restContributors = useMemo(
    () => restTagContributors(listedRest, restTags),
    [listedRest, restTags],
  );
  const restTagDetails = useMemo(
    () => tagTopExplanations(listedRest, restTags),
    [restTagKey, restTags],
  );
  useEffect(() => { restTagStore.set(restTags, listedRest, pinRows); }, [restTags, restTagKey, pinKey]);

  /*
   * The wide view is this same list in a window of its own, with the tag graph
   * beside it. It reads the page's own flag, so opening it costs no state and the
   * two windows stay in step through the store and the filter alone.
   */
  const [search] = useSearchParams();
  const wide = restGraphOpen(search);
  const tagGraph = useMemo(
    () => (wide ? buildTagGraph(pinRows, listedRest, restTags) : undefined),
    [wide, listedRest, restTagKey, restTags],
  );

  /**
   * The rows of one block. A row whose block carries no tag head keeps its own
   * chip strip: the `clusters` reading hides a row's suggestions only where the
   * head above it already names one, so the blocks that fold their tags away
   * still say what each of their rows was filed under.
   */
  const renderBlockItems = (block: RestGroup) => (d: Da) => {
    const report = restTagging && block.tag === undefined && d.tid !== undefined
      ? restTags.get(d.tid)
      : undefined;
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

  /* A full page means older rows may remain and a short one means the table is
     exhausted. `loading` is excluded because a widened read has left the rows in hand
     at their old length, which would read as a short page. */
  const canGrow = !tidLoc && !loading && das.length >= limit;
  const [atEnd, setAtEnd] = useState(false);
  const [slow, setSlow] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  /* One observer for the list's lifetime. Rebuilding it per page, as a `canGrow`
     dependency did, drops the scroll that lands while the window widens: the sentinel
     leaves the view as the new rows arrive, and only an observation made during the
     load reports it back. */
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setAtEnd(entry.isIntersecting));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /* Growth follows the state rather than the event, so a page that lands while the
     sentinel still stands in view widens the window again without another scroll. */
  useEffect(() => {
    if (atEnd && canGrow) setLimit((prev) => prev + PAGE);
  }, [atEnd, canGrow]);

  /* A read that overruns the budget stops claiming progress and offers a retry. */
  useEffect(() => {
    if (!loading) { setSlow(false); return; }
    const timer = setTimeout(() => setSlow(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [loading, retryKey]);

  /* Five states, not one message: a read that is running, one that overran its budget,
     a window that can widen, a window with nothing older left, and an empty table. */
  const sentinelLabel = das.length === 0
    ? (loading ? 'Loading...' : 'No data found')
    : loading
      ? (slow ? `Still loading after ${LOAD_TIMEOUT_MS / 1000}s` : 'Loading more...')
      : canGrow ? 'Scroll for more' : 'No more data';
  const sentinelAction = slow ? 'Retry' : canGrow ? 'Load more' : null;
  /* `slow` re-issues the read in flight; a click on a full page widens the window. */
  const growOrRetry = () => {
    if (slow) { setSlow(false); setRetryKey((k) => k + 1); }
    else setLimit((prev) => prev + PAGE);
  };

  const pinHeightVh = pinRows.length > 0 ? 66 / pinRows.length : 0;

  /*
   * One reading is one region: a reading that replaces the `rsdt` blocks draws
   * them inside the panel that describes them, and a reading that keeps the
   * blocks leaves them under it. Either way the window still grows a page at a
   * time at the sentinel below the list.
   */
  const restBlocks = (vizGroups ?? restGroups).map((g, i) => (
    <div key={g.key} className="rest-group" style={clusterBlock(clustered, i)}>
      <RestGroupHead label={g.label} tag={g.tag} subs={g.subs} contributors={restContributors}
        details={restTagDetails} itemCount={g.items.length} />
      {g.items.map(renderBlockItems(g))}
      {g.subgroups?.map((s) => (
        <div key={s.key} className="rest-subgroup">
          <RestGroupHead label={s.label} level={2} />
          {s.items.map(renderBlockItems(s))}
        </div>
      ))}
    </div>
  ));

  /*
   * The list column, shared by the plain view and the wide one: the wide view is
   * this same list with the graph beside it, not a second rendering of it. The
   * button that opens that window belongs to the list, so the wide view drops it.
   */
  const restColumn = (
    <>
      <div className="rest-das">
        {profile && (
          <RestTuner
            grouper={restGrouper}
            hyper={hyper}
            onChange={(h) => setHyperState((s) => ({ ...s, [restGrouper]: h }))}
          />
        )}
        {!wide && (
          <button type="button" style={GRAPH_BUTTON} title={GRAPH_HELP} onClick={openRestGraph}>
            graph
          </button>
        )}
        {viz && (
          <RestViz grouper={restGrouper} mode={viz} rows={listedRest} reports={restTags}
            hyper={hyper} dyn={hyper?.dyn === true}>
            {vizGroups ? restBlocks : null}
          </RestViz>
        )}
        {vizGroups ? null : restBlocks}
      </div>
      <div ref={sentinelRef} className="load-more-trigger">
        {sentinelLabel}
        {sentinelAction && (
          <button style={LOAD_MORE_BUTTON} onClick={growOrRetry}>{sentinelAction}</button>
        )}
      </div>
    </>
  );

  return (
    <TipHost>
      <div className="card-tab" style={wide ? WIDE_ROW : undefined}>
        {!wide && pinRows.length > 0 && (
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

        {wide ? (
          <>
            <div style={WIDE_LEFT}>{restColumn}</div>
            <div style={WIDE_PANE}>{tagGraph ? <RestGraph graph={tagGraph} /> : null}</div>
          </>
        ) : restColumn}
      </div>
    </TipHost>
  );
}

/**
 * One clustered block's box. The reading is a list of tag keys, so a block has
 * no spacing of its own and a dotted rule is what tells it apart from the
 * cluster above; the first block opens the list, so it carries no rule.
 *
 * @param clustered - whether the blocks below come from the `clusters` reading.
 * @param index - block position, so the first one can drop the rule.
 * @returns The inline style, or undefined for the `rsdt` blocks.
 */
const clusterBlock = (clustered: boolean, index: number): React.CSSProperties | undefined =>
  clustered
    ? { margin: 0, padding: 0, ...(index > 0 ? { borderTop: '1px dotted rgba(255,255,255,0.18)' } : {}) }
    : undefined;

/**
 * One rest-block head; `level` 2 is a visit-time subgroup nested in a date
 * block. A tagged block heads with the tag itself — a chip whose right border is
 * dropped, so the box opens onto the rows that follow instead of closing them
 * off — and an empty label renders nothing, which is what the flat grouper
 * emits.
 *
 * A cluster head has no bar of its own in the panel, so its hover text is where
 * the tag is explained: the channels the pass scored it on, how many rows the
 * cluster holds, and the rows themselves.
 *
 * @param props.label - Heading text; the tag, for a tagged block.
 * @param props.tag - Tag the block clusters, when the block came from the
 *   `clusters` reading.
 * @param props.subs - Other tags the block's rows kept, listed beside the head.
 * @param props.contributors - Rows proposing each tag, for the head's hover text.
 * @param props.details - Best explanation of each tag, for the same hover text.
 * @param props.itemCount - Rows in the block, so the head names its own size.
 * @param props.level - 1 for a date block, 2 for a visit-time subgroup.
 * @returns The heading element.
 */
function RestGroupHead({ label, tag, subs, contributors, details, itemCount, level = 1 }: {
  label: string;
  tag?: string;
  subs?: RestSubTag[];
  contributors?: Map<string, Da[]>;
  details?: Map<string, VizTagDetail>;
  itemCount?: number;
  level?: 1 | 2;
}) {
  if (tag) {
    const rows = contributors?.get(tag) ?? [];
    const detail = details?.get(tag);
    const held = subs ?? [];
    const title = [
      ...(detail
        ? [explanationText(detail.explanation, { dim: detail.report.dim, window: detail.report.window })]
        : []),
      `${itemCount ?? rows.length} row(s) cluster on #${tag}`,
      ...(held.length === 0 ? [] : [
        `its rows also keep: ${held.map((s) => `#${s.tag} (${s.rows})`).join(' · ')}`,
      ]),
      ...(rows.length === 0 ? [] : [
        `suggested by ${rows.length}:`,
        ...rows.map((r) => r.txt || r.ref),
      ]),
    ].join('\n');
    /* The head is the cluster's key and the sub-tags are what it holds: the same
       box, the row chip's own promotion mark, so a promoted `head/theme` reads as
       minted rather than scored. A wide cluster stops at the cap and counts the
       rest, because the rows the head opens have to start somewhere on the line. */
    const shown = held.slice(0, CLUSTER_SUB_MAX);
    const rest = held.slice(shown.length);
    return (
      <>
        <span
          className="rest-cluster-head"
          title={title}
          style={{
            ...DYNAMIC_CHIP,
            color: tagCue(tag),
            borderColor: tagCue(tag),
            marginLeft: 0,
            borderRightStyle: 'none',
          }}
        >
          #{tag}
        </span>
        {shown.map((s) => (
          <span
            key={s.tag}
            className="rest-cluster-sub"
            title={`#${s.tag} — kept by ${s.rows} row(s) of this cluster`
              + `${s.sub ? ', minted by the aim pass as the burst’s theme' : ''}`}
            style={{
              ...DYNAMIC_CHIP,
              color: tagCue(s.tag),
              borderColor: tagCue(s.tag),
              ...(s.sub ? SUB_CHIP : {}),
            }}
          >
            #{s.tag}
          </span>
        ))}
        {rest.length > 0 && (
          <span
            className="rest-cluster-sub"
            title={`also kept by its rows: ${rest.map((s) => `#${s.tag} (${s.rows})`).join(' · ')}`}
            style={{ ...DYNAMIC_CHIP, opacity: 0.6 }}
          >
            +{rest.length}
          </span>
        )}
      </>
    );
  }
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
 * any other ref navigates; the caption is `txt` cropped by the shared
 * `.crop-scroll` rule, so the clip does not remove text from find.
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
      <button className="da-row crop-scroll" onClick={() => onJump(recrTargetOf(da.ref))}
        title={tip ? undefined : da.ref}
        {...(tip ? { [TIP_ATTR]: '', ref: (el: HTMLButtonElement | null) => setTip(el, da) } : {})}
        style={rowStyle} {...hover}>
        {preview}
      </button>
    );
  }
  if (isUrl) {
    return (
      <a className="da-row crop-scroll" href={da.ref} target="_blank" rel="noreferrer"
        title={tip ? undefined : title}
        {...(tip ? { [TIP_ATTR]: '', ref: (el: HTMLAnchorElement | null) => setTip(el, da) } : {})}
        style={rowStyle} {...hover}>
        {preview}
      </a>
    );
  }
  if (da.type === 'md') {
    return (
      <button className="da-row crop-scroll" onClick={() => onSelectTag(da.ref)}
        title={tip ? undefined : title}
        {...(tip ? { [TIP_ATTR]: '', ref: (el: HTMLButtonElement | null) => setTip(el, da) } : {})}
        style={rowStyle} {...hover}>
        {preview}
      </button>
    );
  }
  return (
    <Link className="da-row crop-scroll" to={da.ref} onClick={() => onSelectTag(da.ref)}
      title={tip ? undefined : title}
      {...(tip ? { [TIP_ATTR]: '', ref: (el: HTMLAnchorElement | null) => setTip(el, da) } : {})}
      style={rowStyle} {...hover}>
      {preview}
    </Link>
  );
}

/**
 * A `rstag` chip: a suggestion `srctag` found, not a tag the row carries. An
 * outline-only dotted border keeps it apart from the filled `#tag` buttons the
 * persisted tags render as. Border longhands rather than the `border` shorthand,
 * because the last chip of a strip unsets its right side. The native title
 * carries the channel breakdown and the rows that proposed the tag, so a chip
 * holds no state. The `help` cursor matches that: hovering explains, a chip has
 * nothing to click. A cluster head borrows the same box, with its right side
 * unset as well, so it opens onto the rows it leads.
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
 * Chip strip: the shared `.crop-scroll` window, so a row with many suggestions
 * cannot widen the list.
 */
const CHIP_STRIP: React.CSSProperties = {
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
    <span className="rest-tag-chips crop-scroll" style={CHIP_STRIP}>
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
