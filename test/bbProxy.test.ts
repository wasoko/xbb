// @vitest-environment happy-dom
/**
 * bbProxy.test.ts — the webapp transport's request mapping and QR state handling.
 *
 * Every request goes through the injected `fetch`, so no test touches Supabase.
 */

import { describe, expect, it, vi } from 'vitest';
import { BbSignInError } from '../src/bb';
import { createBbProxy, type BbProxyOptions } from '../src/bbProxy';

/** One function response. */
const reply = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as unknown as Response;

/** Options with the test fetch and the overrides each case needs. */
const options = (
  fetchImpl: typeof fetch,
  overrides: Partial<BbProxyOptions> = {},
): BbProxyOptions => ({
  baseUrl: 'https://sb.test/functions/v1/cors_bb',
  apikey: 'pub',
  token: async () => 'token',
  fetch: fetchImpl,
  ...overrides,
});

describe('api transport', () => {
  it('maps a bilibili URL to /api with the client cookie', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return reply({ code: 0, data: { isLogin: true } });
    }) as typeof fetch;
    const proxy = createBbProxy(options(fetchImpl, { cookie: () => 'SESSDATA=x' }));

    const res = await proxy.fetch(
      'https://api.bilibili.com/x/web-interface/nav?a=1',
      { credentials: 'include' },
    );

    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ code: 0, data: { isLogin: true } });
    expect(calls[0]?.url).toBe('https://sb.test/functions/v1/cors_bb/api');
    expect(calls[0]?.init?.headers).toMatchObject({
      apikey: 'pub',
      Authorization: 'Bearer token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      path: '/x/web-interface/nav',
      params: { a: '1' },
      cookie: 'SESSDATA=x',
    });
  });

  it('omits the cookie when the server session owns it', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return reply({ code: 0, data: {} });
    }) as typeof fetch;
    const proxy = createBbProxy(options(fetchImpl, { cookie: () => '' }));

    await proxy.fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });

    expect(body).not.toHaveProperty('cookie');
  });

  it('clears the stored session when bilibili answers -101', async () => {
    const clearSession = vi.fn();
    const fetchImpl = (async () => reply({ code: -101, message: 'not logged in' })) as typeof fetch;
    const proxy = createBbProxy(options(fetchImpl, {
      cookie: () => 'SESSDATA=stale',
      clearSession,
    }));

    const res = await proxy.fetch(
      'https://api.bilibili.com/x/web-interface/nav',
      { credentials: 'include' },
    );

    expect(await res.json()).toMatchObject({ code: -101 });
    expect(clearSession).toHaveBeenCalledTimes(1);
  });
});

describe('QR login', () => {
  it('reads a QR code and a scanned poll', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? reply({ code: 0, data: { url: 'https://bili.test/qr', qrcode_key: 'key' } })
        : reply({ code: 0, data: { code: 86_090 }, stored: false, cookie: '', cookies: [] });
    }) as typeof fetch;
    const proxy = createBbProxy(options(fetchImpl));

    await expect(proxy.startQr()).resolves.toEqual({
      url: 'https://bili.test/qr',
      key: 'key',
    });
    const poll = await proxy.pollQr('key');

    expect(poll.dataCode).toBe(86_090);
    expect(bodies).toEqual([{}, { qrcode_key: 'key' }]);
  });

  it('stores the cookie a successful poll returns', async () => {
    const storeCookie = vi.fn();
    const setServerSession = vi.fn();
    const fetchImpl = (async () => reply({
      code: 0,
      data: { code: 0 },
      stored: false,
      cookie: 'SESSDATA=x',
      cookies: ['SESSDATA=x'],
    })) as typeof fetch;
    const proxy = createBbProxy(options(fetchImpl, { storeCookie, setServerSession }));

    const poll = await proxy.pollQr('key');

    expect(poll.dataCode).toBe(0);
    expect(storeCookie).toHaveBeenCalledWith('SESSDATA=x');
    expect(setServerSession).toHaveBeenCalledWith(false);
  });

  it('records a server-side session without storing the cookie', async () => {
    const storeCookie = vi.fn();
    const setServerSession = vi.fn();
    const clearCookie = vi.fn();
    const fetchImpl = (async () => reply({
      code: 0,
      data: { code: 0 },
      stored: true,
      cookie: '',
      cookies: [],
    })) as typeof fetch;
    const proxy = createBbProxy(options(fetchImpl, {
      storeCookie,
      setServerSession,
      clearCookie,
    }));

    await proxy.pollQr('key');

    expect(storeCookie).not.toHaveBeenCalled();
    expect(setServerSession).toHaveBeenCalledWith(true);
    expect(clearCookie).toHaveBeenCalledTimes(1);
  });

  it('refreshes the Supabase session once after a 401', async () => {
    let calls = 0;
    const auth: string[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const headers = init?.headers as Record<string, string> | undefined;
      auth.push(headers?.Authorization ?? '');
      return calls === 1
        ? reply({ error: 'Unauthorized' }, 401)
        : reply({ code: 0, data: { url: 'https://bili.test/qr', qrcode_key: 'key' } });
    }) as typeof fetch;
    const refreshToken = vi.fn(async () => 'new-token');
    const proxy = createBbProxy(options(fetchImpl, { refreshToken }));

    await expect(proxy.startQr()).resolves.toEqual({
      url: 'https://bili.test/qr',
      key: 'key',
    });
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(auth).toEqual(['Bearer token', 'Bearer new-token']);
    expect(calls).toBe(2);
  });

  it('reports a 401 that survives the refresh as a sign-in step', async () => {
    const fetchImpl = (async () => reply({ error: 'Unauthorized' }, 401)) as typeof fetch;
    const refreshToken = vi.fn(async () => 'new-token');
    const proxy = createBbProxy(options(fetchImpl, { refreshToken }));

    await expect(proxy.startQr()).rejects.toBeInstanceOf(BbSignInError);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });
});
