/**
 * seaSky.test.ts — where a place on the sea's cylinder is.
 *
 * The wall is one convention over a longitude and a height, and every other part of the sea
 * derives from it: the grid is drawn through `seaVec`, a click is read back through `vecSea`,
 * and the cell a click lands in is the cell the pointer was over. The tests check that round
 * trip, the grid ladder, and that the cells tile the wall without a gap or an overlap — the
 * property a sphere had to make an exception for at each pole.
 */

import { describe, expect, it } from 'vitest';
import {
  GRID_SPACINGS, cellCenter, cellHolds, gridSpacing, seaCell, seaLabel, seaVec, vecSea,
  visibleRise, wrapLon, type SeaPlace,
} from '../../src/ui/seaSky';

/** A spread of places, deliberately off the axes and off the grid lines. */
const PLACES: SeaPlace[] = [
  { lon: 0, rise: 0 }, { lon: 45.6, rise: 12.3 }, { lon: -122.25, rise: -37.5 },
  { lon: 179, rise: 89 }, { lon: -179, rise: -89 }, { lon: 90, rise: 400 },
];

describe('seaVec and vecSea', () => {
  it('puts lon 0 at +z, a rise above the equator towards +y and lon 90 at +x', () => {
    expect(seaVec({ lon: 0, rise: 0 })).toEqual([0, 0, 1]);
    expect(seaVec({ lon: 0, rise: 90 })[1]).toBeCloseTo(Math.PI / 2, 12);
    expect(seaVec({ lon: 0, rise: 90 })[0]).toBeCloseTo(0, 12);
    expect(seaVec({ lon: 90, rise: 0 })[0]).toBeCloseTo(1, 12);
    expect(seaVec({ lon: 90, rise: 0 })[2]).toBeCloseTo(0, 12);
  });

  it('measures the height as the same distance at every longitude', () => {
    /* The property a latitude does not have, and the one the whole placement rests on: no
       longitude is nearer the axis of the reading than another. */
    for (const lon of [0, 45.6, -122.25, 179]) {
      for (const rise of [-90, -12.3, 0, 37.5, 400]) {
        expect(seaVec({ lon, rise }, 100)[1]).toBeCloseTo(100 * rise * (Math.PI / 180), 9);
      }
    }
  });

  it('scales with the radius it is given', () => {
    for (const r of [1, 100]) {
      const p = seaVec({ lon: 30, rise: 40 }, r);
      expect(Math.hypot(p[0], p[2])).toBeCloseTo(r, 9);
    }
  });

  it('is undone by vecSea', () => {
    for (const at of PLACES) {
      const back = vecSea(...seaVec(at), 1);
      expect(back).not.toBeNull();
      expect(back?.lon).toBeCloseTo(at.lon, 9);
      expect(back?.rise).toBeCloseTo(at.rise, 9);
    }
  });

  it('reads a direction along the axis as no place at all', () => {
    expect(vecSea(0, 1, 0)).toBeNull();
    expect(vecSea(0, -3, 0)).toBeNull();
  });

  it('names a place by the wall the caller draws, not by the radius it was given', () => {
    expect(vecSea(10, 7, 0, 100)?.rise).toBeCloseTo(vecSea(1, 0.7, 0, 10)?.rise ?? 0, 9);
  });
});

describe('wrapLon', () => {
  it('folds any longitude into [-180, 180)', () => {
    expect(wrapLon(190)).toBeCloseTo(-170, 9);
    expect(wrapLon(-190)).toBeCloseTo(170, 9);
    expect(wrapLon(180)).toBeCloseTo(-180, 9);
    expect(wrapLon(-180)).toBeCloseTo(-180, 9);
    expect(wrapLon(540)).toBeCloseTo(-180, 9);
  });
});

describe('gridSpacing', () => {
  it('takes the coarsest rung that still draws a few cells across the view', () => {
    expect(gridSpacing(2)).toBe(1);
    expect(gridSpacing(20)).toBe(5);
    expect(gridSpacing(60)).toBe(15);
    /* 140 is the widest the sea opens, and it is the coarsest rung that keeps the band
       under a screen's worth of steps: 315 degrees of wall over a 45 degree grid. */
    expect(gridSpacing(140)).toBe(45);
  });

  it('never returns a spacing finer than the ladder holds', () => {
    for (const fov of [0.1, 1, 2, 5, 20, 90, 140]) {
      expect(GRID_SPACINGS).toContain(gridSpacing(fov));
    }
  });

  it('keeps the band under a screen of steps at every field of view the sea allows', () => {
    for (const fov of [1, 5, 20, 60, 90, 120, 140]) {
      const spacing = gridSpacing(fov);
      expect(visibleRise(fov) / spacing).toBeLessThan(12);
    }
  });
});

describe('visibleRise', () => {
  it('spans the wall the field of view covers, radius and all', () => {
    expect(visibleRise(90)).toBeCloseTo(2 * (180 / Math.PI), 9);
    expect(visibleRise(120)).toBeCloseTo(2 * Math.tan(Math.PI / 3) * (180 / Math.PI), 9);
    expect(visibleRise(60)).toBeLessThan(visibleRise(120));
  });
});

describe('seaCell', () => {
  it('holds the place it was asked about', () => {
    for (const at of PLACES) {
      for (const spacing of GRID_SPACINGS) {
        expect(cellHolds(seaCell(at, spacing), at)).toBe(true);
      }
    }
  });

  it('contains its own centre, so a cell names itself', () => {
    for (const at of PLACES) {
      for (const spacing of [2, 15, 45]) {
        const cell = seaCell(at, spacing);
        expect(seaCell(cellCenter(cell), spacing)).toEqual(cell);
      }
    }
  });

  it('tiles a meridian end to end, with no gap, no overlap and no end', () => {
    const spacing = 15;
    let rise = -90;
    while (rise < 90) {
      const cell = seaCell({ lon: 0, rise: rise + 1e-6 }, spacing);
      expect(cell.riseMin).toBeCloseTo(rise, 9);
      rise = cell.riseMax;
    }
    expect(rise).toBeCloseTo(90, 9);
    /* Past where a sphere ended there is simply more wall, and a cell is still a cell. */
    const far = seaCell({ lon: 0, rise: 100000 }, spacing);
    expect(far.riseMax - far.riseMin).toBeCloseTo(spacing, 9);
    expect(cellHolds(far, { lon: 0, rise: 100000 })).toBe(true);
  });

  it('tiles a parallel end to end, because every spacing divides 360', () => {
    for (const spacing of GRID_SPACINGS) {
      let lon = -180;
      let steps = 0;
      while (lon < 180) {
        const cell = seaCell({ lon: lon + 1e-6, rise: 0 }, spacing);
        expect(cell.lonMin).toBeCloseTo(lon, 9);
        expect(cell.lonMax).toBeCloseTo(lon + spacing, 9);
        lon = cell.lonMax;
        steps++;
      }
      expect(lon).toBeCloseTo(180, 9);
      expect(steps).toBe(360 / spacing);
    }
  });

  it('rejects a place outside the cell', () => {
    const cell = seaCell({ lon: 0, rise: 0 }, 15);
    expect(cellHolds(cell, { lon: 0, rise: 0 })).toBe(true);
    expect(cellHolds(cell, { lon: 0, rise: 20 })).toBe(false);
    expect(cellHolds(cell, { lon: 20, rise: 0 })).toBe(false);
    expect(cellHolds(cell, { lon: -20, rise: 0 })).toBe(false);
  });
});

describe('seaLabel', () => {
  it('names which way round the axis and which way up the wall a place is', () => {
    expect(seaLabel({ lon: 12.34, rise: -45.6 })).toBe('12.3°E down 45.6°');
    expect(seaLabel({ lon: -7, rise: 8 }, 0)).toBe('7°W up 8°');
  });
});
