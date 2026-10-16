/**
 * seaRegion.ts — the wall read as regions: one rectangle per tag, packed to fill the
 * cylinder.
 *
 * The sea's first reading hung every tag on the wall as a star at a place: the pinned tags
 * and their spellings on a spine at the centre, the rest of the circle sliced among the
 * clusters. A star is a point, so that reading could say where a tag is but not how much of
 * the table it speaks for, and nothing of it could hold the rows themselves.
 *
 * This reading gives every tag a rectangle, and the rectangles tile the wall:
 *
 * - The pins hold a column at the centre, one band each, newest evidence at the top. A pin's
 *   spellings take a thin band along the bottom of its own band, so a spelling reads as
 *   belonging to the pin it spells rather than to the wall at large.
 * - Every other tag fills the two strips the column leaves, packed in shelves from the top
 *   down. A tag's width comes from the rows that kept it, its height then makes its area
 *   proportional to them, and a shelf is stretched — within {@link SEA_REGION.maxStretch} —
 *   to close its strip instead of leaving a ragged edge. The floors keep a tag a single row
 *   kept as readable as the pass's own page size allows.
 * - A tag answers for the cluster its strongest hop reaches, the hop `pinReach` counts, and
 *   a cluster's tags occupy one run of a strip, so turning away from the centre finds the
 *   same order the column holds. Clusters alternate between the two strips.
 *
 * The wall is a cylinder, so a strip stops at the seam rather than wrapping it: the column
 * sits on lon 0 and the strips hold the 132 degrees either side.
 *
 * Nothing here touches the DOM or three.js, so a packing is testable from a graph alone.
 */

import { pinReach, type AnyNodeKind, type TagGraph } from './restGraph';
import type { SeaCell, SeaPlace } from './seaSky';

/** Sizes the packing is built from, in degrees of wall. */
export interface SeaRegionShape {
  /** Degrees of wall the pins hold, centred on lon 0. */
  pinCol: number;
  /** Degrees between a band or shelf and the one below it. */
  shelfGap: number;
  /** Rise a pin's spellings share along the bottom of its band. */
  aliasBand: number;
  /** Square degrees of wall one kept row asks for. */
  areaPerRow: number;
  /** Width over height a region asks for its area in; the wall is wider than it is tall. */
  aspect: number;
  /** Narrowest and shortest a region is drawn, whatever it asked for. */
  minW: number;
  minH: number;
  /** Tallest a region is drawn, so one broad tag cannot take the whole view. */
  maxH: number;
  /** How far a shelf may be stretched to close its strip. */
  maxStretch: number;
  /** Regions placed at most; the pins always survive the cap. */
  maxRegions: number;
}

/**
 * The shape a call is packed with when it names none.
 *
 * These are the numbers a reader sees, so they are what to move when the wall reads wrong:
 * a bigger `areaPerRow` gives every tag more wall, a bigger `pinCol` gives the curated half
 * more of the centre and the clouds less, and the floors decide when a tag stops being a
 * readable cell and becomes a point on the reading's own scale.
 *
 * Measured over the newest 2222 rows of the live table (1 pin card, 22 headings, 4542 nodes,
 * 220 regions kept) in a 1032x691 view at the sea's opening field of view of 120 degrees:
 * a cloud region is 299x53 px at the median and never below 18x14 degrees, the widest pin
 * takes the column's whole 96 degrees at 114 px tall, 50 regions stand in front at once and
 * the packed wall runs 467 degrees of rise, a little over two screens.
 */
export const SEA_REGION: SeaRegionShape = {
  pinCol: 96,
  shelfGap: 6,
  aliasBand: 14,
  areaPerRow: 6,
  aspect: 2,
  minW: 18,
  minH: 14,
  maxH: 60,
  maxStretch: 1.8,
  maxRegions: 220,
};

/** One tag's rectangle on the wall, in the wall's own degrees. */
export interface SeaRegion {
  /** The tag itself, as the reading kept it. */
  tag: string;
  /** What part of the reading it came from; see `restGraph.pinReach`. */
  kind: AnyNodeKind;
  /** Scored rows that kept the tag. */
  rows: number;
  /** Degrees east of `+z`, `lon0 < lon1`, both inside `[-180, 180]`. */
  lon0: number;
  lon1: number;
  /** Degrees of wall, `rise0 < rise1`. The wall is read downwards, so `rise1` is the top. */
  rise0: number;
  rise1: number;
  /** The pinned tag this region answers for; absent on a pin and on a tag no pin reaches. */
  cluster?: string;
}

/** What a caller may override of the shape, plus how a tag is read. */
export interface SeaRegionOptions extends Partial<SeaRegionShape> {
  /** What each node is. Defaults to `pinReach`: how far it is from the pins. */
  kind?: (tag: string) => AnyNodeKind;
  /**
   * How new a tag's evidence is, `1` for the newest row of the seed. It orders the pins
   * alone: the column is the one part of the wall a reader scans in time order.
   */
  recency?: (tag: string) => number | undefined;
}

/** A number folded into `[lo, hi]`. */
const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

/** A number folded into `[0, 1]`, the range an evidence share is read in. */
const clamp01 = (n: number): number => clamp(n, 0, 1);

/**
 * The spine cluster a tag answers for: the strongest pinned tag within two hops of it.
 *
 * A hop is the same evidence `pinReach` counts, so a tag the seed rows held beside a pin
 * answers for that pin, and a tag two steps out answers for the pin the step between them
 * reaches. The heaviest hop wins, which keeps a tag held beside two pins in one cluster
 * rather than in both.
 *
 * @param graph the graph the tag came from
 * @param tag a tag that is not a pin itself
 * @param heads the pinned tags the column holds
 * @returns the cluster's pinned tag, or `null` when no pin is within two hops
 */
export function clusterOf(
  graph: TagGraph, tag: string, heads: ReadonlySet<string>,
): string | null {
  const near = graph.edges.get(tag);
  if (!near) return null;
  const heaviest = (from: Iterable<[string, number]>): string | null => {
    let best: string | null = null;
    let bestW = 0;
    for (const [n, w] of from) {
      if (!heads.has(n)) continue;
      if (best === null || w > bestW) { best = n; bestW = w; }
    }
    return best;
  };
  const one = heaviest(near);
  if (one !== null) return one;
  let best: string | null = null;
  let bestW = 0;
  for (const [m, w] of near) {
    const two = heaviest(graph.edges.get(m) ?? []);
    if (two !== null && w > bestW) { best = two; bestW = w; }
  }
  return best;
}

/**
 * The shape a call is packed with: the shipped defaults, overridden field by field.
 *
 * @param opts the call's own options
 * @returns the shape, complete
 */
function shapeOf(opts: SeaRegionOptions): SeaRegionShape {
  const out = { ...SEA_REGION };
  for (const key of Object.keys(SEA_REGION) as (keyof SeaRegionShape)[]) {
    const asked = opts[key];
    if (typeof asked === 'number') out[key] = asked;
  }
  return out;
}

/** Widest, then shortest, then alphabetical: the one order a region's own rows are read in. */
const byWeight = (weight: (tag: string) => number) =>
  (a: string, b: string): number => weight(b) - weight(a) || a.localeCompare(b);

/** What one strip of the wall is: where it starts, and how much of the circle it holds. */
interface Strip {
  lon0: number;
  width: number;
}

/**
 * Pack one strip of the wall, top down, into shelves.
 *
 * A shelf takes tags until the next one would not fit. The shelf is then stretched — up to
 * {@link SeaRegionShape.maxStretch} — so its regions close the strip between them instead of
 * stopping short of the seam. A shelf that cannot be stretched that far keeps its gap: the
 * stretch is what keeps a shelf tidy, and area proportional to rows is what the reading is
 * for.
 *
 * @param tags the strip's tags, in the order they are packed
 * @param strip the strip's own extent
 * @param rowsOf rows a tag was kept by
 * @param clusterOfTag the pin a tag answers for, for the region that records it
 * @param emit the caller's sink, told what the strip placed
 * @param shape the sizes to pack with
 * @returns the region every tag was given, top down
 */
function shelves(
  tags: string[],
  strip: Strip,
  rowsOf: (tag: string) => number,
  clusterOfTag: (tag: string) => string | undefined,
  emit: (tag: string, lon0: number, lon1: number, rise0: number, rise1: number, cluster?: string) => void,
  shape: SeaRegionShape,
): void {
  /** Wall a tag asks for, and the height that area needs at the width it gets. */
  const areaOf = (tag: string): number => shape.areaPerRow * Math.max(1, rowsOf(tag));
  const widthOf = (tag: string): number =>
    clamp(Math.sqrt(areaOf(tag) * shape.aspect), shape.minW, strip.width);

  let cursor = 0;
  let i = 0;
  while (i < tags.length) {
    const shelf: string[] = [];
    let wanted = 0;
    while (i < tags.length) {
      const w = widthOf(tags[i]);
      /* One region always enters a shelf, however narrow the strip; a tag whose width is
         the strip's own takes the shelf on its own. */
      if (shelf.length > 0 && wanted + w > strip.width) break;
      shelf.push(tags[i]);
      wanted += w;
      i++;
    }

    const stretch = Math.min(shape.maxStretch, strip.width / Math.max(1e-6, wanted));
    const widths = shelf.map((tag) => widthOf(tag) * stretch);
    const heights = shelf.map((tag, j) => clamp(areaOf(tag) / widths[j], shape.minH, shape.maxH));
    const shelfH = heights.reduce((m, h) => Math.max(m, shape.minH), shape.minH);

    /* Each region hangs from the shelf's own top edge at the height its area needs, so the
       stretch that widens a region narrows it by exactly as much and its area stays the
       rows' own. The shelf then clears the tallest of them, which is what leaves a shorter
       region's wall below it empty. */
    let lon = strip.lon0;
    shelf.forEach((tag, j) => {
      emit(tag, lon, lon + widths[j], cursor - heights[j], cursor, clusterOfTag(tag));
      lon += widths[j];
    });
    cursor -= shelfH + shape.shelfGap;
  }
}

/**
 * Read a tag graph as regions that fill the wall.
 *
 * @param graph the graph, as `restGraph.buildTagGraph` returns it
 * @param opts the sizes to pack with, the taxonomy to read it in, and how new each pin's
 *             evidence is
 * @returns every region placed, the column first and the strips after it
 */
export function seaRegions(graph: TagGraph, opts: SeaRegionOptions = {}): SeaRegion[] {
  const shape = shapeOf(opts);
  const reach = opts.kind === undefined ? pinReach(graph) : undefined;
  const kindOf = opts.kind ?? ((tag: string): AnyNodeKind =>
    reach?.get(tag) ?? (graph.roots.has(tag) ? 'pinned' : 'own'));
  const recency = (tag: string): number => clamp01(opts.recency?.(tag) ?? 0.5);
  const rowsOf = (tag: string): number => graph.weight.get(tag) ?? 0;

  const kept = [...graph.weight.keys()].sort((a, b) =>
    (Number(graph.roots.has(b)) - Number(graph.roots.has(a)))
    || (rowsOf(b) - rowsOf(a))
    || a.localeCompare(b));
  const tags = kept.slice(0, Math.max(shape.maxRegions, graph.roots.size));
  const held = new Set(tags);

  /* ── the three parts of the wall: the column, the spellings in it, and the strips ── */

  const pins: string[] = [];
  const spellings = new Map<string, string[]>();
  const clouds: string[] = [];
  for (const tag of tags) {
    if (graph.roots.has(tag)) {
      pins.push(tag);
      continue;
    }
    const anchor = graph.alias.get(tag);
    if (anchor !== undefined && graph.roots.has(anchor) && held.has(anchor)) {
      const list = spellings.get(anchor);
      if (list) list.push(tag);
      else spellings.set(anchor, [tag]);
      continue;
    }
    clouds.push(tag);
  }
  /* Newest evidence at the top, so the newest Das and titles are what the camera opens on. */
  const ordered = [...pins].sort((a, b) =>
    recency(b) - recency(a) || rowsOf(b) - rowsOf(a) || a.localeCompare(b));

  const out: SeaRegion[] = [];
  const push = (
    tag: string, lon0: number, lon1: number, rise0: number, rise1: number, cluster?: string,
  ): void => {
    out.push({
      tag, kind: kindOf(tag), rows: rowsOf(tag), lon0, lon1, rise0, rise1,
      ...(cluster === undefined ? {} : { cluster }),
    });
  };

  const band = shape.pinCol / 2;
  let cursor = 0;
  for (const pin of ordered) {
    const list = (spellings.get(pin) ?? []).sort(byWeight(rowsOf));
    const room = list.length > 0 ? shape.aliasBand : 0;
    const own = clamp(shape.areaPerRow * rowsOf(pin) / shape.pinCol, shape.minH, shape.maxH);
    const bottom = cursor - (own + room);
    /* The spellings take a band along the bottom of the pin's own band, split evenly: a
       spelling is kept by a handful of rows, so its own row count would divide the band
       into slivers. */
    const cellW = list.length > 0 ? shape.pinCol / list.length : 0;
    list.forEach((tag, i) => {
      push(tag, -band + cellW * i, -band + cellW * (i + 1), bottom, bottom + room, pin);
    });
    push(pin, -band, band, bottom + room, cursor);
    cursor = bottom - shape.shelfGap;
  }

  /* ── the strips: a cluster's tags in one run, alternating either side of the column ── */

  const pinSet = new Set(pins);
  const runs = new Map<string, string[]>();
  const clusterOfTag = new Map<string, string>();
  const loose: string[] = [];
  for (const tag of clouds) {
    const cluster = clusterOf(graph, tag, pinSet);
    if (cluster === null) {
      loose.push(tag);
      continue;
    }
    clusterOfTag.set(tag, cluster);
    const list = runs.get(cluster);
    if (list) list.push(tag);
    else runs.set(cluster, [tag]);
  }

  const west: string[] = [];
  const east: string[] = [];
  ordered.forEach((pin, i) => {
    (i % 2 === 0 ? west : east).push(...(runs.get(pin) ?? []).sort(byWeight(rowsOf)));
  });
  /* A tag no pin reaches is the tail of the east strip: it belongs to no cluster, and the
     end of the reading is where a reader looks last. */
  east.push(...loose.sort(byWeight(rowsOf)));

  const stripW = 180 - band;
  const clusterTag = (tag: string): string | undefined => clusterOfTag.get(tag);
  if (west.length > 0) shelves(west, { lon0: -180, width: stripW }, rowsOf, clusterTag, push, shape);
  if (east.length > 0) shelves(east, { lon0: band, width: stripW }, rowsOf, clusterTag, push, shape);

  return out;
}

/** The middle of a region, which is where its star and its watermark are anchored. */
export function regionCentre(region: SeaRegion): SeaPlace {
  return { lon: (region.lon0 + region.lon1) / 2, rise: (region.rise0 + region.rise1) / 2 };
}

/** Square degrees of wall a region holds; what its star is sized by. */
export function regionArea(region: SeaRegion): number {
  return (region.lon1 - region.lon0) * (region.rise1 - region.rise0);
}

/** How much of a region the screen has room for. */
export type SeaTier = 'blocks' | 'label' | 'point';

/**
 * The screen the tiers are decided on: the areas a reading needs, and how many of each a
 * view may carry at once.
 *
 * The floors are the safety net — a cell has to be this many pixels before anything but a
 * point can be read in it — and the budgets are what actually bites: the whole wall stands
 * in front of a wide view, so what a reader sees is decided by how much of it the view can
 * hold rather than by how big any one region is.
 *
 * Measured over the live table's own packing (220 regions, 50 in front of a 1032x691 view at
 * the sea's opening field of view): 23 pinned regions and 27 clouds stand in front, of which
 * 8 clouds are the widest. The floors are set below a one-row cloud's own 299x53 px, so the
 * budgets are what a big screen spends and the floors are what a small one falls back to.
 */
export interface SeaLimits {
  /** Screen area a region needs before it shows the rows it stands for. */
  blockPx: number;
  /** Screen area a region needs before it shows its own name at all. */
  pointPx: number;
  /** Regions that may show their rows at once, the pinned ones included. */
  blocks: number;
  /** Regions that may show their names at once, the pinned ones included. */
  labels: number;
}

/**
 * The screen a reading is shown on when a caller names none.
 *
 * The floors are what one region's own box decides, the budgets what the screen as a whole
 * decides, and both count the pinned regions: the column of pins is what crowds a view, so a
 * budget they did not spend would never be reached on the table this wall is read from.
 *
 * Measured over the newest 2222 rows of the live table at the sea's opening field of view:
 * a 1032x691 view shows 12 pinned regions at 443x73 px and 3 clouds at 155x49 px, so the
 * clouds keep their names there and lose them on a phone-sized view, where the same cells
 * project to 63x50 px; a view that showed every visible tag's rows would be a page of boxes,
 * so the 8 row budgets go to the pins first.
 */
export const SEA_LIMITS: SeaLimits = {
  blockPx: 14000,
  pointPx: 4000,
  blocks: 8,
  labels: 24,
};

/** The size a region shows at, in CSS pixels, as a renderer projected it. */
export interface SeaBox {
  w: number;
  h: number;
}

/**
 * The tier every region is drawn at, from the screen box it was given.
 *
 * The screen is spent widest box first, because a region a reader can see is worth more than
 * one they cannot. The curated half is never the one that gives way — a pin and its spellings
 * are what the wall is read for — but it does spend the budgets: a column of twenty-two pins
 * leaves no room for a cloud to open its rows, and what is left of the screen is a name per
 * cloud while a name fits, and a point once it does not.
 *
 * @param regions the wall's regions
 * @param boxes the screen box each visible region was given, in pixels
 * @param limits the screen's own floors and budgets
 * @returns the tier of every region that has a box
 */
export function regionTiers(
  regions: SeaRegion[],
  boxes: ReadonlyMap<string, SeaBox>,
  limits: SeaLimits = SEA_LIMITS,
): Map<string, SeaTier> {
  const out = new Map<string, SeaTier>();
  const visible: { region: SeaRegion; area: number }[] = [];
  for (const region of regions) {
    const box = boxes.get(region.tag);
    if (box === undefined) continue;
    visible.push({ region, area: Math.max(0, box.w) * Math.max(0, box.h) });
  }
  visible.sort((a, b) => b.area - a.area);

  let blocks = 0;
  let labels = 0;
  for (const { region, area } of visible) {
    const curated = isCurated(region.kind);
    /* A box too small to hold a name holds nothing: the point is the region's own mark, and
       a hover or a tap opens the rows it stands for. */
    if (area < limits.pointPx) {
      out.set(region.tag, 'point');
      continue;
    }
    if (curated || (area >= limits.blockPx && blocks < limits.blocks)) {
      blocks++;
      out.set(region.tag, 'blocks');
      continue;
    }
    if (labels < limits.labels) {
      labels++;
      out.set(region.tag, 'label');
      continue;
    }
    out.set(region.tag, 'point');
  }
  return out;
}

/** Width of one character of the region's own name, as a fraction of its font size. */
const LABEL_EM = 0.6;

/** Smallest and largest a region's name is drawn, in pixels. */
const LABEL_MIN = 11;
const LABEL_MAX = 220;

/**
 * The size a region's own name is drawn at, in pixels.
 *
 * The name fills its region: as wide as the box across when the characters are that many
 * ems, and most of the box down when the box is short, whichever is smaller. A name longer
 * than its region is cropped by the box rather than shrunk past reading size, which is what
 * keeps the whole wall legible at one glance.
 *
 * @param w the region's screen width in pixels
 * @param h the region's screen height in pixels
 * @param chars characters in the name, `#` included
 * @returns the font size in pixels, within {@link LABEL_MIN} and {@link LABEL_MAX}
 */
export function labelFontPx(w: number, h: number, chars: number): number {
  const across = w / Math.max(1, chars * LABEL_EM);
  return clamp(Math.min(across, h * 0.86), LABEL_MIN, LABEL_MAX);
}

/**
 * The region a place falls in, the one whose own rectangle holds it.
 *
 * @param regions the wall's regions
 * @param at a place on the wall
 * @returns the region holding that place, or `null` for a gap or a place off the wall
 */
export function regionAt(regions: SeaRegion[], at: SeaPlace): SeaRegion | null {
  for (const r of regions) {
    if (at.lon < r.lon0 || at.lon > r.lon1) continue;
    if (at.rise < r.rise0 || at.rise > r.rise1) continue;
    return r;
  }
  return null;
}

/**
 * The regions a grid cell overlaps, widest first.
 *
 * A cell readout lists what a reader pointed at; the regions tile the wall, so what a cell
 * holds is every rectangle it touches rather than the tags whose middles happen to fall
 * inside it.
 *
 * @param regions the wall's regions
 * @param cell the cell the pointer selected
 * @returns the regions it overlaps, most-kept first
 */
export function regionsInCell(regions: SeaRegion[], cell: SeaCell): SeaRegion[] {
  return regions
    .filter((r) => r.lon0 < cell.lonMax && r.lon1 > cell.lonMin
      && r.rise0 < cell.riseMax && r.rise1 > cell.riseMin)
    .sort((a, b) => b.rows - a.rows || a.tag.localeCompare(b.tag));
}

/** Whether a region holds the curated half: a pin, or a spelling of one. */
export const isCurated = (kind: AnyNodeKind): boolean => kind === 'pinned' || kind === 'alias';

