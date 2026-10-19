/**
 * rowMeta.ts — the userscript-style header a `type='src'` row may carry.
 *
 * A row stays `type='src'`: what it needs from its host is declared in leading
 * `// @key value` comments, the dialect userscripts already use. The gate, the
 * UI and the runner read the same parse.
 *
 *   // @requires tab
 *   // @requires user-scripts
 *   // @match https://gemini.google.com/*
 *   // @max 200
 *   // @prompt open the chat sidebar (☰) in the Gemini tab
 */

/** What a row's header declares. */
export interface RowMeta {
  /** Host features the body needs, lowercased: `tab`, `extension`, `user-scripts`. */
  requires: string[];
  /** Tab URL pattern the body reads, in `chrome.tabs.query` match-pattern form. */
  match?: string;
  /** Most rows the body should return. */
  max?: number;
  /** What to tell the user when the page needs one manual step first. */
  prompt?: string;
  /** Every other `@key` line, values in source order. */
  extra: Record<string, string[]>;
}

/** One `// @key value` line; `//` may be indented and the value may be empty. */
const META_LINE = /^[ \t]*\/\/[ \t]*@([\w-]+)(?:[ \t]+(.*))?$/;

/**
 * Parse the leading `// @key value` comments of a row body.
 *
 * Scanning stops at the first line that is neither blank nor a `//` comment, so a
 * `@`-looking string inside the body is never metadata. Blank lines and plain `//`
 * comments may sit between header lines.
 *
 * @param body row text of a `type='src'` row
 * @returns the declared metadata; an absent header yields empty fields
 */
export function rowMeta(body: string): RowMeta {
  const out: RowMeta = { requires: [], extra: {} };
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue;
    if (!/^[ \t]*\/\//.test(line)) break;
    const m = line.match(META_LINE);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = (m[2] ?? '').trim();
    if (key === 'requires') {
      if (value) out.requires.push(...value.toLowerCase().split(/[\s,]+/).filter(Boolean));
    } else if (key === 'match') {
      if (value) out.match = value;
    } else if (key === 'max') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out.max = n;
    } else if (key === 'prompt') {
      if (value) out.prompt = value;
    } else if (value) {
      (out.extra[key] ??= []).push(value);
    }
  }
  return out;
}

/**
 * Whether a parsed header asks for a live tab (and therefore the extension).
 *
 * @param meta header from {@link rowMeta}
 * @returns true for `@requires tab`, `@requires extension` or `@requires user-scripts`
 */
export function needsTab(meta: RowMeta): boolean {
  return meta.requires.some(r => r === 'tab' || r === 'extension' || r === 'user-scripts');
}
