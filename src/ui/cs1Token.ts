/**
 * cs1Token.ts — the inline tokens a pin card heading may carry.
 *
 * A heading is prose with two kinds of token in it: a `#tag`, which is the card's own
 * vocabulary and drives the matched rows under the heading, and a `{ref}`, which is a
 * document the card points at — `{w.feed.md}` is the feed's own row. Both are split out
 * of the text here so `ui/cs1.tsx` renders runs and buttons from one grammar, and so the
 * grammar is testable without the renderer's store. The tag path a group's headings
 * build — what each heading's matched rows are queried with — is built here too.
 */

/** One run of a heading: plain text, a `#tag`, or a `{ref}`. */
export type HeadingPart = { text: string } | { tag: string } | { ref: string };

/** A tag is a `#`-prefixed token after start or whitespace, and a ref is a `{…}` token
 *  with no whitespace in it, so `e=`, `tabs=` and prose stay plain text. */
const TOKEN_RX = /(^|\s)#([\p{L}\p{N}_]+)|\{([^}\s]+)\}/gu;

/**
 * Split heading text at each `#tag` and each `{ref}`; the whitespace before a token
 * stays in the run before it.
 *
 * @param text - one heading's text, its closing hashes already stripped
 * @returns the runs and tokens in written order
 */
export function splitHeadingParts(text: string): HeadingPart[] {
  const parts: HeadingPart[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RX)) {
    const tag = m[2];
    const named = m[3];
    const at = tag === undefined ? m.index : m.index + m[1].length;
    if (at > last) parts.push({ text: text.slice(last, at) });
    if (tag !== undefined) {
      parts.push({ tag });
      last = at + tag.length + 1;
    } else {
      parts.push({ ref: named });
      last = at + named.length + 2;
    }
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** What one heading of an H1 group matches on, and what it put there itself. */
export interface HeadingMatchRun {
  /** The tags accumulated down to this heading, in written order — the path `iq` narrows on. */
  path: string[];
  /** The tags this heading added to the path; empty when the heading above it already set the path. */
  added: string[];
}

/**
 * The tag path of every heading in one H1 group, in written order: a heading's
 * matched rows are the ones its own `#tag`s add, so a heading that adds nothing
 * matches nothing new instead of repeating the run standing above it.
 *
 * @param tagsPerHeading - each heading's own deduplicated tags, in group order
 * @returns one run per heading, in the same order, each `path` its own copy
 */
export function headingMatchRuns(tagsPerHeading: string[][]): HeadingMatchRun[] {
  const path: string[] = [];
  return tagsPerHeading.map((tags) => {
    const added = tags.filter((t) => !path.includes(t));
    path.push(...added);
    return { path: [...path], added };
  });
}
