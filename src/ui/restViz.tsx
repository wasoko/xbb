/**
 * restViz.tsx — the panel `cardTab.tsx` mounts between the tuner and the blocks.
 *
 * The header is the same in every mode: how many rows the list holds, how many
 * the pass scored, how many kept nothing, and the tags-per-title histogram. The
 * body is the reading the tuner's `viz` switch selected — bars for the channels
 * a family weighs, the priority tags it reaches, the themes a burst shares, or
 * the surface forms the trie matched.
 *
 * The panel only draws. `clusters`, `priority` and `themes` also replace the
 * blocks, which `cardTab.tsx` builds from {@link vizBlocks} so every row still
 * appears exactly once; the panel hosts those blocks inside its own box, so one
 * reading is one region rather than a summary above a separate list.
 *
 * Bars are plain elements with inline styles, matching the rest of this UI: no
 * chart library, no stylesheet.
 */

import React, { useEffect, useState } from 'react';
import type { Da } from '../sdb';
import { TAG_CHANNEL_LABEL, type RowTagReport } from '../srctag';
import {
  REST_PROFILES, restDynAdapters, restDynCapable, restHyperScore, restVecStatus,
  type RestHyper, type RestVizMode,
} from './restGrouper';
import { VIZ_HELP, vizCaveat } from './restHelp';
import {
  channelShares, CLUSTER_MIN_ROWS, keywordHits, priorityCoverage, tagClusters, tagsPerTitle, themeGroups,
  type VizBar,
} from './restVizData';
import type { AdapterSet } from './srctagSmoke';

const PANEL: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  borderBottom: '1px dashed rgba(255,255,255,0.14)',
};

/**
 * The panel's own chrome: the small type and the padding its counts are read at.
 * A reading that brings its rows keeps them outside this box, so the rows render
 * at the size the rest list uses rather than at the panel's.
 */
const PANEL_CHROME: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '4px 6px',
  fontSize: '0.75em',
};

const ROW: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 };
const LABEL: React.CSSProperties = { opacity: 0.55 };
const HINT: React.CSSProperties = { opacity: 0.5, fontStyle: 'italic' };
const GROUP: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' };

const TRACK: React.CSSProperties = {
  position: 'relative',
  display: 'inline-block',
  width: 84,
  height: 8,
  borderRadius: 2,
  background: 'rgba(255,255,255,0.09)',
  verticalAlign: 'middle',
};

const FILL: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  borderRadius: 2,
  background: 'rgba(120,170,255,0.55)',
};

/** The hue a priority-backed bar is drawn in, so curated tags stand out. */
const PRIORITY_FILL = 'rgba(150,230,170,0.6)';

/**
 * One labelled bar.
 *
 * @param props.bar - the reading's bar.
 * @param props.tone - fill color, when the reading distinguishes bars.
 * @param props.note - trailing text after the value.
 * @param props.help - extra hover text after the bar's own numbers.
 * @returns The bar row element.
 */
function Bar({ bar, tone, note, help }: { bar: VizBar; tone?: string; note?: string; help?: string }) {
  return (
    <span style={GROUP} title={[`${bar.label}: ${bar.value} (${Math.round(bar.share * 100)}%)`, help]
      .filter(Boolean).join(' · ')}>
      <span style={TRACK}>
        <span style={{ ...FILL, width: `${Math.min(100, Math.round(bar.share * 100))}%`, ...(tone ? { background: tone } : {}) }} />
      </span>
      <span>{bar.label}</span>
      <span style={LABEL}>{bar.value}{note ?? ''}</span>
    </span>
  );
}

/**
 * The tags-per-title histogram: one bar per tag count, the untagged bucket first.
 *
 * @param props.buckets - bars from `tagsPerTitle`.
 * @returns The inline SVG element.
 */
function Histogram({ buckets }: { buckets: VizBar[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.value));
  const width = 12;
  return (
    <svg width={Math.max(1, buckets.length) * width} height={18} role="img" aria-label="tags per title">
      {buckets.map((b, i) => {
        const h = Math.max(2, Math.round((b.value / max) * 16));
        return (
          <rect key={b.label} x={i * width} y={18 - h} width={width - 3} height={h}
            fill="rgba(120,170,255,0.55)">
            <title>{`${b.label} tag(s): ${b.value} row(s)`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** The `rstag` `dyn` flag's status: which adapters loaded, and what the vec store holds. */
function AdapterStatus() {
  const [set, setSet] = useState<AdapterSet>();
  useEffect(() => {
    let live = true;
    void restDynAdapters().then((s) => { if (live) setSet(s); });
    return () => { live = false; };
  }, []);

  const vecs = restVecStatus();
  return (
    <div style={ROW}>
      <span style={LABEL}>adapters</span>
      <span>{set ? `${set.embed ? 'embed' : 'no embed'}, ${set.classify ? 'classify' : 'no classify'}` : 'loading…'}</span>
      {vecs && (
        <span style={LABEL}>
          vecs {vecs.model}: {vecs.primed} primed, {vecs.written} written
        </span>
      )}
      {set && set.errors.length > 0 && <span style={LABEL}>{set.errors.join(' · ')}</span>}
    </div>
  );
}

export interface RestVizProps {
  /** Grouper ref, for the panel's own label and the `rstag` adapter status. */
  grouper: string;
  /** Reading to render. */
  mode: RestVizMode;
  /** Rows below the pin cards, in list order. */
  rows: Da[];
  /** One report per scored row. */
  reports: Map<number, RowTagReport>;
  /** Live tuner override, for the family-aware caveat on a reading. */
  hyper?: RestHyper;
  /** Whether the pass ran with the store's adapters (`rstag`'s `dyn`). */
  dyn?: boolean;
  /**
   * The blocks of a reading that replaces the `rsdt` ones. The panel and the rows
   * it counts are one region, so the reading's own blocks render inside the panel
   * box; the caller renders none of its own in that case.
   */
  children?: React.ReactNode;
}

/**
 * The head of the panel: what the pass reached, and how thin its reading is.
 *
 * @param props.mode - the reading rendered, so the row names it.
 * @param props.rows - rows the list holds.
 * @param props.reports - one report per scored row.
 * @returns The header element.
 */
function Head({ mode, rows, reports }: { mode: RestVizMode; rows: Da[]; reports: Map<number, RowTagReport> }) {
  const head = tagsPerTitle(rows, reports);
  const kept = head.buckets.reduce((n, b) => n + (Number(b.label) > 0 ? b.value : 0), 0);
  const total = head.buckets.reduce((n, b) => n + b.value, 0);
  return (
    <div style={ROW} title={`${VIZ_HELP[mode]} — the header counts the rows the list holds, the rows the pass scored, and the tags each title kept`}>
      <span style={LABEL}>{mode}</span>
      <span>{head.rows} rows</span>
      <span>{head.scored} scored</span>
      <span>{head.untagged} untagged</span>
      <span style={GROUP}>
        <span style={LABEL}>tags/title</span>
        <Histogram buckets={head.buckets} />
        <span style={LABEL}>{total > 0 ? `${Math.round((kept / total) * 100)}% tagged` : 'none kept'}</span>
      </span>
    </div>
  );
}

/**
 * The `priority` reading's body: which tags the scored rows kept, and which of
 * those a curated tag carried.
 *
 * @param props.rows - rows the list holds.
 * @param props.reports - one report per scored row.
 * @returns The bars, most widespread tags first.
 */
function PriorityBody({ rows, reports }: { rows: Da[]; reports: Map<number, RowTagReport> }) {
  const { tagged, untagged, unscored, bars, topChannel } = priorityCoverage(rows, reports);
  const curated = bars.filter((b) => b.priority).length;
  /* A word one row keeps is not what the table is about, and on a list of
     mostly-distinct titles it is most of the bars: a thousand one-off chips
     would bury the few that repeat. The head is drawn and the tail counted. */
  const head = bars.filter((b) => b.value > 1);
  const once = bars.length - head.length;
  return (
    <>
      <div style={ROW}>
        <span>{tagged.length} rows on a priority tag</span>
        <span style={LABEL}>{untagged.length} no tag</span>
        <span style={LABEL}>{unscored.length} unscored</span>
        <span style={LABEL}>
          {`${bars.length} tags kept · ${curated} priority-backed · ${head.length} kept by more than one row — the bars below are those; \`topK\` shortens the list, \`stop\` and \`max df\` clean it`}
        </span>
      </div>
      <div style={ROW}>
        {head.length === 0
          ? <span style={LABEL}>{bars.length === 0
            ? 'no tag kept — the cut-off is above every score'
            : `every tag was kept by a single row — raise \`max df\` or the aim cut-off, or lower \`topK\``}</span>
          : head.map((b) => {
            const top = topChannel.get(b.label);
            return (
              <Bar key={b.label} bar={b} tone={b.priority ? PRIORITY_FILL : undefined}
                help={b.priority
                  ? 'priority-backed: a curated tag or a trie hit carried it'
                  : `not priority-backed — the row's own ${top ? TAG_CHANNEL_LABEL[top] : 'text'} score kept it`} />
            );
          })}
        {once > 0 && (
          <span style={LABEL} title="a tag one row keeps says what that row is about, not what the list is">
            {`+ ${once} kept by a single row`}
          </span>
        )}
      </div>
    </>
  );
}

/**
 * The `clusters` reading's body: what the list below is made of, and the counts
 * behind it. The bars of the `priority` reading are deliberately absent — a
 * cluster's head chip explains itself in its hover text, so a bar per tag would
 * say the same thing twice.
 *
 * @param props.rows - rows the list holds.
 * @param props.reports - one report per scored row.
 * @returns The reading's line and its counts.
 */
function ClusterBody({ rows, reports }: { rows: Da[]; reports: Map<number, RowTagReport> }) {
  const { tagged, untagged, unscored, bars } = priorityCoverage(rows, reports);
  const curated = bars.filter((b) => b.priority).length;
  const heads = tagClusters(rows, reports).filter((g) => g.tag !== undefined).length;
  return (
    <>
      <div style={LABEL}>
        {`the blocks below are one cluster per tag the rows kept, curated tags first — a tag kept by
fewer than ${CLUSTER_MIN_ROWS} rows is no cluster, so those rows trail with their own chips.
Each head lists the other tags its rows kept beside it, so a cluster says what it holds and
not only what filed it. Hover a head for the channels behind it and the rows it holds`}
      </div>
      <div style={ROW}>
        <span>{heads} clusters</span>
        <span style={LABEL}>{bars.length} tags kept · {curated} curated</span>
        <span style={LABEL}>{tagged.length} rows on a curated tag</span>
        <span style={LABEL}>{untagged.length} no tag · {unscored.length} unscored</span>
      </div>
    </>
  );
}

/** The reading the mode names, drawn as bars or as a term list. */
function Body({ mode, rows, reports }: { mode: RestVizMode; rows: Da[]; reports: Map<number, RowTagReport> }) {
  if (mode === 'chips') {
    return (
      <div style={LABEL}>
        the tag layer stays beside each row; every other reading replaces the blocks above
      </div>
    );
  }
  if (mode === 'clusters') {
    return <ClusterBody rows={rows} reports={reports} />;
  }
  if (mode === 'priority') {
    return <PriorityBody rows={rows} reports={reports} />;
  }
  if (mode === 'themes') {
    const { groups, unscored } = themeGroups(rows, reports);
    const shared = groups.filter((g) => g.shared.length > 0);
    return (
      <>
        <div style={ROW}>
          <span>{groups.length} bursts</span>
          <span style={LABEL}>{shared.length} carry a shared theme</span>
          <span style={LABEL}>{unscored.length} unscored</span>
        </div>
        {groups.filter((g) => g.shared.length > 0).slice(0, 12).map((g) => (
          <div key={g.key} style={ROW}>
            <span style={LABEL}>{g.anchor || '(untagged)'} · burst {g.cluster} · {g.items.length} rows</span>
            {g.shared.map((s) => <Bar key={s.label} bar={s} />)}
          </div>
        ))}
      </>
    );
  }
  if (mode === 'channels') {
    const bars = channelShares(reports);
    return (
      <div style={ROW}>
        {bars.length === 0
          ? <span style={LABEL}>nothing scored yet</span>
          : bars.map((b) => <Bar key={b.label} bar={b} />)}
      </div>
    );
  }
  const hits = keywordHits(rows, reports);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {hits.length === 0
        ? <span style={LABEL}>the trie matched nothing in these titles</span>
        : hits.slice(0, 20).map((h) => (
          <div key={`${h.tag}\u0000${h.form}`} style={ROW}>
            <span>#{h.tag}</span>
            <span style={LABEL}>“{h.form}” · {h.rows} row(s)</span>
            <span style={LABEL}>{h.titles[0]}</span>
          </div>
        ))}
    </div>
  );
}

/**
 * The tuning panel above the rest blocks, and the blocks themselves when the
 * reading replaces them.
 *
 * @param props.grouper - ref of the active grouper.
 * @param props.mode - reading to render.
 * @param props.rows - rows below the pin cards.
 * @param props.reports - one report per scored row.
 * @param props.hyper - live tuner override, for the caveat on a reading.
 * @param props.dyn - whether the pass loaded the store's adapters.
 * @param props.children - the reading's own blocks, when it has any.
 * @returns The panel, or nothing when the grouper has no tag pass.
 */
export function RestViz({ grouper, mode, rows, reports, hyper, dyn = false, children }: RestVizProps) {
  const profile = REST_PROFILES[grouper];
  const caveat = profile ? vizCaveat(mode, restHyperScore(profile, hyper)) : undefined;
  return (
    <div className="rest-viz" style={PANEL}>
      <div className="rest-viz-chrome" style={PANEL_CHROME}>
        <Head mode={mode} rows={rows} reports={reports} />
        {caveat && <div style={{ ...LABEL, ...HINT }} title={caveat}>{caveat}</div>}
        <Body mode={mode} rows={rows} reports={reports} />
        {/* Every family the `dyn` flag is offered on reports the adapters it loaded. */}
        {profile && restDynCapable(profile) && dyn && <AdapterStatus />}
      </div>
      {children}
    </div>
  );
}
