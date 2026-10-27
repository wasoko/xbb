/**
 * bbLogin.ts — the small external store behind the Bilibili QR dialog.
 *
 * The dialog is mounted once at the app root so it survives the feed preview's
 * mouse-leave unmount. `FeedTip` opens it and watches `version` to rerun a read
 * after a successful scan.
 */

import { useSyncExternalStore } from 'react';

let open = false;
let version = 0;
const listeners = new Set<() => void>();

/** Notify every mounted hook. */
function emit(): void {
  for (const listener of listeners) listener();
}

/** Subscribe one store reader. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Open the QR dialog; a second call keeps the current dialog. */
export function openBbLogin(): void {
  if (open) return;
  open = true;
  emit();
}

/** Close the QR dialog without recording a login. */
export function closeBbLogin(): void {
  if (!open) return;
  open = false;
  emit();
}

/** Close the dialog and tell feed previews that a login just completed. */
export function completeBbLogin(): void {
  open = false;
  version += 1;
  emit();
}

/** Whether the root dialog should render. */
export function useBbLoginOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => false);
}

/** A counter a feed preview can watch to rerun after a login. */
export function useBbLoginVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}
