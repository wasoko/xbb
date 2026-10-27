/**
 * seaWall.ts — the tag canvas on the cylinder, from the table out.
 *
 * The star sits on the front meridian at sea level. The recent band starts at that
 * meridian and runs screen-left: the tags the newest part of the seed keeps, one column
 * each, with their one-hop neighbours tiled below them. The pinned band runs screen-right
 * from the same meridian: one column per top level pin-card heading, and the tags the next
 * heading level names tile below their parent as a treemap. Both bands hang down from sea
 * level. The remaining tags tile the rear half of the cylinder, hidden behind the origin
 * until a horizontal spacing change brings them round.
 *
 * Every cell scatters the rows that kept it as link points, and no cell lists its rows as
 * text. Above the horizon the same canvas is mirrored as a reflection: the same tags,
 * dark and unlabelled, catching the star's light.
 *
 * Nothing is sampled or invented. A region exists because the table holds the tag, and a
 * link point exists because a row carried it. Spacing is the renderer's business; this
 * module lays the wall out in degrees.
 */

import type { AnyNodeKind, GraphNodeKind, TagGraph } from './restGraph';
import { cropText, type SeaPin, type SeaRow, type SeaTag } from './seaTags';
import { SEA_REGION, clusterOf, type SeaRegionOptions, type SeaRegionShape } from './seaRegion';
import { pinReach } from './restGraph';
import type { EmergingTag } from './seaTrend';
/** Characters a tag keeps in its wall label. */
export const WALL_TAG_CROP = 26;

/** One link point on the wall: a row, at the place near its tag's region. */
export interface WallPoint {
  key: string;
  /** The tag whose region the point sits in. */
  tag: string;
  ref: string;
  text: string;
  label: string;
  action: SeaRow['action'];
  /** Whether the point belongs to the mirrored half. */
  above: boolean;
  /** Degrees east of `+z`, in the packing's own coordinates. */
  lon: number;
  /** Degrees above sea level, in the packing's own coordinates. */
  rise: number;
  /** Newest visit or sync stamp of the row, in epoch ms. */
  stamp?: number;
  /** Newest-to-oldest share over the wall, `1` for the newest and absent when no stamp. */
  recency?: number;
}

/** Which part of the wall a region belongs to. */
export type WallSide = 'pin' | 'recent' | 'tail';

/** One tag's rectangle on the wall, with the rows that keep it. */
export interface WallRegion {
  key: string;
  tag: string;
  /** What `pinReach` calls the tag. */
  reach: AnyNodeKind;
  /** What the pass did with it: pinned, head, theme or own. */
  nature: GraphNodeKind;
  weight: number;
  score: number;
  freq: number;
  lambda?: number;
  burst?: number;
  top?: string;
  lon0: number;
  lon1: number;
  rise0: number;
  rise1: number;
  /** Whether the region belongs to the mirrored half above sea level. */
  above: boolean;
  /** Whether the region is the reflection of a tag below the horizon. */
  reflection: boolean;
  /** The one pin at rise 0 that carries the star. */
  star: boolean;
  /** Which half of the wall this rectangle belongs to. */
  side: WallSide;
  /** `0` for a top-level column head, `1` for a child treemap cell. */
  depth: 0 | 1;
  /** The top-level tag a child cell stands under. */
  parent?: string;
  /** Whether the region draws its name; only a reflection does not. */
  label: boolean;
  /** The pinned heading this region answers for. */
  pin?: string;
  /** Recent trend score, on a recent-band region. */
  trend?: number;
  labelText: string;
  /** The rows a reader can open. */
  rows: SeaRow[];
  /** The rows drawn as points inside the region. */
  points: WallPoint[];
}

/** The wall, ready for a renderer. */
export interface SeaWall {
  regions: WallRegion[];
  pins: WallRegion[];
  /** Top-level recent-band columns, strongest first. */
  recent: WallRegion[];
  points: WallPoint[];
  /** The star's place: the front meridian, exactly at sea level. */
  star: {
    lon: number;
    rise: number;
    pin: string | null;
    /** Newest-to-oldest share of the star tag's rows; absent when it kept none. */
    recency?: number;
  };
  /** Furthest packed rise above and below sea level, in degrees. */
  above: number;
  below: number;
  /** The continuous arc the rear tail tiles, in unwrapped degrees. */
  arc: { start: number; end: number };
}

/** How a wall is built. */
export interface WallOptions extends SeaRegionOptions {
  /**
   * The pin cards the wall is rooted at, newest first. Every top level heading takes a
   * column and the next heading level tiles below it. The newest card's first column
   * starts on the star meridian and the rest read screen-right; omitted or empty, the
   * graph's roots stand one column each in the same order.
   */
  pins?: readonly SeaPin[];
  /** Cloud tags kept before the tail is left to the hover card; defaults to 220. */
  maxClouds?: number;
  /** Recent-band tags to draw, strongest first; omitted leaves the right side empty. */
  emerging?: readonly EmergingTag[];
}

/**
 * Degrees of wall the pinned band may take. Past this the columns narrow instead of the band
 * growing, so the right recent band and the rear tail keep their own wall.
 */
const PIN_BAND_MAX = 120;

/** Degrees of wall the recent band may take, capped so the rear tail keeps a visible arc. */
const RECENT_BAND_MAX = 120;

/** One top-level heading's column, and the next heading level under it. */
interface PinColumn {
  /** Tags the heading names; they stack down the column. */
  tags: string[];
  /** The next heading level's tags, drawn as the column's treemap. */
  children: string[];
}

/** One card's columns, before the band places them: its top level headings and its date. */
interface PinGroup {
  /** The card's date, or the tag's recency when no card named it; newer stands nearer the star. */
  rank: number;
  /** One entry per top level heading, the tags it stacks in its column, in card order. */
  columns: PinColumn[];
}

/**
 * Order the groups newest first, the order the band reads rightwards from the star.
 *
 * Equal ranks keep their given order.
 *
 * @param groups the cards, in any order
 * @returns the cards newest first
 */
function newestFirst(groups: readonly PinGroup[]): PinGroup[] {
  return [...groups].sort((a, b) => b.rank - a.rank);
}

/** The shape a call is packed with: the sea region defaults, overridden field by field. */
function shapeOf(opts: WallOptions): SeaRegionShape {
  const out = { ...SEA_REGION };
  for (const key of Object.keys(SEA_REGION) as (keyof SeaRegionShape)[]) {
    const asked = opts[key];
    if (typeof asked === 'number') out[key] = asked;
  }
  return out;
}

/** A number folded into `[lo, hi]`. */
const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

/** A 32-bit hash of a string, so a tag's points fall in the same place every time. */
function hashTag(tag: string): number {
  let h = 2166136261;
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A small deterministic generator, for scattering a region's points. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A cloud tag, with the pin it answers for. */
interface Cloud {
  tag: string;
  weight: number;
  reach: AnyNodeKind;
  nature: GraphNodeKind;
  pin?: string;
}

/** One placed cloud rectangle before the rows are attached. */
interface Placed {
  cloud: Cloud;
  lon0: number;
  lon1: number;
  rise0: number;
  rise1: number;
}

/** One rectangle the shelf packer placed, before the caller adds its own fields. */
interface PackedCell<T> {
  item: T;
  lon0: number;
  lon1: number;
  rise0: number;
  rise1: number;
}

/**
 * Tile one strip of the wall with weighted cells, shelf by shelf.
 *
 * Each shelf is stretched to the strip exactly, so a strip closes all the way across
 * instead of leaving the last gap short. A cell's area follows its weight, so widening a
 * shelf narrows the cells it holds.
 *
 * @param items the cells, in packing order
 * @param shape the packing sizes
 * @param lonStart the strip's first longitude
 * @param width the strip's width in degrees
 * @returns the placed rectangles, top shelf first
 */
function tileCells<T extends { weight: number }>(
  items: readonly T[], shape: SeaRegionShape, lonStart: number, width: number,
): PackedCell<T>[] {
  const areaOf = (item: T): number => shape.areaPerRow * Math.max(1, item.weight);
  const widthOf = (item: T): number =>
    clamp(Math.sqrt(areaOf(item) * shape.aspect), shape.minW, width);

  const out: PackedCell<T>[] = [];
  let cursor = 0;
  let i = 0;
  while (i < items.length) {
    const shelf: T[] = [];
    let wanted = 0;
    while (i < items.length) {
      const w = widthOf(items[i]);
      if (shelf.length > 0 && wanted + w > width) break;
      shelf.push(items[i]);
      wanted += w;
      i++;
    }
    if (shelf.length === 0) break;
    const stretch = width / Math.max(1e-6, wanted);
    const widths = shelf.map((item) => widthOf(item) * stretch);
    const heights = shelf.map((item, j) =>
      clamp(areaOf(item) / Math.max(1e-6, widths[j]), shape.minH, shape.maxH));
    const shelfH = heights.reduce((m, h) => Math.max(m, h), shape.minH);

    let lon = lonStart;
    shelf.forEach((item, j) => {
      out.push({
        item,
        lon0: lon,
        lon1: lon + widths[j],
        rise0: cursor - heights[j],
        rise1: cursor,
      });
      lon += widths[j];
    });
    cursor -= shelfH + shape.shelfGap;
  }
  return out;
}

/**
 * Tile one arc of the wall with the clouds.
 *
 * @param clouds the cloud tags, in cluster order
 * @param shape the packing sizes
 * @param arcStart the arc's first longitude
 * @param arcWidth the arc's width in degrees
 * @returns the placed rectangles, top shelf first
 */
function tileClouds(
  clouds: readonly Cloud[], shape: SeaRegionShape, arcStart: number, arcWidth: number,
): Placed[] {
  return tileCells(clouds, shape, arcStart, arcWidth).map((cell) => ({
    cloud: cell.item,
    lon0: cell.lon0,
    lon1: cell.lon1,
    rise0: cell.rise0,
    rise1: cell.rise1,
  }));
}

/**
 * Scatter a region's rows inside the wall it owns.
 *
 * Every row is placed: the point count is the evidence, and a crowded cell is the renderer's
 * business, not a reason to drop a link. The rows are laid on a jittered grid shaped like the
 * cell, so a sparse cell spreads its few stars apart and a dense one fills its area evenly.
 *
 * @param region the rectangle
 * @param rows the rows to place
 * @param above whether the points belong to the reflected half
 * @returns the placed points
 */
function scatter(
  region: { tag: string; lon0: number; lon1: number; rise0: number; rise1: number },
  rows: readonly SeaRow[], above: boolean,
): WallPoint[] {
  const rng = mulberry32(hashTag(region.tag));
  const width = region.lon1 - region.lon0;
  const height = region.rise1 - region.rise0;
  const padX = Math.min(width * 0.18, 4);
  const padY = Math.min(height * 0.18, 4);
  const innerW = Math.max(0, width - padX * 2);
  const innerH = Math.max(0, height - padY * 2);
  const n = rows.length;
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * Math.max(1e-6, width / Math.max(1e-6, height))))));
  const band = Math.max(1, Math.ceil(n / cols));
  const out: WallPoint[] = [];
  rows.forEach((row, i) => {
    const col = i % cols;
    const line = Math.floor(i / cols);
    const lon = region.lon0 + padX + innerW * ((col + rng()) / cols);
    const rise = region.rise1 - padY - innerH * ((line + rng()) / band);
    out.push({
      key: `${region.tag}:${row.key}`,
      tag: region.tag,
      ref: row.ref,
      text: row.text,
      label: row.label,
      action: row.action,
      above,
      lon,
      rise,
      ...(row.stamp === undefined ? {} : { stamp: row.stamp }),
    });
  });
  return out;
}

/**
 * Build the wall around sea level.
 *
 * The star is the split meridian: recent columns begin at longitude 0 and run screen-left,
 * pinned columns end there and run screen-right, and the tail occupies the rear half.
 *
 * @param graph the tag graph
 * @param tags the taxonomy table
 * @param rowsOf the rows a tag was kept by
 * @param opts packing overrides, the pin cards, the recent columns and the cloud cap
 * @returns the regions, the pins, the recent columns, the link points and the star
 */
export function buildWall(
  graph: TagGraph, tags: readonly SeaTag[], rowsOf: (tag: string) => readonly SeaRow[],
  opts: WallOptions = {},
): SeaWall {
  const shape = shapeOf(opts);
  const stats = new Map(tags.map((tag) => [tag.tag, tag]));
  const reach = pinReach(graph);
  const recency = (tag: string): number => opts.recency?.(tag) ?? 0.5;
  const maxClouds = opts.maxClouds ?? 220;

  const reachOf = (tag: string): AnyNodeKind =>
    reach.get(tag) ?? (graph.roots.has(tag) ? 'pinned' : 'own');
  const natureOf = (tag: string): GraphNodeKind => stats.get(tag)?.kind ?? graph.kind.get(tag) ?? 'own';
  const weightOf = (tag: string): number => stats.get(tag)?.weight ?? graph.weight.get(tag) ?? 0;

  const entries: WallRegion[] = [];
  const points: WallPoint[] = [];
  let above = 0;
  let below = 0;

  type RegionInput = Omit<WallRegion, 'above' | 'reflection' | 'star' | 'label' | 'points'>
    & { star?: boolean; label?: boolean };
  const addRegion = (input: RegionInput): WallRegion => {
    const region: WallRegion = {
      ...input,
      above: false,
      reflection: false,
      star: input.star ?? false,
      label: input.label ?? true,
      points: [],
    };
    region.points = scatter(region, region.rows, false);
    points.push(...region.points);
    below = Math.min(below, region.rise0);
    entries.push(region);
    return region;
  };

  /* ── the pinned band: top level headings start at lon 0 and run screen-right ── */

  const pinTags = [...graph.roots]
    .filter((tag) => graph.weight.has(tag) || stats.has(tag))
    .sort((a, b) => recency(b) - recency(a)
      || weightOf(b) - weightOf(a) || a.localeCompare(b));
  const pinSet = new Set(pinTags);
  const aliasesOf = (pin: string): string[] =>
    [...stats.keys()].filter((tag) => graph.alias.get(tag) === pin)
      .sort((a, b) => weightOf(b) - weightOf(a) || a.localeCompare(b));

  /* A card counts only while a heading still roots the graph. Without readable cards the
     roots stand one column each, ordered the way the band orders cards. */
  const cards = (opts.pins ?? []).filter((card) =>
    card.columns.some((column) => column.some((tag) => pinSet.has(tag))));
  const groups: PinGroup[] = cards.length > 0
    ? newestFirst(cards.map((card) => ({
      rank: card.stamp,
      columns: card.columns
        .map((tags, i) => ({
          tags: tags.filter((tag) => pinSet.has(tag)),
          children: [...(card.children?.[i] ?? [])],
        }))
        .filter((column) => column.tags.length > 0),
    })))
    : newestFirst(pinTags.map((tag) => ({
      rank: recency(tag), columns: [{ tags: [tag], children: [] }],
    })));

  const columns = groups.flatMap((group) => group.columns);
  const columnTop = new Set(columns.flatMap((column) => column.tags));
  const childSeen = new Set<string>();
  for (const column of columns) {
    column.children = column.children.filter((tag) => {
      if (columnTop.has(tag) || childSeen.has(tag)) return false;
      if (!graph.weight.has(tag) && !stats.has(tag)) return false;
      childSeen.add(tag);
      return true;
    });
  }

  const colW = columns.length === 0
    ? 0 : Math.min(shape.pinCol, PIN_BAND_MAX / columns.length);
  const starTag = columns[0]?.tags[0] ?? null;

  columns.forEach((column, i) => {
    if (colW <= 0) return;
    const lon1 = -i * colW;
    const lon0 = lon1 - colW;
    let cursor = 0;
    for (const pin of column.tags) {
      const rows = [...rowsOf(pin)];
      const aliases = aliasesOf(pin);
      const room = aliases.length > 0 ? shape.aliasBand : 0;
      const height = clamp(shape.areaPerRow * Math.max(1, weightOf(pin)) / colW,
        shape.minH, shape.maxH);
      const pinBottom = cursor - height;
      const aliasBottom = pinBottom - room;
      const cellW = aliases.length > 0 ? colW / aliases.length : 0;
      aliases.forEach((alias, j) => {
        const aliasRows = [...rowsOf(alias)];
        addRegion({
          key: alias,
          tag: alias,
          reach: 'alias',
          nature: natureOf(alias),
          weight: weightOf(alias),
          score: stats.get(alias)?.score ?? 0,
          freq: stats.get(alias)?.freq ?? weightOf(alias),
          ...(stats.get(alias)?.lambda === undefined ? {} : { lambda: stats.get(alias)?.lambda }),
          lon0: lon0 + cellW * j,
          lon1: lon0 + cellW * (j + 1),
          rise0: aliasBottom,
          rise1: pinBottom,
          side: 'pin',
          depth: 0,
          pin,
          labelText: `#${cropText(alias, WALL_TAG_CROP)}`,
          rows: aliasRows,
        });
      });
      addRegion({
        key: pin,
        tag: pin,
        reach: 'pinned',
        nature: natureOf(pin),
        weight: weightOf(pin),
        score: stats.get(pin)?.score ?? 0,
        freq: stats.get(pin)?.freq ?? weightOf(pin),
        ...(stats.get(pin)?.lambda === undefined ? {} : { lambda: stats.get(pin)?.lambda }),
        lon0,
        lon1,
        rise0: pinBottom,
        rise1: cursor,
        side: 'pin',
        depth: 0,
        star: pin === starTag,
        labelText: `#${cropText(pin, WALL_TAG_CROP)}`,
        rows,
      });
      cursor = aliasBottom - shape.shelfGap;
    }

    if (column.children.length > 0) {
      const packed = tileCells(
        column.children.map((tag) => ({ tag, weight: Math.max(1, weightOf(tag)) })),
        shape, lon0, colW,
      );
      for (const cell of packed) {
        const tag = cell.item.tag;
        const rows = [...rowsOf(tag)];
        addRegion({
          key: tag,
          tag,
          reach: reachOf(tag),
          nature: natureOf(tag),
          weight: weightOf(tag),
          score: stats.get(tag)?.score ?? 0,
          freq: stats.get(tag)?.freq ?? weightOf(tag),
          ...(stats.get(tag)?.lambda === undefined ? {} : { lambda: stats.get(tag)?.lambda }),
          lon0: cell.lon0,
          lon1: cell.lon1,
          rise0: cursor + cell.rise0,
          rise1: cursor + cell.rise1,
          side: 'pin',
          depth: 1,
          parent: column.tags[0],
          pin: column.tags[0],
          labelText: `#${cropText(tag, WALL_TAG_CROP)}`,
          rows,
        });
      }
    }
  });

  /* ── the recent band: emerging tags start at lon 0 and run screen-left ── */

  const recentTags = (opts.emerging ?? []).filter((tag) => !pinSet.has(tag.tag));
  const recentSet = new Set(recentTags.map((tag) => tag.tag));
  const recentChildSet = new Set<string>();
  const emW = recentTags.length === 0
    ? 0 : Math.min(shape.pinCol, RECENT_BAND_MAX / recentTags.length);

  recentTags.forEach((entry, i) => {
    if (emW <= 0) return;
    const lon0 = i * emW;
    const lon1 = lon0 + emW;
    const rows = [...rowsOf(entry.tag)];
    const height = clamp(shape.areaPerRow * Math.max(1, weightOf(entry.tag)) / emW,
      shape.minH, shape.maxH);
    addRegion({
      key: entry.tag,
      tag: entry.tag,
      reach: reachOf(entry.tag),
      nature: natureOf(entry.tag),
      weight: weightOf(entry.tag),
      score: stats.get(entry.tag)?.score ?? 0,
      freq: stats.get(entry.tag)?.freq ?? weightOf(entry.tag),
      ...(stats.get(entry.tag)?.lambda === undefined ? {} : { lambda: stats.get(entry.tag)?.lambda }),
      lon0,
      lon1,
      rise0: -height,
      rise1: 0,
      side: 'recent',
      depth: 0,
      trend: entry.score,
      labelText: `#${cropText(entry.tag, WALL_TAG_CROP)}`,
      rows,
    });

    const kids = entry.children.filter((tag) => {
      if (tag === entry.tag || pinSet.has(tag) || recentSet.has(tag) || recentChildSet.has(tag)) {
        return false;
      }
      if (!graph.weight.has(tag) && !stats.has(tag)) return false;
      recentChildSet.add(tag);
      return true;
    });
    if (kids.length === 0) return;
    const packed = tileCells(
      kids.map((tag) => ({ tag, weight: Math.max(1, weightOf(tag)) })),
      shape, lon0, emW,
    );
    for (const cell of packed) {
      const tag = cell.item.tag;
      const childRows = [...rowsOf(tag)];
      addRegion({
        key: tag,
        tag,
        reach: reachOf(tag),
        nature: natureOf(tag),
        weight: weightOf(tag),
        score: stats.get(tag)?.score ?? 0,
        freq: stats.get(tag)?.freq ?? weightOf(tag),
        ...(stats.get(tag)?.lambda === undefined ? {} : { lambda: stats.get(tag)?.lambda }),
        lon0: cell.lon0,
        lon1: cell.lon1,
        rise0: (shape.shelfGap + height) * -1 + cell.rise0,
        rise1: (shape.shelfGap + height) * -1 + cell.rise1,
        side: 'recent',
        depth: 1,
        parent: entry.tag,
        labelText: `#${cropText(tag, WALL_TAG_CROP)}`,
        rows: childRows,
      });
    }
  });

  /* ── the tail: the rest of the clouds stay behind the rear half ─────────── */

  const cloudTags = [...stats.keys()]
    .filter((tag) => !pinSet.has(tag) && graph.alias.get(tag) === undefined)
    .filter((tag) => !recentSet.has(tag) && !recentChildSet.has(tag))
    .filter((tag) => graph.weight.has(tag) || stats.has(tag))
    .slice(0, maxClouds);
  const byCluster = new Map<string, string[]>();
  const loose: string[] = [];
  for (const tag of cloudTags) {
    const owner = clusterOf(graph, tag, pinSet);
    if (owner === null) {
      loose.push(tag);
    } else {
      const list = byCluster.get(owner) ?? [];
      list.push(tag);
      byCluster.set(owner, list);
    }
  }
  const byWeight = (a: string, b: string): number =>
    weightOf(b) - weightOf(a) || a.localeCompare(b);
  const ordered: Cloud[] = [];
  for (const pin of pinTags) {
    for (const tag of (byCluster.get(pin) ?? []).sort(byWeight)) {
      ordered.push({ tag, weight: weightOf(tag), reach: reachOf(tag), nature: natureOf(tag), pin });
    }
  }
  for (const tag of loose.sort(byWeight)) {
    ordered.push({ tag, weight: weightOf(tag), reach: reachOf(tag), nature: natureOf(tag) });
  }

  /* The front half is the reading; the tail stays behind lon 90 on both sides, so a wide
     horizontal spacing brings it into view instead of crowding the star. */
  const pinEnd = columns.length * colW;
  const recentEnd = recentTags.length * emW;
  const arcStart = Math.max(recentEnd, 90);
  const arcEnd = Math.max(arcStart, 360 - Math.max(pinEnd, 90));
  const arc = { start: arcStart, end: arcEnd };
  const placed = arcEnd > arcStart
    ? tileClouds(ordered, shape, arc.start, arc.end - arc.start)
    : [];

  const regionOf = (cloud: Cloud, rect: Placed): WallRegion => {
    const rows = [...rowsOf(cloud.tag)];
    return {
      key: cloud.tag,
      tag: cloud.tag,
      reach: cloud.reach,
      nature: cloud.nature,
      weight: cloud.weight,
      score: stats.get(cloud.tag)?.score ?? 0,
      freq: stats.get(cloud.tag)?.freq ?? cloud.weight,
      ...(stats.get(cloud.tag)?.lambda === undefined ? {} : { lambda: stats.get(cloud.tag)?.lambda }),
      ...(stats.get(cloud.tag)?.burst === undefined ? {} : { burst: stats.get(cloud.tag)?.burst }),
      ...(stats.get(cloud.tag)?.top === undefined ? {} : { top: stats.get(cloud.tag)?.top }),
      lon0: rect.lon0,
      lon1: rect.lon1,
      rise0: rect.rise0,
      rise1: rect.rise1,
      above: false,
      reflection: false,
      star: false,
      side: 'tail',
      depth: 0,
      label: true,
      ...(cloud.pin === undefined ? {} : { pin: cloud.pin }),
      labelText: `#${cropText(cloud.tag, WALL_TAG_CROP)}`,
      rows,
      points: [],
    };
  };

  for (const item of placed) {
    const region = regionOf(item.cloud, item);
    region.points = scatter(region, region.rows, false);
    points.push(...region.points);
    below = Math.min(below, region.rise0);
    entries.push(region);

    /* The reflection: the same rectangle over the horizon, dark and unlabelled. It carries
       no points, because it is the canvas's light, not a second reading. */
    const mirrored: WallRegion = {
      ...region,
      key: `${region.tag}~`,
      rise0: -region.rise1,
      rise1: -region.rise0,
      above: true,
      reflection: true,
      label: false,
      points: [],
    };
    above = Math.max(above, mirrored.rise1);
    entries.push(mirrored);
  }

  /* A row's star dims by where its evidence sits inside its own tag's region: the newest
     row a tag kept is full strength whatever the wall's own age, so an old tag reads as an
     old tag rather than as a dim one. A point with no stamp keeps full strength. */
  const recencyIn = (
    stamps: readonly (number | undefined)[],
  ): (stamp: number | undefined) => number | undefined => {
    let oldest = Number.POSITIVE_INFINITY;
    let newest = Number.NEGATIVE_INFINITY;
    for (const stamp of stamps) {
      if (stamp === undefined || !Number.isFinite(stamp) || stamp <= 0) continue;
      if (stamp < oldest) oldest = stamp;
      if (stamp > newest) newest = stamp;
    }
    return (stamp) => {
      if (stamp === undefined || !Number.isFinite(stamp) || stamp <= 0) return undefined;
      if (!(newest > oldest)) return 1;
      return clamp((stamp - oldest) / (newest - oldest), 0, 1);
    };
  };
  for (const region of entries) {
    if (region.points.length === 0) continue;
    const recencyOf = recencyIn(region.points.map((point) => point.stamp));
    for (const point of region.points) {
      const recency = recencyOf(point.stamp);
      if (recency !== undefined) point.recency = recency;
    }
  }
  /* The sea-level star is the newest evidence of its own tag, so it reads full strength
     whenever that tag kept a stamped row. */
  let starRecency: number | undefined;
  if (starTag !== null) {
    const starRows = rowsOf(starTag);
    let starStamp: number | undefined;
    for (const row of starRows) {
      if (row.stamp === undefined || !Number.isFinite(row.stamp) || row.stamp <= 0) continue;
      if (starStamp === undefined || row.stamp > starStamp) starStamp = row.stamp;
    }
    starRecency = recencyIn(starRows.map((row) => row.stamp))(starStamp);
  }

  return {
    regions: entries,
    pins: entries.filter((region) =>
      region.side === 'pin' && region.depth === 0 && region.reach === 'pinned' && !region.reflection),
    recent: entries.filter((region) =>
      region.side === 'recent' && region.depth === 0 && !region.reflection),
    points,
    star: {
      lon: 0, rise: 0, pin: starTag,
      ...(starRecency === undefined ? {} : { recency: starRecency }),
    },
    above,
    below,
    arc,
  };
}

/**
 * The region a wall place falls in.
 *
 * Longitudes past 180 belong to the rear tail, whose seam is hidden behind the star; a
 * place is therefore tried as it is and once more a turn away.
 *
 * @param regions the wall's regions
 * @param lon observed longitude, in degrees
 * @param rise degrees above sea level
 * @returns the region holding the place, or `null` in a gap
 */
export function regionOnWall(
  regions: readonly WallRegion[], lon: number, rise: number,
): WallRegion | null {
  const turns = [lon, lon + 360, lon - 360];
  let reflected: WallRegion | null = null;
  for (const region of regions) {
    if (rise < region.rise0 || rise > region.rise1) continue;
    if (!turns.some((value) => value >= region.lon0 && value <= region.lon1)) continue;
    if (!region.reflection) return region;
    if (reflected === null) reflected = region;
  }
  return reflected;
}

/**
 * A wall place as a reader reads it, e.g. `45.0°E up 12.3°`.
 *
 * @param lon degrees east of `+z`
 * @param rise degrees above sea level
 * @returns the label
 */
export function wallLabel(lon: number, rise: number): string {
  const ew = lon >= 0 ? 'E' : 'W';
  const up = rise >= 0 ? 'up' : 'down';
  return `${Math.abs(lon).toFixed(1)}°${ew} ${up} ${Math.abs(rise).toFixed(1)}°`;
}
