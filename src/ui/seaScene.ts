/**
 * seaScene.ts — the sea's cylinder as three.js geometry.
 *
 * Every builder here is a pure function of a sky and a radius, so the scene is assembled
 * from numbers rather than accumulated in an effect. The grid, the cell a click selected and
 * the star field all measure their points with `seaSky.seaVec`, which is what keeps a
 * highlight under the pointer that asked for it.
 *
 * Everything is built as one merged geometry per layer: a grid is thousands of segments and
 * a star field is hundreds of points, and one draw call for each is what lets the sea sit
 * behind the app as a background without competing with it.
 *
 * The grid is a filled band of wall rather than the whole cylinder, because the wall has no
 * end to draw to. Its parallels sit on absolute multiples of the spacing and the renderer
 * slides the band by whole spacings as the camera pans, so the band follows the reader while
 * the lines stay where they belong: the pattern is periodic, so a shift of one spacing is
 * invisible and the grid reads as endless.
 */

import * as THREE from 'three';
import type { AnyNodeKind } from './restGraph';
import { seaVec, vecSea, type SeaCell, type SeaPlace } from './seaSky';
import { shareRgb, tagRgb } from './restCue';
import { isCurated } from './seaRegion';
import { starOpacity, starSize, type SeaStarField } from './seaStars';

/**
 * Degrees between the samples of one parallel. A chord of this length on a circle of any
 * radius the sea uses bends by less than a pixel, so the circles read smooth without a
 * vertex per degree.
 */
const ARC_STEP = 3;

/** Samples along one edge chord, so a long edge follows the wall instead of cutting the
 *  axis the camera stands on. */
const EDGE_STEPS = 12;

/** Segments along the meridians of a cell patch, so the patch curves with the wall. */
const CELL_LON_SEGMENTS = 8;

/** How far inside the grid a patch and a star sit, so nothing z-fights with a line. */
const INSET = 0.995;

/**
 * A band of the celestial grid: a meridian every `spacing` degrees and a parallel every
 * `spacing` of rise, over `rows` steps of wall from the band's own bottom edge.
 *
 * A meridian is straight — the wall has no curvature along its axis — so it costs two points,
 * while a parallel is a circle and is sampled. The parallels sit at multiples of the spacing
 * measured from the band's own foot, which is what lets the renderer slide the band by whole
 * spacings and leave the pattern where it was.
 *
 * @param spacing the grid's spacing in degrees, on both axes of the wall
 * @param radius the cylinder's radius
 * @param rows steps of wall the band covers
 * @returns a `LineSegments` geometry over the band
 */
export function makeGrid(spacing: number, radius: number, rows: number): THREE.BufferGeometry {
  const points: number[] = [];
  const push = (a: number[], b: number[]) => { points.push(...a, ...b); };
  const at = (lon: number, rise: number) => seaVec({ lon, rise }, radius * INSET);
  const top = rows * spacing;

  for (let lon = 0; lon < 360; lon += spacing) {
    push(at(lon, 0), at(lon, top));
  }
  for (let step = 0; step < rows; step++) {
    const rise = step * spacing;
    for (let lon = -180; lon < 180; lon += ARC_STEP) {
      push(at(lon, rise), at(Math.min(180, lon + ARC_STEP), rise));
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  return geometry;
}

/** The two geometries a selected cell is drawn with: its patch and its border. */
export interface CellGeometry {
  /** The filled band, drawn translucent. */
  fill: THREE.BufferGeometry;
  /** The border of that band, drawn bright so the cell reads at a glance. */
  outline: THREE.BufferGeometry;
}

/**
 * The band of wall a click selected, as a patch on the cylinder.
 *
 * The patch is a rectangle in the wall's own coordinates, so only its longitudes are sampled:
 * the meridian edges are straight and the rim is four lines rather than a circle's worth of
 * samples.
 *
 * @param cell the cell, in degrees on both axes
 * @param radius the cylinder's radius
 * @returns the patch and its border
 */
export function makeCellPatch(cell: SeaCell, radius: number): CellGeometry {
  const cols = Math.max(2, CELL_LON_SEGMENTS);
  const r = radius * INSET;
  const vertices: number[] = [];
  const indices: number[] = [];

  for (let j = 0; j <= cols; j++) {
    const lon = cell.lonMin + ((cell.lonMax - cell.lonMin) * j) / cols;
    vertices.push(...seaVec({ lon, rise: cell.riseMin }, r));
    vertices.push(...seaVec({ lon, rise: cell.riseMax }, r));
  }
  for (let j = 0; j < cols; j++) {
    const a = j * 2;
    indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }

  const fill = new THREE.BufferGeometry();
  fill.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  fill.setIndex(indices);

  /* The border walks the patch's own rim, so the two cannot drift apart. */
  const rim: number[] = [
    ...seaVec({ lon: cell.lonMin, rise: cell.riseMin }, r),
    ...seaVec({ lon: cell.lonMin, rise: cell.riseMax }, r),
    ...seaVec({ lon: cell.lonMax, rise: cell.riseMax }, r),
    ...seaVec({ lon: cell.lonMax, rise: cell.riseMin }, r),
  ];
  for (let j = 1; j < cols; j++) {
    const lon = cell.lonMin + ((cell.lonMax - cell.lonMin) * j) / cols;
    rim.push(...seaVec({ lon, rise: cell.riseMax }, r));
  }

  const outline = new THREE.BufferGeometry();
  outline.setAttribute('position', new THREE.Float32BufferAttribute(rim, 3));
  return { fill, outline };
}

/** A star's position along the wall, keyed by tag, for the edge chords. */
export type StarPositions = Map<string, [number, number, number]>;

/**
 * Place every star of a sky on the wall.
 *
 * @param field the sky to place
 * @param radius the cylinder's radius
 * @returns each star's position, keyed by tag
 */
export function starPositions(field: SeaStarField, radius: number): StarPositions {
  const r = radius * INSET;
  return new Map(field.stars.map((s) => [s.tag, seaVec(s, r)]));
}

/**
 * One star's opacity: the spine carries the reading, the cloud behind it is the ground.
 *
 * @param kind the kind the taxonomy gave the star
 * @param rows rows that kept the star's tag
 * @param field the sky it was placed in, for the widest tag's own width
 * @returns the opacity, `1` on the spine
 */
const fadeOf = (kind: AnyNodeKind, rows: number, field: SeaStarField): number =>
  isCurated(kind) ? 1 : starOpacity(rows, field.maxRows);

/**
 * The star field as one `Points` geometry: a position, a world-space radius, a colour and an
 * opacity per star.
 *
 * A star's colour is the lexical share the rows that kept it carry, so the sky reads as a
 * field over the table — warm where the exact lexical lists did the work, cool where the
 * neighbour walks did. A fixed-weighting pass has no share to show and every star keeps the
 * tag's own hue instead.
 *
 * @param field the sky to draw
 * @param radius the cylinder's radius
 * @param positions the star positions, as {@link starPositions} returns them
 * @returns a `Points` geometry with the `aSize`, `aColor` and `aFade` attributes its shader
 *          reads
 */
export function makeStars(
  field: SeaStarField, radius: number, positions: StarPositions,
): THREE.BufferGeometry {
  const place: number[] = [];
  const size: number[] = [];
  const color: number[] = [];
  const fade: number[] = [];

  for (const s of field.stars) {
    const p = positions.get(s.tag);
    if (!p) continue;
    place.push(...p);
    size.push(starSize(s.rows, field.maxRows) * radius);
    fade.push(fadeOf(s.kind, s.rows, field));
    color.push(...(s.lambda === undefined ? tagRgb(s.tag) : shareRgb(s.lambda)));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(place, 3));
  geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
  geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(color, 3));
  geometry.setAttribute('aFade', new THREE.Float32BufferAttribute(fade, 1));
  return geometry;
}

/**
 * The wall path from one place to another: their longitudes walked the short way round, their
 * rise even between the two.
 *
 * A chord is what the sphere used and it cannot be kept here. Two stars at opposite longitudes
 * are at opposite sides of the wall, so the straight line between them passes through the axis,
 * which is where the camera stands; an arc along the wall stays behind the viewer where it
 * belongs.
 *
 * @param from the place to walk from
 * @param to the place to walk to
 * @param radius the cylinder's radius
 * @returns the sampled points of the path
 */
function arc(from: SeaPlace, to: SeaPlace, radius: number): number[][] {
  const r = radius * INSET;
  const out: number[][] = [];
  for (let i = 0; i <= EDGE_STEPS; i++) {
    const t = i / EDGE_STEPS;
    out.push(seaVec({ lon: from.lon + (to.lon - from.lon) * t, rise: from.rise + (to.rise - from.rise) * t }, r));
  }
  return out;
}

/**
 * How far round the wall an edge may reach before it is not drawn at all, in degrees.
 *
 * Past this the two tags are on opposite sides of the wall from any view the sea opens on, so
 * the arc carries no relation a reader can see — it lands as a streak over the reading. The
 * cloud is spread over the longitudes the spine leaves, so without this most of its edges
 * would be such streaks.
 */
const EDGE_SPAN = 120;

/**
 * The edges of a sky, drawn along the wall between the stars they join.
 *
 * An edge is faded by how far round the wall it travels, and the fade is squared because these
 * arcs are drawn additively: a tag held beside a pin can be a third of the circle away, and a
 * wall's worth of such arcs at even half strength accumulates into the brightest thing on the
 * screen, which is the opposite of the ground the spine stands on.
 *
 * @param field the sky to draw
 * @param positions the star positions, as {@link starPositions} returns them
 * @param radius the cylinder's radius
 * @returns a `LineSegments` geometry, shaded by how many rows held the pair and how far it has
 *          to reach
 */
export function makeEdges(
  field: SeaStarField, positions: StarPositions, radius: number,
): THREE.BufferGeometry {
  const place: number[] = [];
  const shade: number[] = [];

  for (const e of field.edges) {
    const a = positions.get(e.a);
    const b = positions.get(e.b);
    if (!a || !b) continue;
    const from = vecSea(a[0], a[1], a[2], radius);
    const to = vecSea(b[0], b[1], b[2], radius);
    if (from === null || to === null) continue;
    /* The short way round the circle, which is the way the path below walks it. */
    let dLon = to.lon - from.lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    const span = Math.abs(dLon);
    if (span > EDGE_SPAN) continue;

    const path = arc(from, { lon: from.lon + dLon, rise: to.rise }, radius);
    const reach = 1 - span / EDGE_SPAN;
    const t = (0.25 + 0.75 * (e.w / Math.max(1, field.maxEdge))) * reach * reach;
    for (let i = 1; i < path.length; i++) {
      place.push(...path[i - 1], ...path[i]);
      shade.push(t, t, t, t, t, t);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(place, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(shade, 3));
  return geometry;
}

/** The vertex shader of the star field: a world-space radius turned into pixels. */
const STAR_VERTEX = `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aFade;
  uniform float uPixelsPerUnit;
  uniform float uMaxPixels;
  varying vec3 vColor;
  varying float vFade;
  void main() {
    vColor = aColor;
    vFade = aFade;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uPixelsPerUnit, 1.0, uMaxPixels);
  }
`;

/** The fragment shader: a round star with a soft rim, additive over the sky. */
const STAR_FRAGMENT = `
  varying vec3 vColor;
  varying float vFade;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    gl_FragColor = vec4(vColor, vFade * smoothstep(0.25, 0.0, r2));
  }
`;

/**
 * The material the star field is drawn with.
 *
 * @returns a shader material over the `aSize` and `aColor` attributes {@link makeStars}
 *          writes, read additively so overlapping stars brighten instead of fighting
 */
export function starMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uPixelsPerUnit: { value: 1 },
      uMaxPixels: { value: 24 },
    },
    vertexShader: STAR_VERTEX,
    fragmentShader: STAR_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/**
 * Release the geometry and materials under a node and unlink its children.
 *
 * three.js keeps no registry of what a scene holds, so a disposed scene has to be given
 * back by hand; leaking it would hold a GPU buffer per wheel tick.
 *
 * @param node the node to empty
 */
export function disposeChildren(node: THREE.Object3D): void {
  for (const child of [...node.children]) {
    node.remove(child);
    if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Points) {
      child.geometry.dispose();
      const material = child.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
    disposeChildren(child);
  }
}
