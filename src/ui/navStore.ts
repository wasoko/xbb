/** Actions the floating NavBar takes on panes it does not own: it renders beside the
 *  route element, so the editor drawer (`VbCard`) and the chat (`Chat`) subscribe here
 *  instead of the bar reaching into their state. */
export type NavIntent = 'tables' | 'agent';

const listeners = new Set<(kind: NavIntent) => void>();

/**
 * Announce a NavBar action.
 *
 * @param kind the button that was pressed
 */
export function emitNav(kind: NavIntent): void {
  for (const l of listeners) l(kind);
}

/**
 * Watch for NavBar actions.
 *
 * @param fn called with the intent after every {@link emitNav}
 * @returns the unsubscribe function
 */
export function subscribeNav(fn: (kind: NavIntent) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
