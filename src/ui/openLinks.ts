import {
  Decoration, EditorView, MatchDecorator, ViewPlugin,
  type DecorationSet, type ViewUpdate,
} from '@codemirror/view';

/** A markdown link, or a bare URL; the opening target is capture 1 for the former. */
const linkPattern = () => /\[[^\]\n]*\]\(\s*([^)\s]+)[^)]*\)|https?:\/\/[^\s<>()"'\]]+/g;

/** Pattern for hit testing; `matchAll` leaves its `lastIndex` alone. */
const LINK = linkPattern();

/**
 * The URL a position on one line belongs to.
 *
 * A markdown link matches from its `[` through its `)`, so a click on the label opens it.
 * Trailing sentence punctuation is not part of a bare URL.
 *
 * @param text - the line's text
 * @param at - offset into `text`
 * @returns the URL to open, or undefined when the position is not in a link
 */
export function linkAtText(text: string, at: number): string | undefined {
  for (const match of text.matchAll(LINK)) {
    const from = match.index ?? 0;
    if (at < from || at > from + match[0].length) continue;
    return (match[1] || match[0]).replace(/[.,;:!?]+$/, '');
  }
  return undefined;
}

/**
 * Opens the link under a pointer event.
 *
 * @param view - the editor view
 * @param event - event carrying the client coordinates
 * @returns whether a link was opened
 */
function openAt(view: EditorView, event: MouseEvent): boolean {
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos == null) return false;
  const line = view.state.doc.lineAt(pos);
  const url = linkAtText(line.text, pos - line.from);
  if (!url) return false;
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

/** Marks every link range so the theme below can style it. */
const linkMarks = new MatchDecorator({
  regexp: linkPattern(),
  decoration: Decoration.mark({ class: 'cm-open-link' }),
});

const linkDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = linkMarks.createDeco(view);
  }

  update(update: ViewUpdate) {
    this.decorations = linkMarks.updateDeco(update, this.decorations);
  }
}, {
  decorations: value => value.decorations,
});

/** Underline a link; on hover, outline it instead of using a border so text does not reflow. */
const linkTheme = EditorView.baseTheme({
  '.cm-open-link': {
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    '&:hover': {
      outline: '1px solid currentColor',
      outlineOffset: '1px',
      borderRadius: '2px',
      cursor: 'pointer',
    },
  },
});

/**
 * Opens a link on Ctrl/Cmd+click, middle click, or a touch long press, and marks each
 * link so it reads as one.
 *
 * A plain click or tap is left to the editor, so it still places the cursor and opens the
 * keyboard on a phone; only the shortcuts over a link consume the event.
 */
export const openLinks = [
  linkDecorations,
  linkTheme,
  EditorView.domEventHandlers({
    mousedown(event, view) {
      const shortcut = (event.button === 0 && (event.ctrlKey || event.metaKey))
        || event.button === 1;
      return shortcut && openAt(view, event);
    },
    contextmenu(event, view) {
      // a mouse right-click keeps its menu; touch has no modifier key
      return event.pointerType === 'touch' && openAt(view, event);
    },
  }),
];
