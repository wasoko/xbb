/**
 * restCue.ts — the two colour rules the rest list's tag layer draws with.
 *
 * Both are over a tag or a share, so the chips beside a row, a cluster head, the graph
 * and the sea's star field read the same table the same way. Each rule is given twice:
 * as the CSS string a DOM panel takes, and as the channels a canvas takes, because a
 * `color-mix()` string means nothing to WebGL.
 */

import { getColorChar11 } from '../fc';

/** A colour, its channels in `0..255`. */
export type Rgb = readonly [number, number, number];

/** The pale end a tag's own hue is lifted towards: dark panel, so pure saturation is loud. */
const CUE_LIFT: Rgb = [230, 236, 244];

/** Share lifted towards the pale end by this fraction, as the percentage CSS takes. */
const CUE_LIFT_PCT = 70;

/** Lexical shares at the two ends of the hue: at or above the first is fully warm. */
const SHARE_HI = 0.9;
/** At or below this one is fully cool. */
const SHARE_LO = 0.1;

/** The two ends of the share hue: the exact lexical lists, and the neighbour walks. */
const SHARE_WARM: Rgb = [232, 168, 76];
const SHARE_COOL: Rgb = [94, 200, 214];

/**
 * The channels behind a tag's own hue, lifted the same way {@link tagCue} lifts it.
 *
 * @param tag any tag
 * @returns the lifted colour, channels in `0..1` as a GPU takes them
 */
export function tagRgb(tag: string): [number, number, number] {
  const hex = getColorChar11(tag);
  const n = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(n)) return [1, 1, 1];
  const raw: Rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return mix(raw, CUE_LIFT, CUE_LIFT_PCT / 100);
}

/**
 * The channels behind a lexical share, the same warm-to-cool reading {@link shareCue}
 * draws.
 *
 * @param share lexical share in `[0, 1]`, as `RowTagReport.qarf` carries it
 * @returns the colour, channels in `0..1` as a GPU takes them
 */
export function shareRgb(share: number): [number, number, number] {
  const t = shareWeight(share);
  return mix(SHARE_COOL, SHARE_WARM, t);
}

/**
 * Where a share sits between the two ends of the hue.
 *
 * @param share lexical share in `[0, 1]`
 * @returns 0 at the cool end, 1 at the warm one
 */
function shareWeight(share: number): number {
  return Math.min(1, Math.max(0, (share - SHARE_LO) / (SHARE_HI - SHARE_LO)));
}

/**
 * Two channel triples blended towards each other.
 *
 * @param from the colour at `t` 0
 * @param to the colour at `t` 1
 * @param t how far to travel, in `[0, 1]`
 * @returns the blended channels, in `0..1`
 */
function mix(from: Rgb, to: Rgb, t: number): [number, number, number] {
  const f = (i: number) => (from[i] + (to[i] - from[i]) * t) / 255;
  return [f(0), f(1), f(2)];
}

/** A channel triple as the `rgb(...)` a `color-mix()` takes. */
const cssRgb = (c: Rgb) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

/**
 * The tag's own hue, lifted for the dark panel. `getColorChar11` draws a tag at
 * full saturation, which is right for a filled chip and too loud for a 1px border.
 *
 * @param tag any tag
 * @returns a CSS colour
 */
export const tagCue = (tag: string): string =>
  `color-mix(in srgb, ${getColorChar11(tag)} ${CUE_LIFT_PCT}%, ${cssRgb(CUE_LIFT)})`;

/**
 * The hue a lexical share is drawn in: warm where the exact lexical lists carried
 * the row, cool where the neighbour walks and the semantic list did.
 *
 * It is deliberately not the tag's own hue — the share is a property of the rows,
 * so the graph reads as a field over the table rather than as a second tag colour.
 *
 * @param share lexical share in `[0, 1]`, as `RowTagReport.qarf` carries it
 * @returns a CSS colour
 */
export const shareCue = (share: number): string =>
  `color-mix(in srgb, ${cssRgb(SHARE_WARM)} ${Math.round(shareWeight(share) * 100)}%, ${cssRgb(SHARE_COOL)})`;
