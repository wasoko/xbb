/**
 * restGraphWindow.ts — the rest list's wide view.
 *
 * The rest list is a column of rows; the graph over the same table needs width, so
 * the wide view is the same page opened in a window of its own with a flag in the
 * URL, and the list lays itself out as two panes when it sees that flag. Nothing is
 * persisted and nothing is written back: the window reads the table the list is
 * already showing.
 */

/** Query flag that opens the rest view as the two-pane layout. */
export const REST_GRAPH_PARAM = 'rgraph';

/** Share of the work area the wide window takes. */
const WIDTH_SHARE = 0.8;

/**
 * Whether a router query string asks for the wide view.
 *
 * @param search the hash query, as `useSearchParams` reports it
 * @returns true when the graph pane should be drawn
 */
export const restGraphOpen = (search: URLSearchParams): boolean =>
  search.get(REST_GRAPH_PARAM) !== null;

/**
 * This page's URL with the wide-view flag set, keeping whatever filter and row the
 * list is currently showing.
 *
 * @param href the current URL, hash and all — the router keeps its query there
 * @returns the URL to open
 */
export function restGraphUrl(href: string): string {
  const url = new URL(href);
  const at = url.hash.indexOf('?');
  const params = new URLSearchParams(at < 0 ? '' : url.hash.slice(at));
  params.set(REST_GRAPH_PARAM, '1');
  url.hash = `${at < 0 ? url.hash : url.hash.slice(0, at)}?${params}`;
  return url.toString();
}

/**
 * Open the wide view in a window of its own, sized and placed against the work
 * area: 80% of its width at the right edge, full height, so the list and the graph
 * are read together rather than one after the other.
 *
 * A blocked popup is not an error worth interrupting for — the button simply does
 * nothing, the same as any other `window.open` the browser refuses.
 */
export function openRestGraph(): void {
  const width = Math.round(window.screen.availWidth * WIDTH_SHARE);
  const height = window.screen.availHeight;
  window.open(restGraphUrl(window.location.href), '_blank',
    `popup=yes,width=${width},height=${height},left=${Math.max(0, window.screen.availWidth - width)},top=0`);
}
