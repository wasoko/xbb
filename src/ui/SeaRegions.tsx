/**
 * SeaRegions.tsx — the wall's regions as DOM: a tag's own name across its rectangle, the rows
 * it stands for in a cropped box, or a point that opens on hover.
 *
 * The canvas draws the wall and its marks; this layer draws what a reader reads and touches.
 * It is DOM rather than geometry for the two things three.js cannot give: text a browser can
 * find with find-in-page, and rows that are links.
 *
 * The frame loop owns where every box is. It projects the region's own four corners and
 * writes the element's transform, width, height and clip, so a pan costs style writes and no
 * React render; React owns what each box *is*, which follows the tier the loop publishes when
 * the screen has changed enough to change it. The layer itself takes no pointer, so a drag
 * anywhere pans the wall as it does on an empty stretch of grid; only a row and a point do.
 *
 * A cloud region's rows are the ones the seed already scored, so drawing them costs no query.
 * A pinned region is the subject rather than a sample of it, so it asks the tag index for its
 * own rows instead — the same query, and the same row box, the pin card itself draws.
 */

import React, { useState } from 'react';
import { getColorChar11 } from '../fc';
import type { Da } from '../sdb';
import { isCurated, type SeaRegion, type SeaTier } from './seaRegion';
import { MatchRow, TagMatchList } from './cs1';

/**
 * Rows one region's box holds before it stops and counts the rest.
 *
 * A region is a window onto the wall rather than a list: the reader who wants the whole tail
 * of a tag opens its refs, and the preview behind a row is one hover away.
 */
const BLOCK_ROWS = 12;

/** One region to draw, with the tier the frame loop gave it. */
export interface SeaRegionView {
  region: SeaRegion;
  tier: SeaTier;
}

/**
 * The layer the regions are drawn in: over the canvas, out of the pointer's way, and sized to
 * the screen so a box can be placed anywhere on it.
 */
const LAYER: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1, pointerEvents: 'none', overflow: 'hidden',
  userSelect: 'none',
};

/**
 * One region's box. The frame loop writes its transform and size; what is written here is
 * only what it is, so the two never fight over the same property.
 */
const BOX: React.CSSProperties = {
  position: 'absolute', left: 0, top: 0, visibility: 'hidden', pointerEvents: 'none',
  overflow: 'hidden', fontFamily: 'ui-sans-serif, system-ui, sans-serif',
};

/**
 * A region's own name: one bold line across the box, in the tag's own hue and faint enough
 * that the rows over it stay the thing being read. The full text stays in the DOM past the
 * crop, so find-in-page still finds a tag the box cannot show.
 */
const LABEL: React.CSSProperties = {
  display: 'block', fontWeight: 700, lineHeight: 1, whiteSpace: 'nowrap',
  overflow: 'hidden', letterSpacing: '-0.02em', opacity: 0.22,
};

/**
 * The box a region is drawn in: the tag's own colour, faint enough to be a wall rather than a
 * chip, so the treemap's cells read as cells while the rows over them stay legible.
 *
 * The hue is the same one the app's tag buttons and chips use, so a tag reads as itself
 * wherever it appears; the frame loop owns the box's own transform and size.
 */
const boxOf = (tag: string): React.CSSProperties => ({
  ...BOX,
  '--sea-hue': getColorChar11(tag),
  background: 'color-mix(in srgb, var(--sea-hue) 7%, transparent)',
} as React.CSSProperties);

/** A point: the mark a region too small for its own name is drawn as. */
const DOT: React.CSSProperties = {
  display: 'block', width: 9, height: 9, borderRadius: '50%',
  boxShadow: '0 0 6px currentColor',
};

/** The rows a region shows: the pin card's own cropped boxes, stacked in the region's box. */
const ROWS: React.CSSProperties = {
  position: 'absolute', left: 0, bottom: 0, maxWidth: '100%', maxHeight: '70%',
  overflow: 'hidden', pointerEvents: 'auto', fontSize: 13, lineHeight: '16px',
};

/** What a point opens into: the same rows, hung under the dot and read on a dark panel. */
const REVEAL: React.CSSProperties = {
  ...ROWS, position: 'absolute', left: 0, top: 12, bottom: 'auto', maxHeight: 'none',
  zIndex: 3, padding: '4px 6px', borderRadius: 8, background: 'rgba(4,6,10,0.92)',
  border: '1px solid rgba(255,255,255,0.18)', backdropFilter: 'blur(8px)',
  whiteSpace: 'nowrap', width: 'max-content', maxWidth: 320,
};

/** The `+N` chip: what a box's crop leaves out, named on hover. */
const MORE: React.CSSProperties = {
  color: 'rgba(230,236,244,0.7)', fontSize: 11, marginLeft: 4, cursor: 'help',
  pointerEvents: 'auto',
};

/**
 * The rows one region stands for.
 *
 * @param props.region - The region whose rows are drawn.
 * @param props.seed - Rows the seed's pass kept per tag, for a cloud's own box.
 * @param props.onOpenRef - Opens a row's ref.
 * @returns The cropped rows, or nothing when the region has none.
 */
function RegionRows({ region, seed, onOpenRef }: {
  region: SeaRegion;
  seed: ReadonlyMap<string, Da[]>;
  onOpenRef: (ref: string) => void;
}) {
  if (isCurated(region.kind)) {
    /* A pin is read for its own rows rather than for a sample of them, so the index is
       asked, exactly as the pin card asks it. A tag the pass kept for rows that never
       persisted it has no index entry, and the seed's own rows are what is left. */
    return (
      <TagMatchList
        tags={[region.tag]}
        limit={BLOCK_ROWS}
        onSelectTag={onOpenRef}
        fallback={seed.get(region.tag)}
      />
    );
  }
  const rows = seed.get(region.tag) ?? [];
  return (
    <>
      {rows.slice(0, BLOCK_ROWS).map((d) => (
        <MatchRow key={`${d.ref}\u0000${String(d.tid)}`} da={d} onSelectTag={onOpenRef} />
      ))}
      {rows.length > BLOCK_ROWS && (
        <span style={MORE} title={rows.slice(BLOCK_ROWS).map((d) => d.txt || d.ref).join('\n')}>
          +{rows.length - BLOCK_ROWS}
        </span>
      )}
    </>
  );
}

/**
 * One region: a name across its box, the rows under it, or a point that opens on hover and on
 * a tap.
 *
 * A point opens its rows rather than paging the wall: the point is a region the view had no
 * room to name, and the one thing a reader asked of it is what is under it.
 *
 * @param props.view - The region and the tier it was given.
 * @param props.seed - Rows the seed's pass kept per tag.
 * @param props.onOpenRef - Opens a row's ref.
 * @param props.register - Hands the box to the frame loop, and `null` when it unmounts.
 * @returns The region's element.
 */
function Region({ view, seed, onOpenRef, register }: {
  view: SeaRegionView;
  seed: ReadonlyMap<string, Da[]>;
  onOpenRef: (ref: string) => void;
  register: (tag: string, el: HTMLDivElement | null) => void;
}) {
  const { region, tier } = view;
  const [open, setOpen] = useState(false);

  if (tier === 'point') {
    return (
      <div
        ref={(el) => register(region.tag, el)}
        className="sea-region sea-region-point"
        style={boxOf(region.tag)}
        data-tag={region.tag}
        title={`#${region.tag} — ${region.rows} scored row(s) kept it`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen((held) => !held)}
      >
        <span style={{ ...DOT, pointerEvents: 'auto', color: 'rgba(230,236,244,0.75)' }} />
        {open && (
          <div style={REVEAL}>
            <RegionRows region={region} seed={seed} onOpenRef={onOpenRef} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={(el) => register(region.tag, el)}
      className={`sea-region sea-region-${tier}`}
      style={boxOf(region.tag)}
      data-tag={region.tag}
    >
      <span style={{ ...LABEL, color: 'var(--sea-hue)' }}>{`#${region.tag}`}</span>
      {tier === 'blocks' && (
        <div style={ROWS}>
          <RegionRows region={region} seed={seed} onOpenRef={onOpenRef} />
        </div>
      )}
    </div>
  );
}

/**
 * The wall's regions, as the boxes a reader reads and clicks.
 *
 * @param props.views - The regions that stand in front, with the tier each was given; the
 *                      frame loop publishes this list when it changes.
 * @param props.seed - Rows the seed's pass kept per tag.
 * @param props.onOpenRef - Opens a row's ref in the editor pane.
 * @param props.register - Hands each region's element to the frame loop.
 * @returns The layer the boxes are drawn in.
 */
export function SeaRegions({ views, seed, onOpenRef, register }: {
  views: SeaRegionView[];
  seed: ReadonlyMap<string, Da[]>;
  onOpenRef: (ref: string) => void;
  register: (tag: string, el: HTMLDivElement | null) => void;
}) {
  return (
    <div className="sea-regions" style={LAYER}>
      {views.map((view) => (
        <Region
          key={view.region.tag}
          view={view}
          seed={seed}
          onOpenRef={onOpenRef}
          register={register}
        />
      ))}
    </div>
  );
}
