/**
 * @vitest-environment happy-dom
 *
 * restCue.test.ts — the two colour rules, in both the forms the app draws them in.
 *
 * The DOM panels take a `color-mix()` string and the sea's canvas takes channels, and
 * both have to read the same table the same way, so the tests pin the string a chip and a
 * graph node already depend on and check that the channel form agrees with it.
 */

import { describe, expect, it } from 'vitest';
import { getColorChar11 } from '../../src/fc';
import { shareCue, shareRgb, tagCue, tagRgb } from '../../src/ui/restCue';

/** Split a `rgb(r, g, b)` back into channels. */
const channels = (css: string): number[] =>
  css.slice(css.indexOf('(') + 1, css.indexOf(')')).split(',').map((n) => Number(n.trim()));

describe('tagCue', () => {
  it('still emits the colour-mix a chip is drawn with', () => {
    expect(tagCue('react')).toBe(`color-mix(in srgb, ${getColorChar11('react')} 70%, rgb(230, 236, 244))`);
  });

  it('agrees with the channel form, which the canvas takes', () => {
    const hex = getColorChar11('react');
    const n = Number.parseInt(hex.slice(1), 16);
    const [r, g, b] = tagRgb('react');
    const want = [((n >> 16) & 255), ((n >> 8) & 255), (n & 255)]
      .map((c, i) => (c + ([230, 236, 244][i] - c) * 0.7) / 255);
    expect([r, g, b].map((c) => Math.round(c * 255))).toEqual(want.map((c) => Math.round(c * 255)));
  });

  it('lifts a tag towards the pale end rather than leaving it dark', () => {
    const [r, g, b] = tagRgb('react');
    const raw = Number.parseInt(getColorChar11('react').slice(1), 16);
    const rawMin = Math.min((raw >> 16) & 255, (raw >> 8) & 255, raw & 255);
    /* The channels come back in 0..1 and the hex they came from in 0..255. */
    expect(Math.min(r, g, b) * 255).toBeGreaterThan(rawMin);
  });
});

describe('shareCue', () => {
  it('still emits the colour-mix a graph node is drawn with', () => {
    expect(shareCue(1)).toBe('color-mix(in srgb, rgb(232, 168, 76) 100%, rgb(94, 200, 214))');
    expect(shareCue(0)).toBe('color-mix(in srgb, rgb(232, 168, 76) 0%, rgb(94, 200, 214))');
  });

  it('reaches the two ends of the hue in the channel form as well', () => {
    expect(channels(`rgb(${shareRgb(1).map((c) => Math.round(c * 255)).join(', ')})`))
      .toEqual([232, 168, 76]);
    expect(channels(`rgb(${shareRgb(0).map((c) => Math.round(c * 255)).join(', ')})`))
      .toEqual([94, 200, 214]);
  });

  it('is flat at each end of the range and moves in between', () => {
    expect(shareRgb(-1)).toEqual(shareRgb(0));
    expect(shareRgb(2)).toEqual(shareRgb(1));
    expect(shareRgb(0.5)[0]).toBeGreaterThan(shareRgb(0)[0]);
    expect(shareRgb(0.5)[0]).toBeLessThan(shareRgb(1)[0]);
  });
});
