// @vitest-environment happy-dom
/**
 * bb.test.ts — the Bilibili reader's own work: URL parsing, history cursor walking,
 * the two list sources, and the signed-out refusal. Every request goes through the
 * `fetch` seam, so no test touches the network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bbFeed, bbHistory, bbList, bbLists, bbNav, bbSubs, BbSignInError, installBbApiGlobal, mmss,
  parseListUrl, setBbFetch,
  type BbFetch,
} from '../src/bb';

/** One API response. */
const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

afterEach(() => {
  setBbFetch(undefined);
});

/** A history item; `business` varies the kind the reader filters on. */
const historyItem = (index: number, business = 'archive') => ({
  title: `t${index}`,
  long_title: '',
  author_name: 'up',
  view_at: 1_700_000_000 + index,
  duration: 65,
  progress: 0,
  cover: `cover${index}`,
  history: {
    oid: String(index),
    bvid: `BV${index}`,
    business,
  },
});

/** A favorite-folder video. */
const videoItem = (index: number) => ({
  id: String(10 + index),
  bvid: `BV1${index}`,
  title: `v${index}`,
  upper: { name: 'up1' },
  duration: 125,
  pubtime: 1_700_000_000 + index,
  cover: `c${index}`,
});

describe('mmss', () => {
  it('writes a short and a long duration', () => {
    expect(mmss(65)).toBe('1:05');
    expect(mmss(3665)).toBe('1:01:05');
  });
});

describe('parseListUrl', () => {
  it('reads a favorite folder', () => {
    expect(parseListUrl('https://space.bilibili.com/123/favlist?fid=456&ftype=collect'))
      .toEqual({ kind: 'fav', mediaId: '456', mid: '123' });
    expect(parseListUrl('https://www.bilibili.com/medialist/detail/ml789'))
      .toEqual({ kind: 'fav', mediaId: '789', mid: '' });
    expect(parseListUrl('https://www.bilibili.com/list/ml789'))
      .toEqual({ kind: 'fav', mediaId: '789', mid: '' });
    expect(parseListUrl('https://space.bilibili.com/486979785/favlist?fid=5292482&ftype=collect&ctype=21'))
      .toEqual({ kind: 'season', seasonId: '5292482', mid: '486979785' });
  });

  it('reads a season and a series', () => {
    expect(parseListUrl('https://space.bilibili.com/123/lists/321?type=season'))
      .toEqual({ kind: 'season', seasonId: '321', mid: '123' });
    expect(parseListUrl('https://space.bilibili.com/123/lists/321?type=series'))
      .toEqual({ kind: 'series', seriesId: '321', mid: '123' });
    expect(parseListUrl('https://www.bilibili.com/list/321?type=season'))
      .toEqual({ kind: 'season', seasonId: '321', mid: '' });
  });

  it('refuses a URL that names no list', () => {
    expect(parseListUrl('https://example.com/favlist?fid=1')).toBeNull();
    expect(parseListUrl('https://space.bilibili.com/123/')).toBeNull();
  });
});

describe('bbNav', () => {
  it('reports the logged-in account', async () => {
    const fetchImpl: BbFetch = async () => reply({
      code: 0, data: { isLogin: true, mid: 7, uname: 'me' },
    });
    await expect(bbNav({ fetch: fetchImpl })).resolves.toEqual({
      isLogin: true, mid: '7', uname: 'me',
    });
  });
});

describe('bbHistory', () => {
  it('walks cursor pages until the default 111 rows', async () => {
    const calls: URL[] = [];
    const fetchImpl: BbFetch = async (raw) => {
      const url = new URL(raw);
      calls.push(url);
      const page = calls.length;
      const count = page < 4 ? 30 : page === 4 ? 21 : 0;
      const start = (page - 1) * 30;
      return reply({
        code: 0,
        data: {
          list: Array.from({ length: count }, (_, i) => historyItem(start + i)),
          cursor: { max: String(page * 10), view_at: String(page * 1000), business: 'archive', ps: 30 },
        },
      });
    };

    const out = await bbHistory({}, { fetch: fetchImpl });

    expect(calls).toHaveLength(4);
    expect(calls[0].searchParams.get('ps')).toBe('30');
    expect(calls[0].searchParams.get('max')).toBeNull();
    expect(calls[1].searchParams.get('max')).toBe('10');
    expect(calls[1].searchParams.get('view_at')).toBe('1000');
    expect(calls[3].searchParams.get('ps')).toBe('21');
    expect(out.rows).toHaveLength(111);
    expect(out.rows[0].txt).toBe('t0 — up · 1:05');
    expect(out.rows[0].ref).toBe('https://www.bilibili.com/video/BV0');
    expect(out.rows[0].dt?.getTime()).toBe(1_700_000_000_000);
    expect(out.rows[0].tags).toEqual(['bilibili', 'history']);
    expect(out.rows[0].rec?.bvid).toBe('BV0');
    expect(out.notes).toContain('history: stopped at 111');
  });

  it('filters non-video history entries', async () => {
    const fetchImpl: BbFetch = async () => reply({
      code: 0,
      data: {
        list: [historyItem(1, 'live'), historyItem(2)],
      },
    });

    const out = await bbHistory({}, { fetch: fetchImpl });

    expect(out.rows.map((row) => row.ref)).toEqual(['https://www.bilibili.com/video/BV2']);
  });

  it('turns a signed-out response into the login step', async () => {
    const fetchImpl: BbFetch = async () => reply({ code: -101, message: '账号未登录' });

    const out = await bbHistory({}, { fetch: fetchImpl });

    expect(out.rows).toEqual([]);
    expect(out.needsUser).toContain('https://passport.bilibili.com/login');
  });

  it('refuses a non-extension realm before attempting a request', async () => {
    const out = await bbHistory({});

    expect(out.needsUser).toContain('extension page');
    expect(out.needsUser).toContain('https://passport.bilibili.com/login');
  });

  it('uses an installed webapp transport', async () => {
    setBbFetch(async () => reply({ code: 0, data: { list: [historyItem(7)] } }));

    const out = await bbHistory({ limit: 1 });

    expect(out.rows.map((row) => row.ref)).toEqual(['https://www.bilibili.com/video/BV7']);
  });

  it('turns a missing Supabase session into a sign-in step', async () => {
    setBbFetch(async () => {
      throw new BbSignInError();
    });

    const out = await bbHistory({});

    expect(out.needsUser).toContain('sign in to the webapp');
  });
});

describe('bbLists', () => {
  it('lists created folders and both subscribed kinds with their owner', async () => {
    const fetchImpl: BbFetch = async (raw) => {
      const url = new URL(raw);
      if (url.pathname === '/x/web-interface/nav') {
        return reply({ code: 0, data: { isLogin: true, mid: 1, uname: 'me' } });
      }
      if (url.pathname === '/x/v3/fav/folder/created/list-all') {
        return reply({
          code: 0,
          data: { list: [{ id: 10, fid: 10, mid: 1, title: 'mine', media_count: 2 }] },
        });
      }
      if (url.pathname === '/x/v3/fav/folder/collected/list') {
        expect(url.searchParams.get('platform')).toBe('web');
        return reply({
          code: 0,
          data: {
            list: [
              { id: 20, mid: 2, title: 'fav', media_count: 3, type: 11, upper: { mid: 2, name: 'ownerA' } },
              { id: 30, mid: 3, title: 'season', media_count: 5, type: 21, upper: { mid: 3, name: 'ownerB' } },
            ],
            has_more: false,
          },
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    };

    const out = await bbLists({}, { fetch: fetchImpl });

    expect(out.rows.map((row) => row.txt)).toEqual([
      'mine · 2 个视频',
      'fav - ownerA · 3 个视频',
      'season - ownerB · 5 个视频',
    ]);
    expect(out.rows.map((row) => row.ref)).toEqual([
      'https://space.bilibili.com/1/favlist?fid=10&ftype=create',
      'https://space.bilibili.com/1/favlist?fid=20&ftype=collect',
      'https://space.bilibili.com/1/favlist?fid=30&ftype=collect&ctype=21',
    ]);
    expect(out.rows[2].tags).toEqual(['bilibili', 'season', 'collected']);
    expect(out.rows[2].rec?.kind).toBe('season');
  });

  it('turns a signed-out nav into the login step', async () => {
    const fetchImpl: BbFetch = async () => reply({
      code: 0, data: { isLogin: false, mid: 0, uname: '' },
    });

    const out = await bbLists({}, { fetch: fetchImpl });

    expect(out.needsUser).toContain('https://passport.bilibili.com/login');
  });

  it('caps the rows at the requested limit', async () => {
    const fetchImpl: BbFetch = async (raw) => {
      const url = new URL(raw);
      if (url.pathname === '/x/web-interface/nav') {
        return reply({ code: 0, data: { isLogin: true, mid: 1, uname: 'me' } });
      }
      if (url.pathname === '/x/v3/fav/folder/created/list-all') {
        return reply({ code: 0, data: { list: [{ id: 10, mid: 1, title: 'mine', media_count: 2 }] } });
      }
      return reply({
        code: 0,
        data: {
          list: [
            { id: 20, mid: 2, title: 'a', media_count: 1, type: 11 },
            { id: 30, mid: 3, title: 'b', media_count: 1, type: 21 },
          ],
          has_more: false,
        },
      });
    };

    const out = await bbLists({ limit: 2 }, { fetch: fetchImpl });

    expect(out.rows).toHaveLength(2);
    expect(out.notes).toContain('lists: stopped at 2');
  });
});

describe('bbList', () => {
  it('walks a favorite folder in its own order', async () => {
    const fetchImpl: BbFetch = async (raw) => {
      const url = new URL(raw);
      if (url.pathname !== '/x/v3/fav/resource/list') throw new Error(`unexpected ${url.pathname}`);
      const first = url.searchParams.get('pn') === '1';
      return reply({
        code: 0,
        data: {
          medias: first ? [videoItem(1), videoItem(2)] : [videoItem(3)],
          has_more: first,
        },
      });
    };

    const out = await bbList({
      url: 'https://space.bilibili.com/1/favlist?fid=10&ftype=create',
    }, { fetch: fetchImpl });

    expect(out.rows.map((row) => row.ref)).toEqual([
      'https://www.bilibili.com/video/BV11',
      'https://www.bilibili.com/video/BV12',
      'https://www.bilibili.com/video/BV13',
    ]);
    expect(out.rows[0].txt).toBe('v1 — up1 · 2:05');
    expect(out.rows[0].dt).toBeUndefined();
    expect(out.rows[0].rec?.media_id).toBe('10');
  });

  it('reads a UGC season from one response', async () => {
    const fetchImpl: BbFetch = async (raw) => {
      const url = new URL(raw);
      if (url.pathname !== '/x/space/fav/season/list') throw new Error(`unexpected ${url.pathname}`);
      return reply({ code: 0, data: { info: {}, medias: [videoItem(3), videoItem(4)] } });
    };

    const out = await bbList({
      url: 'https://space.bilibili.com/3/lists/30?type=season',
    }, { fetch: fetchImpl });

    expect(out.rows.map((row) => row.ref)).toEqual([
      'https://www.bilibili.com/video/BV13',
      'https://www.bilibili.com/video/BV14',
    ]);
    expect(out.rows[0].tags).toEqual(['bilibili', 'season']);
    expect(out.rows[0].rec?.season_id).toBe('30');
  });

  it('asks for a list URL when the entry has none', async () => {
    const fetchImpl = vi.fn<BbFetch>();
    const out = await bbList({}, { fetch: fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.needsUser).toContain('bb-list needs a list URL');
  });
});

describe('bbSubs', () => {
  it('reads videos from every subscribed folder and season', async () => {
    const fetchImpl: BbFetch = async (raw) => {
      const url = new URL(raw);
      if (url.pathname === '/x/web-interface/nav') {
        return reply({ code: 0, data: { isLogin: true, mid: 1, uname: 'me' } });
      }
      if (url.pathname === '/x/v3/fav/folder/collected/list') {
        return reply({
          code: 0,
          data: {
            list: [
              { id: 20, mid: 2, title: 'fav', media_count: 2, type: 11, upper: { mid: 2, name: 'ownerA' } },
              { id: 30, mid: 3, title: 'season', media_count: 2, type: 21, upper: { mid: 3, name: 'ownerB' } },
            ],
            has_more: false,
          },
        });
      }
      if (url.pathname === '/x/v3/fav/resource/list') {
        return reply({ code: 0, data: { medias: [videoItem(1), videoItem(2)], has_more: false } });
      }
      if (url.pathname === '/x/space/fav/season/list') {
        return reply({ code: 0, data: { medias: [videoItem(3), videoItem(4)] } });
      }
      throw new Error(`unexpected ${url.pathname}`);
    };

    const out = await bbSubs({ perList: 5 }, { fetch: fetchImpl });

    expect(out.rows.map((row) => row.ref)).toEqual([
      'https://www.bilibili.com/video/BV14',
      'https://www.bilibili.com/video/BV13',
      'https://www.bilibili.com/video/BV12',
      'https://www.bilibili.com/video/BV11',
    ]);
    expect(out.rows[0].dt?.getTime()).toBe(1_700_000_004_000);
    expect(out.rows[0].rec?.sub).toBe('season');
    expect(out.rows[2].rec?.sub).toBe('fav');
    expect(out.rows[2].rec?.sub_kind).toBe('favlist');
  });

  it('caps the total and each list', async () => {
    const fetchImpl: BbFetch = async (raw) => {
      const url = new URL(raw);
      if (url.pathname === '/x/web-interface/nav') {
        return reply({ code: 0, data: { isLogin: true, mid: 1, uname: 'me' } });
      }
      if (url.pathname === '/x/v3/fav/folder/collected/list') {
        return reply({
          code: 0,
          data: {
            list: [
              { id: 20, mid: 2, title: 'fav', media_count: 2, type: 11 },
              { id: 30, mid: 3, title: 'season', media_count: 2, type: 21 },
            ],
            has_more: false,
          },
        });
      }
      if (url.pathname === '/x/v3/fav/resource/list') {
        return reply({ code: 0, data: { medias: [videoItem(1), videoItem(2)], has_more: false } });
      }
      return reply({ code: 0, data: { medias: [videoItem(3), videoItem(4)] } });
    };

    const out = await bbSubs({ limit: 3, perList: 2 }, { fetch: fetchImpl });

    expect(out.rows).toHaveLength(3);
    expect(out.notes).toContain('subs: stopped at 3');
  });

  it('turns a signed-out account into the login step', async () => {
    const fetchImpl: BbFetch = async () => reply({
      code: 0, data: { isLogin: false, mid: 0, uname: '' },
    });

    const out = await bbSubs({}, { fetch: fetchImpl });

    expect(out.needsUser).toContain('https://passport.bilibili.com/login');
  });

  it('reports an account with no subscriptions', async () => {
    const fetchImpl: BbFetch = async (raw) => {
      const url = new URL(raw);
      if (url.pathname === '/x/web-interface/nav') {
        return reply({ code: 0, data: { isLogin: true, mid: 1, uname: 'me' } });
      }
      return reply({ code: 0, data: { list: [], has_more: false } });
    };

    const out = await bbSubs({}, { fetch: fetchImpl });

    expect(out.rows).toEqual([]);
    expect(out.notes).toContain('subs: no subscribed lists');
  });
});

describe('bbFeed', () => {
  /** One video with an explicit id, title and publish stamp. */
  const video = (bvid: string, title: string, pubtime: number) => ({
    id: '99', bvid, title, upper: { name: 'up' }, duration: 65, pubtime, cover: '',
  });

  it('maps every subscribed collection and folder to its first video', async () => {
    const fetchImpl: BbFetch = async (raw) => {
      const url = new URL(raw);
      if (url.pathname === '/x/v3/fav/folder/collected/list') {
        expect(url.searchParams.get('up_mid')).toBe('486979785');
        expect(url.searchParams.get('platform')).toBe('web');
        return reply({
          code: 0,
          data: {
            list: [
              { id: 5292482, mid: 13680050, title: 'AAAAA博物馆攻略', media_count: 2, type: 21, upper: { mid: 13680050, name: '顾爷' } },
              { id: 4704451, mid: 374034429, title: 'NVIDIA显卡合集', media_count: 2, type: 21, upper: { mid: 374034429, name: '万扯淡' } },
              { id: 1026774849, mid: 485334049, title: 'land', media_count: 2, type: 11, upper: { mid: 485334049, name: '塑G' } },
            ],
            has_more: false,
          },
        });
      }
      if (url.pathname === '/x/space/fav/season/list') {
        const season = url.searchParams.get('season_id');
        const first = season === '5292482'
          ? video('BV1bgLEzpE6N', '泰特英国全攻略', 1_745_812_800)
          : video('BV164sGzSEUy', '英伟达GTX295', 1_761_223_769);
        return reply({ code: 0, data: { medias: [first, video('BVignored', 'ignored', 1)] } });
      }
      if (url.pathname === '/x/v3/fav/resource/list') {
        return reply({
          code: 0,
          data: { medias: [video('BV1folder', 'folder video', 1_700_000_000)], has_more: false },
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    };

    const out = await bbFeed({ url: 'https://space.bilibili.com/486979785' }, { fetch: fetchImpl });

    expect(out.rows.map((row) => row.ref)).toEqual([
      'https://www.bilibili.com/video/BV164sGzSEUy',
      'https://www.bilibili.com/video/BV1bgLEzpE6N',
      'https://www.bilibili.com/video/BV1folder',
    ]);
    expect(out.rows[0].txt).toBe('[NVIDIA显卡合集]（2）英伟达GTX295 — up · 1:05');
    expect(out.rows[1].txt).toBe('[AAAAA博物馆攻略]（2）泰特英国全攻略 — up · 1:05');
    expect(out.rows[2].txt).toBe('[land]（2）folder video — up · 1:05');
    expect(out.rows[0].rec?.list_count).toBe(2);
    expect(out.rows[0].rec?.list).toBe(
      'https://space.bilibili.com/486979785/favlist?fid=4704451&ftype=collect&ctype=21',
    );
    expect(out.rows[2].rec?.list).toBe(
      'https://space.bilibili.com/486979785/favlist?fid=1026774849&ftype=collect',
    );
    expect(out.rows[1].rec?.list_title).toBe('AAAAA博物馆攻略');
  });

  it('asks for a space URL when the entry has none', async () => {
    const fetchImpl = vi.fn<BbFetch>();
    const out = await bbFeed({}, { fetch: fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.needsUser).toContain('bb-feed needs a space URL');
  });
});

describe('installBbApiGlobal', () => {
  it('publishes the readers a seeded body calls', () => {
    installBbApiGlobal();
    const api = (globalThis as { bbapi?: Record<string, unknown> }).bbapi;
    expect(Object.keys(api ?? {}).sort()).toEqual(['feed', 'history', 'list', 'lists', 'nav', 'subs']);
    delete (globalThis as { bbapi?: unknown }).bbapi;
  });
});
