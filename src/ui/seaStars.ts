/**
 * seaStars.ts — what a renderer draws for a wall of regions.
 *
 * `seaRegion` decides where each tag's rectangle lands and how much of the wall it owns;
 * this module turns that packing into the marks a renderer consumes:
 *
 * - One star per region, at the region's own middle, carrying the rectangle it stands for so
 *   a renderer can size the point by the wall the tag owns rather than by its row count
 *   alone.
 * - The edges one row's chip list held, deduped, heaviest first, so the arcs a reader sees
 *   are the readings the rows actually made.
 * - The two scales both are drawn by: the widest tag and the heaviest edge.
 *
 * The placement this replaced hung a star at a place of its own choosing — a spine at the
 * centre and a cloud over the circle behind it. A place is not a share of the wall, and the
 * sea now reads the table by how much wall each tag owns, so the placement belongs to the
 * packing and this module only marks it.
 *
 * Nothing here touches the DOM or three.js, so the marks are testable from a graph and a
 * packing alone.
 */

import type { AnyNodeKind, TagGraph } from './restGraph';
import { regionCentre, type SeaRegion } from './seaRegion';

/** Edges a wall draws at most, heaviest first. */
const MAX_EDGES = 260;

/** One tag of the wall, marked at the middle of the region that stands for it. */
export interface SeaStar {
  /** The tag itself, as the reading kept it. */
  tag: string;
  /** What part of the reading it came from; see `restGraph.pinReach`. */
  kind: AnyNodeKind;
  /** Scored rows that kept the tag. */
  rows: number;
  /** Degrees east of `+z`, at the region's middle. */
  lon: number;
  /** Degrees of wall above the equator, at the region's middle. */
  rise: number;
  /** The rectangle this star marks. */
  region: SeaRegion;
  /** Mean lexical share of those rows; absent on a fixed-weighting pass. */
  lambda?: number;
}

/** Two stars one row's chip list held together. */
export interface SeaEdge {
  a: string;
  b: string;
  /** Rows that held both. */
  w: number;
}

/** The marks of a wall: a star per region, the edges among them, and the scales to draw. */
export interface SeaStarField {
  stars: SeaStar[];
  edges: SeaEdge[];
  /** Rows the widest star was kept by, for a renderer's own scaling. */
  maxRows: number;
  /** Rows the heaviest edge held, for a renderer's own scaling. */
  maxEdge: number;
  /** How many tags the pass kept before the packing capped them. */
  kept: number;
}

/** How many edges to mark, and where a star's colour comes from. */
export interface SeaStarsOptions {
  /** Edges to draw at most. Defaults to a wall's own cap. */
  maxEdges?: number;
  /** Mean lexical share per tag, overriding the graph's own. */
  lambda?: (tag: string) => number | undefined;
}

/**
 * What the pass marked a node, or what its being a root implies.
 *
 * @param graph the graph a node came from
 * @param tag a canonical node name
 * @returns the kind, `own` for a tag the pass never marked
 */
export const kindOf = (graph: TagGraph, tag: string): AnyNodeKind =>
  graph.kind.get(tag) ?? (graph.roots.has(tag) ? 'pinned' : 'own');

/**
 * Mark a packing: one star per region, the edges the rows made, and the scales both are
 * drawn by.
 *
 * @param graph the graph, as `restGraph.buildTagGraph` returns it
 * @param regions the packing, as `seaRegion.seaRegions` returns it
 * @param opts how many edges to mark, and where a star's colour comes from
 * @returns the stars, the edges among them and the scales they are drawn by
 */
export function seaStars(
  graph: TagGraph, regions: SeaRegion[], opts: SeaStarsOptions = {},
): SeaStarField {
  const stars: SeaStar[] = [];
  const held = new Set<string>();
  let maxRows = 1;
  for (const region of regions) {
    held.add(region.tag);
    if (region.rows > maxRows) maxRows = region.rows;
    const at = regionCentre(region);
    const lambda = opts.lambda?.(region.tag) ?? graph.lambda.get(region.tag);
    stars.push({
      tag: region.tag, kind: region.kind, rows: region.rows,
      lon: at.lon, rise: at.rise, region,
      ...(lambda === undefined ? {} : { lambda }),
    });
  }

  const edges: SeaEdge[] = [];
  let maxEdge = 1;
  for (const [a, near] of graph.edges) {
    if (!held.has(a)) continue;
    for (const [b, w] of near) {
      if (!held.has(b) || a.localeCompare(b) > 0) continue;
      if (w > maxEdge) maxEdge = w;
      edges.push({ a, b, w });
    }
  }
  edges.sort((x, y) => y.w - x.w);

  return {
    stars, edges: edges.slice(0, opts.maxEdges ?? MAX_EDGES), maxRows, maxEdge,
    kept: graph.weight.size,
  };
}

/**
 * How wide a star is drawn, in a `[0, 1]` fraction of the cylinder's radius.
 *
 * The square root keeps a tag one row kept visible beside one fifty rows kept, the same
 * compression `tagGraphLayout` uses for its node radii.
 *
 * @param rows rows that kept the tag
 * @param maxRows rows the widest star was kept by
 * @returns the radius, `0.01` at the smallest
 */
export function starSize(rows: number, maxRows: number): number {
  return 0.01 + 0.035 * Math.sqrt(rows / Math.max(1, maxRows));
}

/**
 * How opaque a star is drawn, in `[0, 1]`.
 *
 * The wall carries the tail of the reading — hundreds of tags one or two rows kept — and at
 * full strength that tail would read as the subject rather than as the ground. A tag is
 * faint at one row and opaque once a share of the widest tag kept it, which is the whole
 * difference between a pinned tag and the field around it.
 *
 * @param rows rows that kept the tag
 * @param maxRows rows the widest star was kept by
 * @returns the opacity, `0.22` at the faintest
 */
export function starOpacity(rows: number, maxRows: number): number {
  return 0.22 + 0.78 * Math.sqrt(rows / Math.max(1, maxRows));
}

/**
 * The wall's legend: one `mark label count` per kind the taxonomy names, in the order given.
 *
 * A kind the wall placed nothing on is listed with a zero, because the line states the
 * reading rather than only what is drawn — a reader looking for a band that is not there
 * should find it named with nothing in it.
 *
 * @param field the wall to describe
 * @param names the marker and name of each kind, for the reading the wall was packed in
 * @param order the kinds to list; defaults to the order `names` holds them in
 * @returns the line, empty when the taxonomy names nothing
 */
export function skyLegend(
  field: SeaStarField,
  names: Record<string, { mark: string; label: string } | undefined>,
  order: readonly string[] = Object.keys(names),
): string {
  const counts = new Map<string, number>();
  for (const s of field.stars) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  return order
    .map((kind) => `${names[kind]?.mark ?? '·'} ${names[kind]?.label ?? kind} ${counts.get(kind) ?? 0}`)
    .join(' · ');
}
