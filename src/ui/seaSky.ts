/**
 * seaSky.ts — where a place on the sea's cylinder is, in degrees.
 *
 * The sea wraps the sky on a cylinder: the camera sits on the axis and reads the wall as
 * directions, so a place on it is a longitude and a height rather than a pixel. Longitude
 * wraps at 360 degrees and the height runs on without end, which is what makes a vertical
 * pan a pan instead of a turn — the same gesture on a sphere drags the bands over a pole
 * and bunches them there, and a wall around the axis has no pole to reach.
 *
 * The height is degrees of wall travelled, not an angle: one degree is the same distance at
 * every longitude, so a grid cell is a square of wall and the vertical axis is the scroll
 * dimension rather than a second field of view.
 *
 * Nothing here touches the DOM or three.js: every function is a pure function of two
 * numbers and a radius, so the cylinder is testable without a browser.
 */

/** A place on the cylinder: a longitude, and how far up the wall it sits. */
export interface SeaPlace {
  /** Degrees east of `+z`, in `[-180, 180)`. */
  lon: number;
  /** Degrees of wall above the equator. Unbounded, and the same distance at every
   *  longitude — the property a latitude does not have. */
  rise: number;
}

/** Degrees per radian, and radians per degree. */
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/**
 * The point a place sits at, at a radius from the axis.
 *
 * @param place the place on the wall
 * @param r distance from the axis
 * @returns `[x, y, z]`, `y` up and `+z` at lon 0
 */
export function seaVec(place: SeaPlace, r = 1): [number, number, number] {
  const lon = place.lon * RAD;
  return [r * Math.sin(lon), r * place.rise * RAD, r * Math.cos(lon)];
}

/**
 * Where a direction meets the wall.
 *
 * The inverse of {@link seaVec} for a ray that starts on the axis: the direction is scaled
 * until it reaches the radius, so a caller's own radius still names the place it points at.
 * A direction straight up the axis runs parallel to the wall and meets it nowhere, which is
 * `null` rather than a place.
 *
 * @param x x of the direction
 * @param y y of the direction
 * @param z z of the direction
 * @param r the wall's radius
 * @returns the place the direction points at, or `null` for a direction along the axis
 */
export function vecSea(x: number, y: number, z: number, r = 1): SeaPlace | null {
  const flat = Math.hypot(x, z);
  if (flat === 0) return null;
  /* The ray covers `r` of ground distance to reach the wall, so it covers `r / flat` times
     whatever it was carrying; one degree of arc is `r * RAD` of that wall travel. */
  return { lon: Math.atan2(x, z) * DEG, rise: ((y * (r / flat)) / r) * DEG };
}

/**
 * Longitude folded into `[-180, 180)`, the range the grid is drawn over.
 *
 * @param lon any longitude in degrees
 * @returns the same meridian inside that range
 */
export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Grid spacings in degrees: the ladder the wheel walks, each one a divisor of 360. */
export const GRID_SPACINGS: readonly number[] = [1, 2, 5, 10, 15, 30, 45, 60, 90];

/** Cells wanted across the view before a coarser grid is chosen. */
const CELLS_ACROSS = 3;

/**
 * The coarsest grid that still draws a few cells across the view, so zooming in subdivides
 * the sky rather than smearing one cell over it.
 *
 * The rung sets both axes of the wall: a parallel runs every `spacing` of rise, which is
 * the arc one meridian step covers, so the cells it draws are square however wide the view
 * is opened. That is also what bounds the ladder — a field of view near 180 degrees covers
 * hundreds of rungs of wall, which is why the renderer caps its own field of view.
 *
 * @param fovDeg the camera's vertical field of view in degrees
 * @param spacings the ladder to choose from, ascending
 * @returns the spacing in degrees, the finest rung when none is coarse enough
 */
export function gridSpacing(fovDeg: number, spacings: readonly number[] = GRID_SPACINGS): number {
  for (let i = spacings.length - 1; i >= 0; i--) {
    if (fovDeg / spacings[i] > CELLS_ACROSS) return spacings[i];
  }
  return spacings[0];
}

/**
 * How much wall the view spans, in degrees of rise.
 *
 * The camera stands on the axis at the wall's radius, so its frustum cuts the wall over
 * `2 tan(fov / 2)` radii, and a radius is `1 / RAD` degrees of arc: the radius cancels, and
 * what the view covers follows from the field of view alone. It is what a renderer sizes the
 * grid it draws to, and what a reader's pan moves through.
 *
 * @param fovDeg the camera's vertical field of view in degrees
 * @returns the rise the view spans, in degrees
 */
export function visibleRise(fovDeg: number): number {
  return 2 * Math.tan((fovDeg * RAD) / 2) * DEG;
}

/** One grid cell: the band of longitude, and the band of wall, a click selected. */
export interface SeaCell {
  lonMin: number;
  lonMax: number;
  riseMin: number;
  riseMax: number;
}

/**
 * The cell a place falls in, on a grid of `spacing` degrees.
 *
 * A sphere needed a fix at the poles, where a band half the height of every other one sat at
 * the end of the axis; the wall has no such end, so both axes tile with the same arithmetic
 * and a cell is the same size wherever it is picked.
 *
 * @param at the place, its longitude wrapped first
 * @param spacing the grid's spacing in degrees
 * @returns the cell holding that place
 */
export function seaCell(at: SeaPlace, spacing: number): SeaCell {
  const lonMin = Math.floor((wrapLon(at.lon) + 180) / spacing) * spacing - 180;
  const riseMin = Math.floor(at.rise / spacing) * spacing;
  return { lonMin, lonMax: lonMin + spacing, riseMin, riseMax: riseMin + spacing };
}

/**
 * Whether a place falls in a cell.
 *
 * @param cell the cell to test
 * @param at the place
 * @returns true when `at` is inside the cell, its lower edges included
 */
export function cellHolds(cell: SeaCell, at: SeaPlace): boolean {
  const lon = wrapLon(at.lon);
  return at.rise >= cell.riseMin && at.rise <= cell.riseMax
    && lon >= cell.lonMin && lon <= cell.lonMax;
}

/**
 * A cell's middle, which is where a readout names it from.
 *
 * @param cell any cell
 * @returns its centre
 */
export function cellCenter(cell: SeaCell): SeaPlace {
  return { lon: (cell.lonMin + cell.lonMax) / 2, rise: (cell.riseMin + cell.riseMax) / 2 };
}

/**
 * A place as a reader reads it, e.g. `45.0°E up 12.3°`.
 *
 * @param at the place
 * @param digits decimals to show on each axis
 * @returns the label
 */
export function seaLabel(at: SeaPlace, digits = 1): string {
  const ew = at.lon >= 0 ? 'E' : 'W';
  const up = at.rise >= 0 ? 'up' : 'down';
  return `${Math.abs(at.lon).toFixed(digits)}°${ew} ${up} ${Math.abs(at.rise).toFixed(digits)}°`;
}
