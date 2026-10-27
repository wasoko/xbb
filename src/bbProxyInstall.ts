/**
 * bbProxyInstall.ts — wires the webapp Bilibili proxy to the app.
 *
 * `bbProxy.ts` has no app imports; this module supplies the Supabase URL, the
 * signed-in access token, and the browser storage that keeps the Bilibili cookie
 * (or records that the function stored it). `routes.tsx` calls
 * {@link installBbProxy} once at boot.
 */

import { BbSignInError, setBbFetch } from './bb';
import { createBbProxy, type BbQrCode, type BbQrPoll } from './bbProxy';
import { isExtensionPage } from './srcfeedTab';
import { treeCac } from './sdb';
import { sbg } from './greet';

/** Client cookie returned by `/poll` when server storage is off. */
const COOKIE_KEY = 'bb.bilibili.cookie';

/** Set when `/poll` stored the cookie on the function. */
const SERVER_KEY = 'bb.bilibili.server';

/* A private-mode page can refuse localStorage; the login still works for this
   mount through these values. */
let memoryCookie = '';
let memoryServer = false;

/** `localStorage`, or null where the page does not expose a usable one. */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Read one of the two Bilibili keys. */
function read(key: string): string {
  const store = storage();
  if (store !== null) {
    try {
      return store.getItem(key) ?? '';
    } catch {
      // Fall through to the in-memory value.
    }
  }
  return key === COOKIE_KEY ? memoryCookie : memoryServer ? '1' : '';
}

/** Write one of the two Bilibili keys. */
function write(key: string, value: string): void {
  const store = storage();
  if (store !== null) {
    try {
      store.setItem(key, value);
      return;
    } catch {
      // Fall through to the in-memory value.
    }
  }
  if (key === COOKIE_KEY) memoryCookie = value;
  else memoryServer = value === '1';
}

/** Remove one of the two Bilibili keys. */
function remove(key: string): void {
  const store = storage();
  if (store !== null) {
    try {
      store.removeItem(key);
    } catch {
      // Fall through to the in-memory value.
    }
  }
  if (key === COOKIE_KEY) memoryCookie = '';
  else memoryServer = false;
}

/** Whether `/poll` put the cookie on the function instead of this page. */
function serverSession(): boolean {
  return read(SERVER_KEY) === '1';
}

/** Access token of the signed-in Supabase session. */
async function sessionToken(refresh = false): Promise<string> {
  if (refresh) {
    const { data, error } = await sbg.auth.refreshSession();
    const token = data.session?.access_token;
    if (token) return token;
    throw new BbSignInError(error?.message);
  }
  const { data } = await sbg.auth.getSession();
  const token = data.session?.access_token;
  if (token) return token;
  throw new BbSignInError();
}

const SERVER_URL = String(treeCac['server'] ?? '').replace(/\/+$/, '');
const BASE_URL = `${SERVER_URL}/functions/v1/cors_bb`;
const API_KEY = String(treeCac['pub_key'] ?? '');

const proxy = createBbProxy({
  baseUrl: BASE_URL,
  apikey: API_KEY,
  token: () => sessionToken(false),
  refreshToken: () => sessionToken(true),
  cookie: () => (serverSession() ? '' : read(COOKIE_KEY)),
  storeCookie: (cookie) => {
    write(COOKIE_KEY, cookie);
    remove(SERVER_KEY);
  },
  setServerSession: (enabled) => {
    if (enabled) write(SERVER_KEY, '1');
    else remove(SERVER_KEY);
  },
  clearCookie: () => remove(COOKIE_KEY),
  clearSession: () => {
    remove(COOKIE_KEY);
    remove(SERVER_KEY);
  },
});

/** Ask `cors_bb` for a fresh Bilibili QR code. */
export const bbProxyQr = (): Promise<BbQrCode> => proxy.startQr();

/** Poll one Bilibili QR code through `cors_bb`. */
export const bbProxyPoll = (key: string): Promise<BbQrPoll> => proxy.pollQr(key);

/** Forget the Bilibili session on the function and in this page. */
export const bbProxyLogout = (): Promise<void> => proxy.logout();

/**
 * Install the proxy as `bb.ts`'s default transport.
 *
 * The extension page keeps using its own cookies, so this is a no-op there.
 */
export function installBbProxy(): void {
  if (isExtensionPage()) return;
  setBbFetch(proxy.fetch);
}
