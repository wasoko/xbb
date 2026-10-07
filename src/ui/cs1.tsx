import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { getColorChar11, sideLog } from '../fc';
import {  iq,  type Da } from '../sdb';
import { setTip, TIP_ATTR } from './Tip';

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** Heading text alternates plain runs and `#tag` tokens so a tag can render as a button where it sits. */
type HeadingPart = { text: string } | { tag: string };

interface Heading { level: HeadingLevel; parts: HeadingPart[]; tags: string[] }

/** H1 leads the group it starts, so its label stays louder than the deeper levels under it. */
const HEAD_TEXT: Record<HeadingLevel, React.CSSProperties> = {
  1: { fontWeight: 700, fontSize: 18 },
  2: { fontWeight: 500, fontSize: 16, opacity: 0.75 },
  3: { fontWeight: 500, fontSize: 14, opacity: 0.6 },
  4: { fontWeight: 400, fontSize: 13, opacity: 0.6 },
  5: { fontWeight: 400, fontSize: 12, opacity: 0.5 },
  6: { fontWeight: 400, fontSize: 11, opacity: 0.5 },
};

const HEADING_RX = /^(#{1,6})\s+(.+)$/;
/** A tag is a `#`-prefixed token after start or whitespace, so `e=`, `tabs=` and prose stay plain text. */
const HASHTAG_RX = /(^|\s)#([\p{L}\p{N}_]+)/gu;
const CLOSING_HASH_RX = /\s+#+\s*$/;

/** Splits heading text at each `#tag`; the separating whitespace stays in the preceding run. */
function splitTagParts(text: string): HeadingPart[] {
  const parts: HeadingPart[] = [];
  let last = 0;
  for (const m of text.matchAll(HASHTAG_RX)) {
    const at = m.index + m[1].length; // index of '#'
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ tag: m[2] });
    last = at + m[2].length + 1;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

function parseHeadings(txt: string): Heading[] {
  const result: Heading[] = [];
  for (const raw of (txt || '').split('\n')) {
    const m = raw.match(HEADING_RX);
    if (!m) continue;
    const level = m[1].length as HeadingLevel;
    const text = m[2].replace(CLOSING_HASH_RX, '').trim();
    if (!text) continue;
    const parts = splitTagParts(text);
    const tags = [...new Set(parts.flatMap((p) => ('tag' in p ? [p.tag] : [])))];
    result.push({ level, parts, tags });
  }
  console.log(`parseHeading:`,result)
  return result;
}

function groupByH1(headings: Heading[]): Heading[][] {
  const groups: Heading[][] = [];
  let current: Heading[] | null = null;
  for (const h of headings) {
    if (h.level === 1 || !current) { current = [h]; groups.push(current); }
    else current.push(h);
  }
  return groups;
}

function MatchedDas({
  tags, onSelectTag,
}: { tags: string[]; onSelectTag: (ref: string) => void }) {
  const key = tags.join(',');
  const das = useLiveQuery(
    async () => {
      if (!tags.length) return [] as Da[];
      const hits = await iq(tags);
      return hits;
    },
    [key],
    [] as Da[],
  );

  return (
    <>
      {das.map((d) => {
        // Full text stays in the DOM so browser find-in-page can reach it; CSS caps the row at 555px with a scroll.
        const label = d.txt || d.ref;
        if (d.type === 'md') {
          return (
            <button
              key={d.ref}
              className="cs1-match"
              onClick={() => onSelectTag(d.ref)}
              {...{ [TIP_ATTR]: '' }}
              ref={(el) => setTip(el, d)}
            >
              {label}
            </button>
          );
        }
        return (
          <Link
            key={d.ref}
            className="cs1-match"
            to={d.ref}
            onClick={() => onSelectTag(d.ref)}
            {...{ [TIP_ATTR]: '' }}
            ref={(el) => setTip(el, d)}
          >
            {label}
          </Link>
        );
      })}
    </>
  );
}

/** A tag button takes the heading's own size and weight, keeping only its background and box. */
const tagBtnStyle = (tag: string, level: HeadingLevel): React.CSSProperties => ({
  font: 'inherit',
  fontSize: HEAD_TEXT[level].fontSize,
  fontWeight: HEAD_TEXT[level].fontWeight,
  backgroundColor: getColorChar11(tag),
  color: 'white',
  border: 'none',
  borderRadius: 4,
  padding: '2px 6px',
  cursor: 'pointer',
});

function Cs1Line({
  headings, onSelectTag,
}: { headings: Heading[]; onSelectTag: (ref: string) => void }) {
  const accumulated: string[] = [];
  return (
    <div className="cs1-line" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      {headings.map((h, i) => {
        accumulated.push(...h.tags);
        const snapshot = [...accumulated];
        // sideLog('[cs1] Cs1Line heading', {
        //   level: h.level, parts: h.parts, tags: h.tags, snapshot,
        // });
        return (
          <React.Fragment key={i}>
            <span style={HEAD_TEXT[h.level]}>
              {h.parts.map((p, j) =>
                'tag' in p ? (
                  <button
                    key={j}
                    className="cs1-tag"
                    onClick={() => onSelectTag(p.tag)}
                    style={tagBtnStyle(p.tag, h.level)}
                  >
                    #{p.tag}
                  </button>
                ) : (
                  <React.Fragment key={j}>{p.text}</React.Fragment>
                ),
              )}
            </span>
            <MatchedDas tags={snapshot} onSelectTag={onSelectTag} />
          </React.Fragment>
        );
      })}
    </div>
  );
}

export function Cs1Renderer({ da, onSelectTag }: { da: Da; onSelectTag: (ref: string) => void }) {
  const groups = useMemo(() => groupByH1(parseHeadings(da.txt || '')), [da.txt]);
  // console.log('[cs1] Cs1Renderer', {
  //   ref: da.ref, type: da.type, txtLen: (da.txt || '').length, groups: groups.length,
  // });
  if (groups.length === 0) return null; // handled by caller (DaRow)

  return (
    <div className="cs1-renderer">
      {groups.map((line, i) => (
        <Cs1Line key={i} headings={line} onSelectTag={onSelectTag} />
      ))}
    </div>
  );
}

/**
 * Double-click handler for a pin card's non-interactive area. Events from the
 * card's own controls (tag buttons, matched-row buttons and links) are ignored
 * so they keep their own click behavior.
 *
 * @param ref - Pin card ref to open for editing.
 * @param onEdit - Opens the ref in the editor pane.
 * @returns Mouse handler that forwards only background double-clicks.
 */
export function cardDoubleClick(ref: string, onEdit: (ref: string) => void) {
  return (e: React.MouseEvent<Element>) => {
    const target = e.target as Element | null;
    if (target?.closest('button, a, input, textarea, select, [contenteditable]')) return;
    onEdit(ref);
  };
}

/**
 * Refs rendered by pin cards: one `iq` lookup per heading, using the same
 * per-H1-group cumulative tag snapshot as `Cs1Line`/`MatchedDas`, so the
 * rest list can omit rows a pin card already shows.
 *
 * @param pins - Pin card rows whose markdown headings are parsed.
 * @returns Refs matched by any pin card heading.
 */
export async function matchedRefsByPins(pins: Da[]): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const pin of pins) {
    for (const group of groupByH1(parseHeadings(pin.txt || ''))) {
      const accumulated: string[] = [];
      for (const h of group) {
        accumulated.push(...h.tags);
        if (accumulated.length === 0) continue;
        for (const d of await iq([...accumulated])) refs.add(d.ref);
      }
    }
  }
  return refs;
}
