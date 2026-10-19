/**
 * webfeed.test.ts — the `webfeed.md` dialect, the strategy walk, the payload
 * readers, and the `webfeed/extract.js` body.
 *
 * The last describe is the live measurement the module exists for: it reads the
 * four seeded sources over the real network and prints which strategy answered
 * for each. `weibo.com` and `zhihu.com` refuse every session-less strategy, so
 * the table, not an assertion, is the finding — a run where no source answers
 * warns and passes, the way the rest of this repository treats an optional
 * channel.
 *
 * It is opt-in because a request to a feed that never answers costs its timeout:
 *
 *   WEBBFEED_E2E=1 npx vitest run test/webfeed.test.ts
 *
 * `WEBBFEED_E2E_STRICT=1` turns "some source answered" into an assertion, and
 * `WEBBFEED_E2E_RETRIES` moves the live run's retry budget.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get_weibo_posts } from '../../src/fc';
import { runBody, type RecrScriptContext } from '../../src/runsrc';
import {
  DEFAULT_FALLBACK, backoffMs, blockedText, commitFeedRows, extractFromDoc, extractSource,
  fetchWithBackoff, htmlPostItems, installWebfeedGlobal, jsonFeedItems, markdownFeedItems,
  mobileUrl, parseFeedPayload, parseWebfeedDoc, planFeedRows, planStrategies, WEBFEED_REF,
  type BackoffConfig, type FeedDa, type FeedItem, type FeedSource, type FeedTable,
} from '../../src/webfeed';
import { WEBFEED_DOC, WEBFEED_EXTRACT_BODY } from '../../src/webfeedRows';

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).webfeed;
});

const source = (over: Partial<FeedSource> = {}): FeedSource => ({
  name: 'demo', url: 'https://demo.test/page', type: 'url', apis: [], session: '',
  mobile: '', proxy: '', proxyHeaders: {}, tags: ['feed'], limit: 0, ...over,
});

/** One stub response per URL substring; every call is recorded, headers included. */
function routeFetch(...routes: [match: string, res: { status?: number; body?: string; throw?: string }][]) {
  const calls: string[] = [];
  const headers: (Record<string, string> | undefined)[] = [];
  const stub = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push(url);
    headers.push(init?.headers);
    const hit = routes.find(([m]) => url.includes(m));
    if (!hit) return { ok: false, status: 404, text: async () => 'no stub' };
    const { status = 200, body = '', throw: boom } = hit[1];
    if (boom) throw new Error(boom);
    return { ok: status < 400, status, text: async () => body };
  });
  vi.stubGlobal('fetch', stub);
  return { calls, headers, stub };
}

/** `ctx.db` reduced to the two queries {@link extractFromDoc} makes. */
function docTable(rows: FeedDa[]): FeedTable {
  const table: FeedTable = {
    where: (key: string) => ({
      equals: (value: unknown) => ({
        toArray: async () => rows.filter((r) => (key === 'type'
          ? r.type === value
          : Array.isArray(value) && r.ref === value[0] && r.type === value[1])),
      }),
    }),
    filter: (pred: (row: FeedDa) => boolean) => ({
      toArray: async () => rows.filter(pred),
    }),
    toArray: async () => rows,
  };
  return table;
}

/** Row shape a seeded document takes: no `tid`, and `rec.feed` naming its block. */
const docRow = (txt: string): FeedDa =>
  ({ txt, ref: WEBFEED_REF, type: 'md', tags: ['webfeed'], rec: {} });

/** One request's retries, as the attempt log reports them. */
const attempt = (url: string, cfg: BackoffConfig) =>
  fetchWithBackoff(url, 'demo', 'direct', cfg);

const WEIBO_JSON = JSON.stringify({
  data: {
    cards: [
      { card_type: 9, mblog: { id: '501', created_at: 'Wed Oct 15 10:00:00 +0800 2026', text: '<a href="#"><b>爱可可</b></a> 今天的论文 &amp; 代码' } },
      { card_type: 9, mblog: { id: '500', text: 'older post' } },
    ],
  },
});

const WALLST_JSON = JSON.stringify({
  code: 20000,
  data: {
    items: [
      { id: 42, display_time: 1770000000, content_text: '快讯：某公司第三季度营收同比增长 56.16% - 华尔街见闻' },
      { id: 41, display_time: 1769999000, content_text: '快讯：另一条' },
    ],
  },
});

const ZHIHU_JSON = JSON.stringify({
  data: [
    { created_time: 1770000000, action_text: '发布了文章', target: { url: 'https://api.zhihu.com/p/123', title: '由浅入深，汇率走势' } },
  ],
});

/**
 * A `sina.cn/media/<id>` page as it is served: the posts, their stamps and the
 * numbers under them are already in the document.
 */
const SINA_PAGE = `<html lang="zh-CN"><head><style>.post-link { display: block; }</style></head>
<body><div class="feed">
  <a class="post-link" href="/news/detail/5354626008222331.html">
    <article class="post">
      <div class="post-head"><div class="meta"><div class="uname">爱可可-爱生活</div><div class="time">2026-10-16 12:43<span class="src">来自 微博网页版</span></div></div></div>
      <div class="post-text">【纯代码跑出的爆款动画】这个开源项目整理了数百条提示词与案例。</div>
      <div class="post-actions">
        <div class="action"><svg></svg><span>2</span></div>
        <div class="action"><svg></svg><span>0</span></div>
        <div class="action"><svg></svg><span>9</span></div>
      </div>
    </article>
  </a>
  <a class="post-link" href="/news/detail/5354624602345242.html">
    <article class="post">
      <div class="post-head"><div class="meta"><div class="time">2026-10-15 08:05</div></div></div>
      <div class="post-repost"><span class="orig-name">某号</span> 被转发的原文</div>
      <div class="post-text">转发时写的评论</div>
      <div class="post-actions">
        <div class="action"><svg></svg><span>1</span></div>
        <div class="action"><svg></svg><span>3</span></div>
        <div class="action"><svg></svg><span>4</span></div>
      </div>
    </article>
  </a>
</div></body></html>`;

describe('parseWebfeedDoc', () => {
  it('reads the seeded document', () => {
    const doc = parseWebfeedDoc(WEBFEED_DOC);

    expect(doc.sources.map((s) => s.name))
      .toEqual(['wallstreetcn', 'zhihu-fly51fly', 'sina-fly51fly', 'weibo-fly51fly']);
    const wall = doc.sources[0];
    expect(wall.url).toBe('https://wallstreetcn.com/live/global');
    expect(wall.apis).toEqual(['https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=30']);
    expect(wall.tags).toEqual(['feed', 'finance', 'cn']);
    expect(doc.sources[3].session).toBe('weibo');
    expect(doc.sources[3].apis[0]).toContain('containerid=2304132337530130');
    expect(doc.fallback.proxy).toBe('https://r.jina.ai/');
    expect(doc.fallback.retries).toBe(2);
    expect(doc.fallback.limit).toBe(30);
  });

  it('keeps the defaults for what the document leaves out', () => {
    const doc = parseWebfeedDoc('## Sources\n\n### a\n* URL: https://a.test/\n');

    expect(doc.fallback).toEqual(DEFAULT_FALLBACK);
    expect(doc.sources).toEqual([source({ name: 'a', url: 'https://a.test/' })]);
  });

  it('ignores a block with no URL rather than throwing', () => {
    const doc = parseWebfeedDoc('## Sources\n\n### empty\n* Type: url\n\n### b\n* URL: https://b.test/\n');

    expect(doc.sources.map((s) => s.name)).toEqual(['b']);
  });
});

describe('backoff', () => {
  it('doubles from the base and stops at the cap', () => {
    const exact = () => 1;

    expect(backoffMs(0, 100, 10000, exact)).toBe(100);
    expect(backoffMs(1, 100, 10000, exact)).toBe(200);
    expect(backoffMs(2, 100, 10000, exact)).toBe(400);
    expect(backoffMs(9, 100, 10000, exact)).toBe(10000);
    expect(backoffMs(0, 100, 10000, () => 0)).toBe(50);
  });

  it('retries a server fault with the exact delay sequence, then gives up', async () => {
    const { calls } = routeFetch(['/page', { status: 503, body: 'busy' }]);
    const waited: number[] = [];

    const out = await attempt('/page', { retries: 2, baseDelayMs: 100, capDelayMs: 10000, random: () => 1, sleep: async (ms) => void waited.push(ms) });

    expect(calls.length).toBe(3);
    expect(waited).toEqual([100, 200]);
    expect(out.ok).toBe(false);
    expect(out.attempts.map((a) => a.delayMs)).toEqual([0, 100, 200]);
    expect(out.error).toBe('HTTP 503');
  });

  it('retries a thrown error', async () => {
    const { calls } = routeFetch(['/page', { throw: 'ECONNRESET' }]);

    const out = await attempt('/page', { retries: 1, baseDelayMs: 1, sleep: async () => { } });

    expect(calls.length).toBe(2);
    expect(out.error).toBe('ECONNRESET');
  });

  it('does not retry a refusal another strategy can answer', async () => {
    const { calls } = routeFetch(['/page', { status: 403, body: '{"error":"Forbidden"}' }]);

    const out = await attempt('/page', { retries: 4, sleep: async () => { } });

    expect(calls.length).toBe(1);
    expect(out.error).toBe('HTTP 403');
  });

  it('reads a 200 login wall as a failure, and an empty body too', async () => {
    routeFetch(['/page', { body: 'Title: Sina Visitor System\n\nMarkdown Content:\n' }]);

    const out = await attempt('/page', { retries: 0 });

    expect(out.ok).toBe(false);
    expect(out.error).toBe('blocked: Sina Visitor System');
    expect(blockedText('short')).toBe('empty body');
    expect(blockedText('x'.repeat(50))).toBe('');
  });
});

describe('payload readers', () => {
  it('reads weibo cards', () => {
    const items = jsonFeedItems(JSON.parse(WEIBO_JSON));

    expect(items.length).toBe(2);
    expect(items[0].ref).toBe('https://m.weibo.cn/detail/501');
    expect(items[0].txt).toBe('爱可可 今天的论文 & 代码');
    expect(items[0].dt?.getFullYear()).toBe(2026);
  });

  it('reads wallstreetcn lives', () => {
    const items = jsonFeedItems(JSON.parse(WALLST_JSON));

    expect(items[0].ref).toBe('https://wallstreetcn.com/livenews/42');
    expect(items[0].txt).toContain('56.16%');
    expect(items[0].dt?.getTime()).toBe(1770000000000);
  });

  it('reads zhihu activities off the api host', () => {
    const items = jsonFeedItems(JSON.parse(ZHIHU_JSON));

    expect(items[0].ref).toBe('https://www.zhihu.com/p/123');
    expect(items[0].txt).toBe('由浅入深，汇率走势');
  });

  it('falls back to any object carrying an id and a text', () => {
    const items = jsonFeedItems({ deep: { list: [{ id: 7, title: 'a plain entry' }] } });

    expect(items).toEqual([{ ref: '#7', txt: 'a plain entry', dt: undefined }]);
  });

  it('reads a Markdown link list when the page has one', () => {
    const md = 'Markdown Content:\n[第一条](#)\n\n[entry one](https://a.test/1)\n[entry two](https://a.test/2)\n[entry three](https://a.test/3)\n';

    const items = markdownFeedItems(md, 'https://a.test/feed');

    expect(items.map((i) => i.ref)).toEqual(['https://a.test/1', 'https://a.test/2', 'https://a.test/3']);
  });

  it('keeps a prose block under the same ref when it is read twice', () => {
    const md = 'Markdown Content:\n\n快讯：一条足够长的正文，用来看内容哈希是否稳定。\n\n第二条正文也足够长一些，用于第二个块。\n';
    const first = markdownFeedItems(md, 'https://a.test/live');
    const second = markdownFeedItems(md, 'https://a.test/live');

    expect(first.length).toBe(2);
    expect(first.map((i) => i.ref)).toEqual(second.map((i) => i.ref));
    expect(first[0].ref.startsWith('https://a.test/live#')).toBe(true);
  });

  it('reads a JSON body as JSON and anything else as Markdown', () => {
    expect(parseFeedPayload(WEIBO_JSON, 'https://api.test/')[0].ref).toContain('/detail/501');
    expect(parseFeedPayload('Markdown Content:\n\n一条足够长的正文内容，用于解析测试这个块。\n', 'https://a.test/p').length).toBe(1);
  });

  it('reads a post the proxy wrapped around its picture as the post', () => {
    const md = 'Markdown Content:\n[![Image 1](https://a.test/ava.png) 第一条标题](https://a.test/1)\n[第二条标题](https://a.test/2)\n[第三条标题](https://a.test/3)\n';

    const items = markdownFeedItems(md, 'https://a.test/feed');

    expect(items.map((i) => i.ref)).toEqual(['https://a.test/1', 'https://a.test/2', 'https://a.test/3']);
    expect(items[0].txt).toBe('第一条标题');
  });

  it('reads the posts a sina.cn media document carries, whatever media id it is', () => {
    const items = htmlPostItems(SINA_PAGE, 'https://www.sina.cn/media/1234567890');

    expect(items.map((i) => i.ref)).toEqual([
      'https://www.sina.cn/news/detail/5354626008222331.html',
      'https://www.sina.cn/news/detail/5354624602345242.html',
    ]);
    expect(items[0].txt).toBe('[转发 2 · 评论 0 · 赞 9] 【纯代码跑出的爆款动画】这个开源项目整理了数百条提示词与案例。');
    expect(items[0].dt?.toISOString()).toBe('2026-10-16T04:43:00.000Z');
    expect(items[1].txt).toBe('[转发 1 · 评论 3 · 赞 4] 转发时写的评论 转发自 某号 被转发的原文');
  });

  it('reads an HTML body for its posts rather than for its stylesheet', () => {
    expect(parseFeedPayload(SINA_PAGE, 'https://www.sina.cn/media/1234567890')).toHaveLength(2);
    expect(parseFeedPayload('<html><body><style>p { color: red; }</style><p>一段足够长的正文，但页面没有帖子。</p></body></html>', 'https://a.test/p'))
      .toEqual([]);
  });
});

describe('planFeedRows', () => {
  const items: FeedItem[] = [
    { ref: 'https://a.test/3', txt: 'newest' },
    { ref: 'https://a.test/2', txt: 'older' },
    { ref: 'https://a.test/1', txt: 'oldest' },
  ];

  it('leaves tid unset and names the source and the strategy', () => {
    const plan = planFeedRows(items, source({ tags: ['feed', 'cn'] }), 'api');

    expect(plan.das.length).toBe(3);
    expect(plan.das[0].tid).toBeUndefined();
    expect(plan.das[0].tags).toEqual(['feed', 'cn']);
    expect(plan.das[0].type).toBe('url');
    expect(plan.das[0].rec).toMatchObject({ feed: 'demo', strategy: 'api', src: 'https://demo.test/page' });
  });

  it('stops at the row the store already holds', () => {
    const old = docRow('x');
    const known: FeedDa = { ...old, ref: 'https://a.test/2', type: 'url' };

    const plan = planFeedRows(items, source(), 'direct', { existing: [known] });

    expect(plan.das.map((d) => d.ref)).toEqual(['https://a.test/3']);
    expect(plan.stoppedAt).toBe('https://a.test/2');
  });

  it('walks past a known row when the caller wants the whole list', () => {
    const known: FeedDa = { ref: 'https://a.test/2', txt: 'older', type: 'url', rec: {} };

    const plan = planFeedRows(items, source(), 'direct', { existing: [known], stopAtKnown: false });

    expect(plan.das.map((d) => d.ref)).toEqual(['https://a.test/3', 'https://a.test/1']);
    expect(plan.dropped).toBe(1);
    expect(plan.stoppedAt).toBeUndefined();
  });

  it('keeps one row per ref and honours the cap', () => {
    const dup: FeedItem[] = [...items, items[0]];

    const plan = planFeedRows(dup, source({ limit: 2 }), 'direct');

    expect(plan.das.map((d) => d.ref)).toEqual(['https://a.test/3', 'https://a.test/2']);
    expect(plan.dropped).toBe(0);
  });
});

describe('planStrategies and extractSource', () => {
  it('orders api, session, direct, mobile, then proxy', () => {
    const src = source({ apis: ['https://api.test/1', 'https://api.test/2'], session: 'weibo' });

    expect(planStrategies(src, DEFAULT_FALLBACK, false).map((s) => s.strategy))
      .toEqual(['api', 'api', 'direct', 'proxy']);
    expect(planStrategies(src, DEFAULT_FALLBACK, true).map((s) => s.strategy))
      .toEqual(['api', 'api', 'cookied', 'direct', 'proxy']);
    expect(planStrategies(src, DEFAULT_FALLBACK, false)[3].url)
      .toBe('https://r.jina.ai/https://demo.test/page');
  });

  it("carries the seeded sina block's proxy headers into its proxy step", () => {
    const doc = parseWebfeedDoc(WEBFEED_DOC);
    const sina = doc.sources.filter((s) => s.name === 'sina-fly51fly')[0];

    expect(sina.proxyHeaders).toEqual({ 'X-Return-Format': 'html' });
    expect(planStrategies(sina, doc.fallback).filter((s) => s.strategy === 'proxy')[0].headers)
      .toEqual({ 'X-Return-Format': 'html' });
  });

  it("sends a block's proxy headers with its proxy request only", async () => {
    const { calls, headers } = routeFetch(['r.jina.ai', { body: SINA_PAGE }]);
    const src = source({
      name: 'sina', url: 'https://www.sina.cn/media/1234567890',
      proxyHeaders: { 'X-Return-Format': 'html' },
    });

    const res = await extractSource(src, DEFAULT_FALLBACK, { retries: 0 });

    expect(res.strategy).toBe('proxy');
    expect(res.das[0].txt).toContain('赞 9');
    expect(calls).toEqual([
      'https://www.sina.cn/media/1234567890',
      'https://m.weibo.cn/u/1234567890',
      'https://r.jina.ai/https://www.sina.cn/media/1234567890',
    ]);
    expect(headers).toEqual([undefined, undefined, { 'X-Return-Format': 'html' }]);
  });

  it('carries the mobile mirror over from the id a URL already names', () => {
    expect(mobileUrl('https://weibo.com/u/2337530130')).toBe('https://m.weibo.cn/u/2337530130');
    expect(mobileUrl('https://www.sina.cn/media/1402400261')).toBe('https://m.weibo.cn/u/1402400261');
    expect(mobileUrl('https://www.zhihu.com/people/fly51fly')).toBe('');
    expect(mobileUrl('https://demo.test/page')).toBe('');

    const weibo = source({ name: 'weibo', url: 'https://weibo.com/u/2337530130' });
    expect(planStrategies(weibo, DEFAULT_FALLBACK).map((s) => `${s.strategy} ${s.url}`))
      .toEqual([
        'direct https://weibo.com/u/2337530130',
        'mobile https://m.weibo.cn/u/2337530130',
        'proxy https://r.jina.ai/https://weibo.com/u/2337530130',
      ]);
  });

  it('reads the mobile mirror when the desktop page is a wall', async () => {
    const { calls } = routeFetch(
      ['m.weibo.cn', { body: WEIBO_JSON }],
      ['/u/2337530130', { body: 'Title: Sina Visitor System\n\nMarkdown Content:\n' }],
    );

    const res = await extractSource(source({ url: 'https://weibo.com/u/2337530130' }), DEFAULT_FALLBACK, { retries: 0 });

    expect(res.strategy).toBe('mobile');
    expect(res.das.length).toBe(2);
    expect(calls).toEqual(['https://weibo.com/u/2337530130', 'https://m.weibo.cn/u/2337530130']);
    expect(res.notes).toEqual(['direct: blocked: Sina Visitor System']);
  });

  it('stops at the first strategy that answers with items', async () => {
    const { calls } = routeFetch(['api.test', { body: WALLST_JSON }], ['/page', { body: 'unused' }]);

    const res = await extractSource(source({ apis: ['https://api.test/1'] }), DEFAULT_FALLBACK, { retries: 0 });

    expect(res.strategy).toBe('api');
    expect(res.das.length).toBe(2);
    expect(calls).toEqual(['https://api.test/1']);
  });

  it('moves to the proxy when the API refuses and the page is a wall', async () => {
    // The proxy's URL contains the page's, so the proxy's route is listed first.
    const { calls } = routeFetch(
      ['api.test', { status: 403, body: '{"error":"Forbidden"}' }],
      ['r.jina.ai', { body: 'Markdown Content:\n\n一条足够长的快讯正文内容，用于这条用例，长度要越过空响应的下限。\n' }],
      ['/page', { body: '安全验证' }],
    );

    const res = await extractSource(source({ apis: ['https://api.test/1'] }), DEFAULT_FALLBACK, { retries: 0 });

    expect(res.strategy).toBe('proxy');
    expect(res.das.length).toBe(1);
    expect(calls).toEqual(['https://api.test/1', 'https://demo.test/page', 'https://r.jina.ai/https://demo.test/page']);
    expect(res.notes).toEqual(['api: HTTP 403', 'direct: blocked: 安全验证']);
  });

  it('reports every attempt when nothing answers', async () => {
    routeFetch([]);

    const res = await extractSource(source({ apis: ['https://api.test/1'] }), DEFAULT_FALLBACK, { retries: 0 });

    expect(res.strategy).toBeNull();
    expect(res.das).toEqual([]);
    expect(res.attempts.length).toBe(3);
    expect(res.notes.length).toBe(3);
  });

  it('takes items straight from a session-aware reader', async () => {
    const res = await extractSource(source({ session: 'weibo' }), DEFAULT_FALLBACK, {
      retries: 0,
      cookied: async () => ['2337530130: 一条帖子'],
    });

    expect(res.strategy).toBe('cookied');
    expect(res.das.length).toBe(1);
    expect(res.das[0].ref.startsWith('https://demo.test/page#')).toBe(true);
  });
});

describe('extractFromDoc', () => {
  const db = (rows: FeedDa[]) => ({ das: docTable(rows) });

  it('reads the document row and every source it declares', async () => {
    routeFetch(['api.test', { body: WALLST_JSON }]);
    const doc = '## Sources\n\n### a\n* URL: https://demo.test/page\n* API:\n  - x: https://api.test/1\n';

    const out = await extractFromDoc({ db: db([docRow(doc)]), args: { retries: 0 } });

    expect(out.ref).toBe(WEBFEED_REF);
    expect(out.sources.map((s) => s.source)).toEqual(['a']);
    expect(out.das.length).toBe(2);
    expect(out.das.every((d) => d.tid === undefined)).toBe(true);
  });

  it('narrows to the named sources and stops at a row the store holds', async () => {
    routeFetch(['api.test', { body: WALLST_JSON }]);
    const doc = '## Sources\n\n### a\n* URL: https://demo.test/page\n* API:\n  - x: https://api.test/1\n'
      + '\n### b\n* URL: https://b.test/\n';
    const known: FeedDa = { ref: 'https://wallstreetcn.com/livenews/41', txt: '快讯：另一条', type: 'url', rec: { feed: 'a' } };

    const out = await extractFromDoc({ db: db([docRow(doc), known]), args: { sources: ['a'], retries: 0 } });

    expect(out.sources.length).toBe(1);
    expect(out.das.map((d) => d.ref)).toEqual(['https://wallstreetcn.com/livenews/42']);
    expect(out.sources[0].stoppedAt).toBe('https://wallstreetcn.com/livenews/41');
  });

  it('reads an ad-hoc URL the document does not hold', async () => {
    routeFetch(['api.test', { body: ZHIHU_JSON }]);
    const doc = '## Sources\n\n### a\n* URL: https://demo.test/page\n* API:\n  - x: https://api.test/1\n';

    const out = await extractFromDoc({ db: db([docRow(doc)]), args: { url: 'https://adhoc.test/x', name: 'adhoc', retries: 0 } });

    expect(out.sources.map((s) => s.source)).toEqual(['a', 'adhoc']);
  });

  it('names the missing document instead of returning nothing', async () => {
    await expect(extractFromDoc({ db: db([]) })).rejects.toThrow(/no webfeed\.md row/);
  });
});

describe('webfeed/extract.js', () => {
  const body = WEBFEED_EXTRACT_BODY;

  const ctx = (rows: FeedDa[], args: Record<string, unknown> = {}): RecrScriptContext =>
    ({ db: { das: docTable(rows) }, ref: 'webfeed/extract.js', args, console });

  it('returns the report and the tid-less rows', async () => {
    routeFetch(['api.test', { body: WALLST_JSON }]);
    installWebfeedGlobal();
    const doc = '## Sources\n\n### a\n* URL: https://demo.test/page\n* API:\n  - x: https://api.test/1\n';

    const out = await runBody(body, ctx([docRow(doc)], { retries: 0 })) as {
      ref: string; total: number; sources: string[]; das: FeedDa[];
    };

    expect(out.ref).toBe(WEBFEED_REF);
    expect(out.total).toBe(2);
    expect(out.sources[0]).toContain('a -> api, 2 row(s)');
    expect(out.das[0].tid).toBeUndefined();
  });

  it('fails loud when the global is missing', async () => {
    await expect(runBody(body, ctx([docRow(WEBFEED_DOC)]))).rejects.toThrow(/global API missing/);
  });
});

describe('commitFeedRows', () => {
  it('writes each row without a tid', async () => {
    const seen: FeedDa[] = [];
    const n = await commitFeedRows({ write: async (r) => void seen.push(r) }, [
      { tid: undefined, txt: 'a', ref: 'https://a.test/1', type: 'url', rec: {} },
    ]);

    expect(n).toBe(1);
    expect('tid' in seen[0]).toBe(false);
  });
});

// ─── Findings, over the live network ───────────────────────────────────────

const LIVE = process.env.WEBBFEED_E2E === '1';
const STRICT = process.env.WEBBFEED_E2E_STRICT === '1';

/**
 * The session-aware reader the seeded document's `* Session: weibo` names.
 *
 * `fc.get_weibo_posts` carries a cookie copied out of a browser, so whether it
 * still answers is a measurement rather than a given: a live run records its
 * throw or its wall in the attempt log like any other strategy.
 */
const cookiedReader = async (src: FeedSource): Promise<string[]> => {
  const uid = src.url.match(/\/u\/(\d+)/)?.[1];
  if (src.session !== 'weibo' || !uid) throw new Error(`no session reader for ${src.session || src.name}`);
  return await get_weibo_posts([uid], 5);
};

describe.skipIf(!LIVE)('live findings', () => {
  it('reports which strategy answers for each seeded source', async () => {
    const doc = parseWebfeedDoc(WEBFEED_DOC);
    const fallback = { ...DEFAULT_FALLBACK, retries: Number(process.env.WEBBFEED_E2E_RETRIES ?? 0), timeoutMs: 20000 };
    const lines: string[] = ['source           strategy  rows  detail'];
    const findings: Record<string, unknown>[] = [];

    for (const src of doc.sources) {
      const res = await extractSource(src, fallback, {
        retries: fallback.retries, timeoutMs: fallback.timeoutMs, limit: 3, cookied: cookiedReader,
      });
      for (const a of res.attempts) {
        lines.push(`${src.name.padEnd(16)} ${a.strategy.padEnd(9)} ${a.ok ? String(a.bytes).padStart(4) : '   -'}  ${a.status} ${a.error || 'ok'} ${a.ms}ms`);
      }
      if (res.strategy) {
        lines.push(`${src.name.padEnd(16)} ${res.strategy.padEnd(9)} ${String(res.das.length).padStart(4)}  <- answers`);
      } else {
        lines.push(`${src.name.padEnd(16)} ${'none'.padEnd(9)}    0  <- every strategy refused`);
      }
      findings.push({
        source: src.name, url: src.url, strategy: res.strategy, rows: res.das.length,
        stoppedAt: res.stoppedAt ?? null, notes: res.notes,
        attempts: res.attempts,
      });

      // Shape holds whatever the network answered: a row is unpersisted by definition.
      expect(res.das.every((d) => d.tid === undefined && d.txt.length > 0 && d.rec.feed === src.name)).toBe(true);
      expect(res.strategy === null || res.attempts.some((a) => a.ok)).toBe(true);
    }

    const answered = findings.filter((f) => f.strategy !== null);
    const summary = `${answered.length}/${findings.length} source(s) answered`;
    console.info(`\n[webfeed] ${summary}\n${lines.join('\n')}\n`);
    await mkdir(resolve(__dirname, '../../test-artifacts'), { recursive: true });
    await writeFile(
      resolve(__dirname, '../../test-artifacts/webfeed-findings.json'),
      JSON.stringify({ summary, findings }, null, 2),
    );

    expect(findings.length).toBe(doc.sources.length);
    if (STRICT) expect(answered.length).toBeGreaterThan(0);
    else if (answered.length === 0) console.warn(`[webfeed] no source answered — network blocked? ${summary}`);
  }, 600_000);
});
