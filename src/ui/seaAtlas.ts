/**
 * seaAtlas.ts — the wall's text baked into canvas atlases.
 *
 * The wall draws label and annotation text as instanced quads, so every string has to be a
 * texture. One canvas page holds many cropped labels; the renderer tints them per instance,
 * which is what lets one page serve pinned names, reflected names and annotated rows.
 *
 * The packing is a plain shelf pack and knows nothing about canvas, so the capacity of a page
 * is testable without a browser.
 */

import * as THREE from 'three';

/** A label to bake. */
export interface AtlasRequest {
  key: string;
  text: string;
  fontPx: number;
  /** `700` for a tag's name, `500` for a row. */
  bold?: boolean;
}

/** A request with the width its font measured. */
export interface SizedRequest extends AtlasRequest {
  width: number;
}

/** One baked cell, in texture-normalized coordinates. */
export interface AtlasSlot {
  page: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Cell size in texture pixels. */
  w: number;
  h: number;
}

/** Where every label landed. */
export interface AtlasPlan {
  pages: { width: number; height: number }[];
  slots: Map<string, AtlasSlot>;
}

/** A page's own shape. */
export const ATLAS_PAGE_WIDTH = 2048;
export const ATLAS_PAGE_HEIGHT = 2048;

/** Pages the atlas may spend before it stops baking. */
export const ATLAS_PAGE_LIMIT = 4;

/** Space kept around a label inside its cell, in texture pixels. */
const PAD = 5;

/**
 * Pack measured labels into pages of shelves.
 *
 * Taller cells go first so a shelf's height stays uniform. A label wider than a page is dropped
 * rather than cut, because a cut cell would draw a different string than the one measured.
 *
 * @param items measured labels
 * @param pageWidth page width in pixels
 * @param pageHeight page height in pixels
 * @param pageLimit pages to fill before the rest are dropped
 * @returns the pages and the cell each label landed in
 */
export function planAtlas(
  items: readonly SizedRequest[],
  pageWidth = ATLAS_PAGE_WIDTH,
  pageHeight = ATLAS_PAGE_HEIGHT,
  pageLimit = ATLAS_PAGE_LIMIT,
): AtlasPlan {
  const order = [...items].sort((a, b) => b.fontPx - a.fontPx || b.width - a.width);
  const pages: { width: number; height: number }[] = [];
  const slots = new Map<string, AtlasSlot>();

  let page = -1;
  let x = 0;
  let y = 0;
  let shelf = 0;

  const openPage = (): boolean => {
    if (page + 1 >= pageLimit) return false;
    page++;
    pages.push({ width: pageWidth, height: pageHeight });
    x = 0;
    y = 0;
    shelf = 0;
    return true;
  };
  if (!openPage()) return { pages, slots };

  for (const item of order) {
    const w = Math.ceil(item.width) + PAD * 2;
    const h = Math.ceil(item.fontPx * 1.3) + PAD * 2;
    if (w > pageWidth || h > pageHeight) continue;
    if (x + w > pageWidth) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    if (y + h > pageHeight && !openPage()) break;
    slots.set(item.key, {
      page,
      u0: x / pageWidth,
      v0: y / pageHeight,
      u1: (x + w) / pageWidth,
      v1: (y + h) / pageHeight,
      w,
      h,
    });
    x += w;
    if (h > shelf) shelf = h;
  }
  return { pages, slots };
}

/** The font stack the labels are measured and painted with. */
const FONT_STACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/** The `canvas` font a label is drawn with. */
const fontOf = (item: AtlasRequest): string =>
  `${item.bold === true ? 700 : 500} ${item.fontPx}px ${FONT_STACK}`;

/**
 * Measure labels with one canvas.
 *
 * @param requests the labels
 * @returns the labels with the font's width, or `null` where no canvas exists
 */
export function measureRequests(requests: readonly AtlasRequest[]): SizedRequest[] | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  return requests.map((item) => {
    ctx.font = fontOf(item);
    return { ...item, width: ctx.measureText(item.text).width };
  });
}

/** Paint one label into its cell. */
function paint(
  ctx: CanvasRenderingContext2D, item: SizedRequest, slot: AtlasSlot,
  pageWidth: number, pageHeight: number,
): void {
  const x = slot.u0 * pageWidth;
  const y = slot.v0 * pageHeight;
  ctx.font = fontOf(item);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.shadowColor = 'rgba(0, 4, 9, 0.85)';
  ctx.shadowBlur = Math.max(2, item.fontPx * 0.2);
  ctx.lineWidth = Math.max(1, item.fontPx * 0.055);
  ctx.strokeStyle = 'rgba(0, 4, 9, 0.8)';
  ctx.strokeText(item.text, x + PAD, y + slot.h / 2);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(item.text, x + PAD, y + slot.h / 2);
}

/** The textures and cells a built atlas carries. */
export interface TextAtlas {
  textures: THREE.Texture[];
  slots: Map<string, AtlasSlot>;
}

/**
 * Bake labels into page textures.
 *
 * @param requests the labels
 * @returns the textures and their cells, or `null` when there is no canvas to bake with
 */
export function buildTextAtlas(requests: readonly AtlasRequest[]): TextAtlas | null {
  const sized = measureRequests(requests);
  if (sized === null || sized.length === 0) return null;
  const plan = planAtlas(sized);
  if (plan.pages.length === 0) return null;

  const canvases = plan.pages.map((page) => {
    const canvas = document.createElement('canvas');
    canvas.width = page.width;
    canvas.height = page.height;
    return canvas;
  });
  const contexts = canvases.map((canvas) => canvas.getContext('2d'));
  for (const item of sized) {
    const slot = plan.slots.get(item.key);
    const page = slot === undefined ? undefined : contexts[slot.page];
    if (slot === undefined || page === undefined || page === null) continue;
    paint(page, item, slot, plan.pages[slot.page].width, plan.pages[slot.page].height);
  }

  const textures = canvases.map((canvas) => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    texture.flipY = false;
    return texture;
  });
  return { textures, slots: plan.slots };
}

/**
 * The size a cell is drawn at, keeping the baked text's aspect.
 *
 * @param slot the cell
 * @param height drawn height in CSS pixels
 * @param fallbackWidth width used when the cell is missing
 * @returns drawn width and height
 */
export function cellSize(
  slot: AtlasSlot | undefined, height: number, fallbackWidth: number,
): { w: number; h: number } {
  if (slot === undefined) return { w: fallbackWidth, h: height };
  return { w: height * (slot.w / slot.h), h: height };
}
