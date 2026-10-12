// src/ui/cropWidth.ts
import { useEffect } from 'react';
import { useTreeCac } from './useTreeCac';

/** CSS variable the shared `.crop-scroll` rule reads its width from, `index.html`. */
const CROP_W = '--crop-w';

/**
 * Keeps `--crop-w` on `documentElement` in step with `treeCac['cropWidth']`.
 *
 * The setting is one CSS width; `.crop-scroll` (the cs1 matches, the cs2 da rows
 * and the rest-tag chip strips) caps itself to that variable and falls back to
 * `max(33.33%, 222px)` when it is unset. Mounted once at the page root, so the
 * root variable reaches every row without each renderer reading the setting.
 *
 * An empty setting removes the variable rather than writing `''`, which would
 * make `max-width` invalid and leave the rows uncropped instead of at the
 * fallback width.
 *
 * @returns The configured width, for callers that need the value itself.
 */
export function useCropWidth(): string {
  const width = useTreeCac<string>('cropWidth');
  useEffect(() => {
    const style = document.documentElement.style;
    if (typeof width === 'string' && width.trim()) style.setProperty(CROP_W, width.trim());
    else style.removeProperty(CROP_W);
  }, [width]);
  return width;
}
