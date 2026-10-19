/**
 * seaWall.test.ts — the tag canvas as a function of the table.
 *
 * The wall owes four things to a reader: the first pinned heading stands exactly at sea level
 * under the star, every other pinned heading is below it, the clouds tile one continuous arc
 * without a gap, and every point is a row the table actually kept. The tests pin those, the
 * mirrored half above the horizon, and the determinism of the scatter.
 */

import { describe, expect, it } from 'vitest';
import { buildWall, regionOnWall } from '../../src/ui/seaWall';
import { graphFromTags } from '../../src/ui/seaTags';
import type { SeaRow, SeaTag } from '../../src/ui/seaTags';

const TAGS: SeaTag[] = [
  { tag: 'alpha', reach: 'pinned', kind: 'pinned', score: 0.9, weight: 40, freq: 40, lambda: 0.4 },
  { tag: 'area', reach: 'pinned', kind: 'pinned', score: 0.8, weight: 30, freq: 30, lambda: 0.3 },
  { tag: 'area/topic', reach: 'related', kind: 'theme', score: 4, weight: 9, freq: 9 },
  { tag: 'beta', reach: 'related', kind: 'head', score: 0.7, weight: 20, freq: 20, lambda: 0.5 },
  { tag: 'gamma', reach: 'own', kind: 'own', score: 0.6, weight: 10, freq: 10, lambda: 0.6 },
  { tag: 'delta', reach: 'own', kind: 'own', score: 0.5, weight: 4, freq: 4 },
];

const RELATIONS = {
  web: [
    { a: 'alpha', b: 'beta', w: 12 },
    { a: 'beta', b: 'gamma', w: 3 },
  ],
  themes: [{ theme: 'area/topic', anchor: 'area', count: 9 }],
  bursts: [],
  aliases: [],
  synonyms: [],
};

const GRAPH = graphFromTags(TAGS, RELATIONS);

const row = (tag: string, i: number): SeaRow => ({
  key: `${tag}-${i}`,
  ref: `https://example.com/${tag}/${i}`,
  text: `${tag} row ${i}`,
  label: `${tag} row ${i}`,
  action: 'link',
  type: 'tab',
});

const rowsOf = (tag: string): SeaRow[] => [
  row(tag, 0), row(tag, 1), row(tag, 2), row(tag, 3), row(tag, 4), row(tag, 5), row(tag, 6),
];

const WALL = buildWall(GRAPH, TAGS, rowsOf);
const SHAPE = { pinCol: 46, areaPerRow: 4, labelDeg: 15 };

describe('the star and the pin column', () => {
  const wall = buildWall(GRAPH, TAGS, rowsOf, SHAPE);

  it('puts the first pinned heading at sea level and the rest below it', () => {
    expect(wall.star).toEqual({ lon: 0, rise: 0, pin: 'alpha' });
    expect(wall.pins[0].tag).toBe('alpha');
    expect(wall.pins[0].rise1).toBeCloseTo(0, 9);
    for (const pin of wall.pins.slice(1)) {
      expect(pin.rise1).toBeLessThanOrEqual(0);
    }
  });

  it('keeps the pinned column on the centre meridian', () => {
    for (const pin of wall.pins) {
      expect(pin.lon0).toBeCloseTo(-23, 9);
      expect(pin.lon1).toBeCloseTo(23, 9);
    }
  });

  it('annotates a pinned heading and no one else', () => {
    for (const region of wall.regions) {
      if (region.reach === 'pinned' && !region.reflection) {
        expect(region.annotations.length).toBeGreaterThan(0);
      } else {
        expect(region.annotations).toEqual([]);
      }
    }
  });
});

describe('the cloud ring', () => {
  const wall = buildWall(GRAPH, TAGS, rowsOf, SHAPE);
  const clouds = wall.regions.filter((region) => !region.reflection
    && region.reach !== 'pinned' && region.reach !== 'alias');

  it('starts at the column edge and tiles the arc with no gap', () => {
    const sorted = [...clouds].sort((a, b) => a.lon0 - b.lon0);
    expect(sorted[0].lon0).toBeCloseTo(wall.arc.start, 9);
    expect(sorted[sorted.length - 1].lon1).toBeCloseTo(wall.arc.end, 9);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].lon0).toBeCloseTo(sorted[i - 1].lon1, 6);
    }
  });

  it('keeps every cloud below the horizon', () => {
    for (const cloud of clouds) expect(cloud.rise1).toBeLessThanOrEqual(0);
  });

  it('mirrors every cloud above the horizon, dark and unlabelled', () => {
    const reflections = wall.regions.filter((region) => region.reflection);
    expect(reflections.length).toBe(clouds.length);
    for (const reflection of reflections) {
      expect(reflection.above).toBe(true);
      expect(reflection.label).toBe(false);
      expect(reflection.points).toEqual([]);
      expect(reflection.rise0).toBeGreaterThanOrEqual(0);
    }
    expect(wall.above).toBeGreaterThan(0);
    expect(wall.below).toBeLessThan(0);
  });

  it('gives a wide cell its name and a narrow one a hover', () => {
    for (const cloud of clouds) {
      expect(cloud.label).toBe(cloud.lon1 - cloud.lon0 >= 15);
    }
  });
});

describe('the link points', () => {
  const wall = WALL;

  it('places every point inside the region it belongs to', () => {
    for (const region of wall.regions) {
      for (const point of region.points) {
        expect(point.tag).toBe(region.tag);
        expect(point.lon).toBeGreaterThanOrEqual(region.lon0);
        expect(point.lon).toBeLessThanOrEqual(region.lon1);
        expect(point.rise).toBeGreaterThanOrEqual(region.rise0);
        expect(point.rise).toBeLessThanOrEqual(region.rise1);
      }
    }
  });

  it('places only rows the tag was kept by, and never in the reflection', () => {
    for (const point of wall.points) {
      expect(point.ref.startsWith(`https://example.com/${point.tag}/`)).toBe(true);
      expect(point.above).toBe(false);
    }
  });

  it('draws no points for a tag no row kept', () => {
    const wallNoRows = buildWall(GRAPH, TAGS, (tag) => (tag === 'delta' ? [] : rowsOf(tag)));
    const delta = wallNoRows.regions.find((region) => region.tag === 'delta' && !region.reflection);
    expect(delta?.points).toEqual([]);
  });

  it('lays the same points out every time', () => {
    const again = buildWall(GRAPH, TAGS, rowsOf);
    expect(JSON.stringify(again)).toBe(JSON.stringify(wall));
  });
});

describe('reading a place', () => {
  const wall = buildWall(GRAPH, TAGS, rowsOf, SHAPE);

  it('finds the region under the star', () => {
    expect(regionOnWall(wall.regions, 0, -1)?.tag).toBe('alpha');
  });

  it('reads a wrapped longitude as the cloud on the far side', () => {
    const far = wall.regions.find((region) => !region.reflection
      && region.lon0 > 180 && region.reach !== 'pinned' && region.reach !== 'alias');
    expect(far).toBeDefined();
    const observed = far!.lon0 + 1 - 360;
    expect(regionOnWall(wall.regions, observed, (far!.rise0 + far!.rise1) / 2)?.tag).toBe(far!.tag);
  });

  it('finds nothing in the black above the reflections', () => {
    expect(regionOnWall(wall.regions, 0, 5000)).toBeNull();
  });
});
