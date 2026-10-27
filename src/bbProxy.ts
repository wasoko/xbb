/**
 * bbProxy.ts — the webapp transport for `bb.ts`.
 *
 * The extension page reads Bilibili with browser cookies; the webapp cannot, so
 * this module turns the same requests into calls to the Supabase `cors_bb`
 * function. It also owns the QR handshake the function exposes.
 *
 * The client is deliberately free of app imports. `bbProxyInstall.ts` supplies
 * the Supabase URL, token, and browser storage.
 */

import { BbSignInError, type BbFetch } from './bb';

/** One QR code returned by the function's `/qr` route. */
export interface BbQrCode {
  /** URL the Bilibili app scans. */
  url: string;
  /** Key `/poll` sends back. */
  key: string;
}

/** One `/poll` answer, flattened for the login dialog. */
export interface BbQrPoll {
  /** Bilibili's outer code; 0 when the poll request itself succeeded. */
  code: number;
  /** Bilibili's outer message. */
  message: string;
  /** Bilibili's inner `data.code`: 86101 waiting, 86090 scanned, 86038 expired, 0 success. */
  dataCode: number;
  /** Bilibili's inner `data.message`. */
  dataMessage: string;
  /** True when the function stored the cookie server-side. */
  stored: boolean;
  /** Cookie pairs when the function returned them to the client. */
  cookie: string;
  /** The same pairs, unjoined. */
  cookies: string[];
}

/** What the webapp installs around one `cors_bb` function. */
export interface BbProxyOptions {
  /** Function base URL, e.g. `https://project.supabase.co/functions/v1/cors_bb`. */
  baseUrl: string;
  /** Supabase publishable key sent as `apikey`. */
  apikey: string;
  /** Access token of the signed-in Supabase session. */
  token: () => Promise<string>;
  /** Force-refresh the Supabase session once after a 401. */
  refreshToken?: () => Promise<string>;
  /** Test seam; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Client cookie to send, or '' when the server session owns the cookie. */
  cookie?: () => string;
  /** Store a cookie returned by `/poll`. */
  storeCookie?: (cookie: string) => void;
  /** Record whether `/poll` stored the cookie server-side. */
  setServerSession?: (enabled: boolean) => void;
  /** Remove only the client cookie. */
  clearCookie?: () => void;
  /** Remove the client cookie and the server-session flag. */
  clearSession?: () => void;
}

/** The Bilibili transport and QR calls one webapp session uses. */
export interface BbProxy {
  /** Transport `bb.ts` reads through. */
  fetch: BbFetch;
  /** Ask the function for a fresh QR code. */
  startQr(): Promise<BbQrCode>;
  /** Poll one QR code until Bilibili reports a terminal state. */
  pollQr(key: string): Promise<BbQrPoll>;
  /** Forget the function-side cookie and the local one. */
  logout(): Promise<void>;
}

/** `value` as a plain object, or null. */
const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/** `value` as a string; '' for null and undefined. */
const asString = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value);

/** `value` as a finite number, including a numeric string. */
const asNumber = (value: unknown): number | undefined => {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** `value` as a boolean. */
const asBoolean = (value: unknown): boolean =>
  value === true || value === 1 || value === '1';

/**
 * Build the webapp transport for one `cors_bb` function.
 *
 * @param opts the function URL, Supabase credentials, and browser storage port
 * @returns the transport plus the QR calls
 */
export function createBbProxy(opts: BbProxyOptions): BbProxy {
  const doFetch = opts.fetch ?? (globalThis.fetch as typeof fetch | undefined);
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function readJson(res: Response): Promise<Record<string, unknown> | null> {
    try {
      return asObject(await res.json());
    } catch {
      return null;
    }
  }

  async function request(
    route: string,
    body: unknown,
    signal?: AbortSignal,
    retry = true,
    forcedToken?: string,
  ): Promise<Response> {
    if (typeof doFetch !== 'function') throw new Error('bb proxy: fetch is unavailable');
    const token = forcedToken ?? await opts.token();
    const res = await doFetch(`${base}${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': opts.apikey,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (res.status === 401) {
      if (retry && opts.refreshToken !== undefined) {
        let next: string | undefined;
        try {
          next = await opts.refreshToken();
        } catch {
          // Keep the original 401 when the refresh itself cannot run.
        }
        return request(route, body, signal, false, next);
      }
      throw new BbSignInError();
    }
    return res;
  }

  async function call(
    route: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const res = await request(route, body, signal);
    const json = await readJson(res);
    if (!res.ok) {
      const detail = typeof json?.error === 'string' ? `: ${json.error}` : '';
      throw new Error(`bb proxy HTTP ${res.status}${detail}`);
    }
    if (json === null) throw new Error('bb proxy returned no JSON');
    return json;
  }

  /* Bilibili's `bb.ts` builds a full API URL; the function accepts the path and
     query parameters, plus the client cookie when server storage is off. */
  const apiFetch: BbFetch = async (url, init) => {
    const parsed = new URL(url);
    const cookie = opts.cookie?.() ?? '';
    const body: Record<string, unknown> = {
      path: parsed.pathname,
      params: Object.fromEntries(parsed.searchParams),
    };
    if (cookie !== '') body.cookie = cookie;
    const res = await request('/api', body, init.signal);
    const json = await readJson(res);
    if (json !== null && asNumber(json.code) === -101) opts.clearSession?.();
    return {
      ok: res.ok,
      status: res.status,
      json: async () => json ?? { code: -1, message: 'bb proxy returned no JSON' },
    };
  };

  async function startQr(): Promise<BbQrCode> {
    const json = await call('/qr', {});
    if (asNumber(json.code) !== 0) {
      throw new Error(asString(json.message) || 'bb proxy: QR request failed');
    }
    const data = asObject(json.data);
    const url = asString(data?.url);
    const key = asString(data?.qrcode_key);
    if (url === '' || key === '') {
      throw new Error('bb proxy: QR response is missing url or qrcode_key');
    }
    return { url, key };
  }

  async function pollQr(key: string): Promise<BbQrPoll> {
    const json = await call('/poll', { qrcode_key: key });
    const data = asObject(json.data);
    const dataCode = asNumber(data?.code) ?? -1;
    const dataMessage = asString(data?.message);
    const stored = asBoolean(json.stored);
    const cookie = asString(json.cookie);
    const cookies = Array.isArray(json.cookies) ? json.cookies.map(String) : [];

    if (dataCode !== 0 && dataCode !== 86_101 && dataCode !== 86_090 && dataCode !== 86_038) {
      throw new Error(dataMessage || `bb proxy: QR poll failed (${dataCode})`);
    }
    if (dataCode === 0) {
      if (stored) {
        opts.setServerSession?.(true);
        opts.clearCookie?.();
      } else if (cookie !== '') {
        opts.setServerSession?.(false);
        opts.storeCookie?.(cookie);
      } else {
        throw new Error('bb proxy: bilibili login returned no session');
      }
    }

    return {
      code: asNumber(json.code) ?? 0,
      message: asString(json.message),
      dataCode,
      dataMessage,
      stored,
      cookie,
      cookies,
    };
  }

  async function logout(): Promise<void> {
    try {
      await call('/logout', {});
    } finally {
      opts.clearSession?.();
    }
  }

  return { fetch: apiFetch, startQr, pollQr, logout };
}
