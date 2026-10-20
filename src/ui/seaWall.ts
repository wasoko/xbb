/**
 * seaWall.ts — the tag canvas on the cylinder, from the table out.
 *
 * The pinned headings hold a column at the front, the first of them exactly at sea level under
 * the star; every other pinned heading is stacked below it. The other tags tile one continuous
 * arc around the rest of the cylinder, ordered by the pin whose cluster they answer for, so the
 * canvas fills the wall instead of leaving a strip empty. Every cell — the pinned column
 * included — scatters the rows that kept it as link points, and no cell lists its rows as text.
 * Above the horizon the same canvas is mirrored as a reflection: the same tags, dark and
 * unlabelled, catching the star's light.
 *
 * Nothing is sampled or invented. A region exists because the table holds the tag, and a link
 * point exists because a row carried it. Spacing is the renderer's business; this module lays
 * the wall out in degrees.
 *
 * The cloud arc starts at the column's east edge and runs the long way round to its west edge,
 * so longitudes on the canvas are unwrapped past 180: the seam falls behind the pinned column,
 * where nothing is read. A caller searching for a place tries the place and the place plus a
 * turn, which is all the wrapping the wall needs.
 */

import type { AnyNodeKind, GraphNodeKind, TagGraph } from './restGraph';
import { cropText, type SeaRow, type SeaTag } from './seaTags';
import { SEA_REGION, clusterOf, type SeaRegionOptions, type SeaRegionShape } from './seaRegion';
import { pinReach } from './restGraph';
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
}

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
  /** Whether the region draws its name; only a reflection does not. */
  label: boolean;
  /** The pinned heading this region answers for. */
  pin?: string;
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
  points: WallPoint[];
  /** The star's place: the front meridian, exactly at sea level. */
  star: { lon: number; rise: number; pin: string | null };
  /** Furthest packed rise above and below sea level, in degrees. */
  above: number;
  below: number;
  /** The continuous arc the clouds tile, in unwrapped degrees. */
  arc: { start: number; end: number };
}

/** How a wall is built. */
export interface WallOptions extends SeaRegionOptions {
  /** Cloud tags kept before the tail is left to the hover card; defaults to 220. */
  maxClouds?: number;
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

/**
 * Tile one arc of the wall with the clouds, shelf by shelf.
 *
 * Each shelf is stretched to the arc exactly, so the canvas closes all the way round instead of
 * leaving the last strip short. A tag's area still follows the rows that kept it, so widening a
 * shelf narrows the cells it holds.
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
  const areaOf = (cloud: Cloud): number => shape.areaPerRow * Math.max(1, cloud.weight);
  const widthOf = (cloud: Cloud): number =>
    clamp(Math.sqrt(areaOf(cloud) * shape.aspect), shape.minW, arcWidth);

  const out: Placed[] = [];
  let cursor = 0;
  let i = 0;
  while (i < clouds.length) {
    const shelf: Cloud[] = [];
    let wanted = 0;
    while (i < clouds.length) {
      const w = widthOf(clouds[i]);
      if (shelf.length > 0 && wanted + w > arcWidth) break;
      shelf.push(clouds[i]);
      wanted += w;
      i++;
    }
    if (shelf.length === 0) break;
    const stretch = arcWidth / Math.max(1e-6, wanted);
    const widths = shelf.map((cloud) => widthOf(cloud) * stretch);
    const heights = shelf.map((cloud, j) =>
      clamp(areaOf(cloud) / Math.max(1e-6, widths[j]), shape.minH, shape.maxH));
    const shelfH = heights.reduce((m, h) => Math.max(m, h), shape.minH);

    let lon = arcStart;
    shelf.forEach((cloud, j) => {
      out.push({
        cloud,
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
    });
  });
  return out;
}

/**
 * Build the wall around sea level.
 *
 * @param graph the tag graph
 * @param tags the taxonomy table
 * @param rowsOf the rows a tag was kept by
 * @param opts packing overrides, how much a region carries, and how wide a label must be
 * @returns the regions, the pins, the link points and the star
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

  /* ── the pinned column ─────────────────────────────────────────────────── */

  const pinTags = [...graph.roots]
    .filter((tag) => graph.weight.has(tag) || stats.has(tag))
    .sort((a, b) => recency(b) - recency(a)
      || weightOf(b) - weightOf(a) || a.localeCompare(b));
  const pinSet = new Set(pinTags);
  const aliasesOf = (pin: string): string[] =>
    [...stats.keys()].filter((tag) => graph.alias.get(tag) === pin)
      .sort((a, b) => weightOf(b) - weightOf(a) || a.localeCompare(b));

  const entries: WallRegion[] = [];
  const points: WallPoint[] = [];
  const band = shape.pinCol / 2;
  let cursor = 0;

  for (const pin of pinTags) {
    const rows = [...rowsOf(pin)];
    const aliases = aliasesOf(pin);
    const room = aliases.length > 0 ? shape.aliasBand : 0;
    const height = clamp(shape.areaPerRow * Math.max(1, weightOf(pin)) / shape.pinCol,
      shape.minH, shape.maxH);
    const bottom = cursor - (height + room);
    const cellW = aliases.length > 0 ? shape.pinCol / aliases.length : 0;
    aliases.forEach((alias, i) => {
      const aliasRows = [...rowsOf(alias)];
      const region: WallRegion = {
        key: alias,
        tag: alias,
        reach: 'alias',
        nature: natureOf(alias),
        weight: weightOf(alias),
        score: stats.get(alias)?.score ?? 0,
        freq: stats.get(alias)?.freq ?? weightOf(alias),
        ...(stats.get(alias)?.lambda === undefined ? {} : { lambda: stats.get(alias)?.lambda }),
        lon0: -band + cellW * i,
        lon1: -band + cellW * (i + 1),
        rise0: bottom,
        rise1: bottom + room,
        above: false,
        reflection: false,
        star: false,
        label: true,
        pin,
        labelText: `#${cropText(alias, WALL_TAG_CROP)}`,
        rows: aliasRows,
        points: [],
      };
      /* A spelling is still a cell with rows: its links are stars like any other tag's. */
      region.points = scatter(region, aliasRows, false);
      points.push(...region.points);
      entries.push(region);
    });
    const isStar = pin === pinTags[0];
    const region: WallRegion = {
      key: pin,
      tag: pin,
      reach: 'pinned',
      nature: natureOf(pin),
      weight: weightOf(pin),
      score: stats.get(pin)?.score ?? 0,
      freq: stats.get(pin)?.freq ?? weightOf(pin),
      ...(stats.get(pin)?.lambda === undefined ? {} : { lambda: stats.get(pin)?.lambda }),
      lon0: -band,
      lon1: band,
      rise0: bottom + room,
      rise1: cursor,
      above: false,
      reflection: false,
      star: isStar,
      label: true,
      labelText: `#${cropText(pin, WALL_TAG_CROP)}`,
      rows,
      points: [],
    };
    /* The curated heading is a cell like the rest: its evidence hangs under it as points,
       not as a list of links. */
    region.points = scatter(region, rows, false);
    points.push(...region.points);
    entries.push(region);
    cursor = bottom - shape.shelfGap;
  }

  /* ── the cloud ring ────────────────────────────────────────────────────── */

  const cloudTags = [...stats.keys()]
    .filter((tag) => !pinSet.has(tag) && graph.alias.get(tag) === undefined)
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

  const arc = { start: band, end: 360 - band };
  const placed = tileClouds(ordered, shape, arc.start, arc.end - arc.start);

  let above = 0;
  let below = 0;
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

  return {
    regions: entries,
    pins: entries.filter((region) => region.reach === 'pinned' && !region.reflection),
    points,
    star: { lon: 0, rise: 0, pin: pinTags[0] ?? null },
    above,
    below,
    arc,
  };
}

/**
 * The region a wall place falls in.
 *
 * Longitudes past 180 belong to the cloud arc, whose seam is hidden behind the pinned column;
 * a place is therefore tried as it is and once more a turn away.
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
