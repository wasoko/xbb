import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { getColorChar11, sideLog } from '../fc';
import { iq, type Da } from '../sdb';
import { isFeedRef } from '../wFeed';
import { headingMatchRuns, splitHeadingParts, type HeadingPart } from './cs1Token';
import { setTip, TIP_ATTR } from './Tip';

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

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
const CLOSING_HASH_RX = /\s+#+\s*$/;

function parseHeadings(txt: string): Heading[] {
  const result: Heading[] = [];
  for (const raw of (txt || '').split('\n')) {
    const m = raw.match(HEADING_RX);
    if (!m) continue;
    const level = m[1].length as HeadingLevel;
    const text = m[2].replace(CLOSING_HASH_RX, '').trim();
    if (!text) continue;
    const parts = splitHeadingParts(text);
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

/**
 * One matched row, in the cropped box the pin card and the sea's regions share.
 *
 * The whole text stays in the DOM so browser find-in-page can reach it; the shared
 * `.crop-scroll` rule caps the box and carries the tail sideways instead of covering it. The
 * row registers its own hover preview, so the same box reads the same way wherever it is
 * drawn — in a pin card's heading line, or over the sea.
 *
 * @param props.da - The row the box shows.
 * @param props.onSelectTag - Opens the row's ref; an `md` row is a button, any other a link.
 * @returns The row box.
 */
export function MatchRow({ da, onSelectTag }: { da: Da; onSelectTag: (ref: string) => void }) {
  const label = da.txt || da.ref;
  if (da.type === 'md') {
    return (
      <button
        className="cs1-match crop-scroll"
        onClick={() => onSelectTag(da.ref)}
        {...{ [TIP_ATTR]: '' }}
        ref={(el) => setTip(el, da)}
      >
        {label}
      </button>
    );
  }
  return (
    <Link
      className="cs1-match crop-scroll"
      to={da.ref}
      onClick={() => onSelectTag(da.ref)}
      {...{ [TIP_ATTR]: '' }}
      ref={(el) => setTip(el, da)}
    >
      {label}
    </Link>
  );
}

/**
 * The rows a tag set matches, as the pin card draws them under its heading.
 *
 * The tag index is asked for rows holding every tag given, so one heading's cumulative tags
 * ask for what its own line already promised. Rows are keyed by ref *and* tid because the
 * table can hold two rows under one ref, which a key of the ref alone renders as one.
 *
 * @param props.tags - The tags the index is asked for; none means no rows.
 * @param props.onSelectTag - Opens the row's ref in the editor pane.
 * @param props.limit - Rows to draw at most; `Infinity` draws all of them.
 * @param props.fallback - Rows to draw when the index answers with none, for a caller whose
 *   own evidence is older than the index — a tag a pass kept for rows that never persisted it.
 * @returns The matched rows, in the table's own order.
 */
export function TagMatchList({ tags, onSelectTag, limit = Infinity, fallback }: {
  tags: string[];
  onSelectTag: (ref: string) => void;
  limit?: number;
  fallback?: Da[];
}) {
  const key = tags.join(',');
  const asked = limit === Infinity ? undefined : limit;
  const das = useLiveQuery(
    async () => {
      if (!tags.length) return [] as Da[];
      return await iq(tags, undefined, undefined, asked);
    },
    [key, asked],
    [] as Da[],
  );
  const held = das.length > 0 ? das : (fallback ?? []);
  const listed = asked === undefined ? held : held.slice(0, asked);

  return (
    <>
      {listed.map((d) => (
        <MatchRow key={`${d.ref}\u0000${String(d.tid)}`} da={d} onSelectTag={onSelectTag} />
      ))}
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

/**
 * A `{ref}` token of a pin card heading.
 *
 * The click is the editor: the ref opens as a tab, and a ref with no row yet opens as a
 * draft there, which is how a pin card points at a document it wants written. The hover
 * is the document's own readout — `{w.feed.md}` previews its feed schedule, the sources
 * it reads and the items the last read stored, and any other ref previews as the row it
 * names.
 *
 * @param props.refName - the ref written between the braces
 * @param props.onSelectTag - opens a ref in the editor pane
 * @returns The token as a button.
 */
function RefButton({ refName, onSelectTag }: { refName: string; onSelectTag: (ref: string) => void }) {
  /* The feed document is the one ref whose preview reads other rows, so it is the one
     that asks for a body of its own; the row registered here carries the ref that body
     reads. Any `*.feed.md` is such a document, and a ref with no row yet opens on the
     template in the editor rather than on a blank draft. */
  const feed = isFeedRef(refName);
  const stand: Da = { ref: refName, type: 'md', txt: '', rec: {} };
  return (
    <button
      type="button"
      className="cs1-ref"
      title={feed ? `${refName} — schedule and the latest items` : `edit ${refName}`}
      onClick={() => onSelectTag(refName)}
      {...{ [TIP_ATTR]: '' }}
      ref={(el) => setTip(el, stand, feed ? 'wfeed' : undefined)}
    >
      {refName}
    </button>
  );
}

function Cs1Line({
  headings, onSelectTag,
}: { headings: Heading[]; onSelectTag: (ref: string) => void }) {
  /* The headings of a group are one line, so a heading shows the rows its own tags
     added to the group's path and shows none when it added none: `## a` under
     `# a #tag` must not repeat `#tag`'s matches. */
  const runs = headingMatchRuns(headings.map((h) => h.tags));
  return (
    <div className="cs1-line" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      {headings.map((h, i) => {
        const run = runs[i];
        return (
          <React.Fragment key={i}>
            <span style={HEAD_TEXT[h.level]}>
              {h.parts.map((p, j) => {
                if ('tag' in p) {
                  return (
                    <button
                      key={j}
                      className="cs1-tag"
                      onClick={() => onSelectTag(p.tag)}
                      style={tagBtnStyle(p.tag, h.level)}
                    >
                      #{p.tag}
                    </button>
                  );
                }
                if ('ref' in p) {
                  return <RefButton key={j} refName={p.ref} onSelectTag={onSelectTag} />;
                }
                return <React.Fragment key={j}>{p.text}</React.Fragment>;
              })}
            </span>
            {run.added.length > 0 && <TagMatchList tags={run.path} onSelectTag={onSelectTag} />}
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
 * Refs rendered by pin cards: one `iq` lookup per heading run, using the same
 * per-H1-group tag path as `Cs1Line`/`TagMatchList`, so the rest list can omit rows
 * a pin card already shows. A heading that adds no tag runs no query.
 *
 * @param pins - Pin card rows whose markdown headings are parsed.
 * @returns Refs matched by any pin card heading.
 */
export async function matchedRefsByPins(pins: Da[]): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const pin of pins) {
    for (const group of groupByH1(parseHeadings(pin.txt || ''))) {
      for (const run of headingMatchRuns(group.map((h) => h.tags))) {
        if (run.added.length === 0) continue;
        for (const d of await iq(run.path)) refs.add(d.ref);
      }
    }
  }
  return refs;
}
