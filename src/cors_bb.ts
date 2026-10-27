// @ts-nocheck
/**
 * cors_bb.ts — Supabase Edge Function proxy for Bilibili web reads.
 *
 * The webapp client is `src/bbProxy.ts`; it calls the routes below.
 *
 * Paste this file as the function's `index.ts`. The router accepts a function
 * named `cors_bb`, `cors-bb`, or `bb`; change `FUNCTION_NAMES` if you deploy it
 * under another slug. `ALLOWED_ORIGIN` works like the existing `v1a` function.
 *
 * Routes (all POST, JSON body):
 *
 *   /qr       -> { code, message, data: { url, qrcode_key } }
 *   /poll     { qrcode_key } -> upstream JSON + { stored, cookie, cookies }
 *   /api      { path, params, cookie? } -> upstream JSON
 *   /logout   -> { ok: true }
 *
 * Every request needs `Authorization: Bearer <Supabase session>`,
 * `apikey: <anon key>`, and `Content-Type: application/json`; the page Origin
 * must match `ALLOWED_ORIGIN` (same defaults as `v1a`).
 *
 * `/api` accepts only the paths below. `/poll` returns Bilibili's `Set-Cookie`
 * pairs as `cookie`/`cookies`, so the webapp can store them in sessionStorage
 * and send them back in `/api`. When server-side sessions are enabled, a
 * successful poll returns `stored: true` and leaves the cookie on the server
 * instead of sending it to the page. A successful poll has `data.code === 0`
 * and either `stored: true` or a non-empty `cookie`; a success response
 * without `SESSDATA` is rejected with 502 and `stored: false`.
 *
 * Server-side session (optional, smallest webapp code): set
 * `BB_SESSION_TABLE=bb_session` in the function and create
 *
 *   create table if not exists public.bb_session (
 *     user_id uuid primary key,
 *     cookie text not null,
 *     updated_at timestamptz not null default now(),
 *     expires_at timestamptz not null
 *   );
 *   alter table public.bb_session enable row level security;
 *
 * The function uses the service role key, so no RLS policy is needed. With the
 * table present and `BB_SESSION_TABLE` set, `/poll` stores the cookie for the
 * verified Supabase user and `/api` can omit `cookie`. Without both, client-cookie
 * mode still works: `/poll` returns the cookie and `/api` requires it.
 *
 * The proxy pins `api.bilibili.com` and `passport.bilibili.com`, forwards a
 * desktop User-Agent/Referer, and adds a device id from `x/frontend/finger/spi`
 * when the cookie has no `buvid3`. If Bilibili answers -352/-412 from the
 * Supabase IP, add WBI signing (`w_rid`/`wts`) before relying on every endpoint.
 *
 * Guards: JSON bodies up to 64k characters, a 15-second upstream timeout, and a
 * per-user token bucket of 300 requests refilled at 3 per second.
 *
 * Keep Supabase's JWT verification on: `getVerifiedUserId` only decodes the
 * payload the gateway already verified.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN')

if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required')

const BASE_URL = SUPABASE_URL.replace(/\/+$/, '')
const FUNCTION_NAMES = ['cors_bb', 'cors-bb', 'bb']
const SESSION_TABLE = Deno.env.get('BB_SESSION_TABLE')?.trim() || ''
const SESSION_ENABLED = Boolean(SERVICE_KEY && SESSION_TABLE)
const SESSION_DAYS = 30

const BILI_API = 'https://api.bilibili.com'
const BILI_PASSPORT = 'https://passport.bilibili.com'
const BILI_REFERER = 'https://www.bilibili.com/'
const BILI_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const TIMEOUT_MS = 15_000

/** Paths the webapp's bb-* readers call, and nothing else. */
const API_PATHS = new Set([
  '/x/web-interface/nav',
  '/x/web-interface/history/cursor',
  '/x/v3/fav/folder/created/list-all',
  '/x/v3/fav/folder/collected/list',
  '/x/v3/fav/resource/list',
  '/x/space/fav/season/list',
])

const ORIGINS = (ALLOWED_ORIGIN?.trim()
  || 'localhost,127.0.0.1,10.1.1.*,https://wasoko.github.io')
  .split(',')
  .map(entry => entry.trim().toLowerCase())
  .filter(Boolean)

const MAX_TOKENS = 300
const REFILL_INTERVAL_MS = 1_000
const BUCKET_TTL_MS = 15 * 60_000
const MAX_BUCKETS = 10_000

const buckets = new Map()

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function asString(value) {
  return typeof value === 'string' ? value : ''
}

/** Whether a request `Origin` matches one `ORIGINS` entry. */
function originAllowed(origin) {
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }

  const labels = url.hostname.toLowerCase().split('.')
  return ORIGINS.some(entry => {
    const sep = entry.indexOf('://')
    const scheme = sep === -1 ? '' : entry.slice(0, sep)
    const host = sep === -1 ? entry : entry.slice(sep + 3)
    if (scheme && scheme !== url.protocol.slice(0, -1)) return false

    const want = host.split('.')
    return want.length === labels.length
      && want.every((label, i) => label === '*' || label === labels[i])
  })
}

function corsHeaders(origin) {
  return {
    ...(origin && originAllowed(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  }
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

// The gateway must verify the JWT before this handler runs.
function getVerifiedUserId(authorization) {
  if (!authorization?.startsWith('Bearer ')) return null

  const token = authorization.slice('Bearer '.length).trim()
  const payloadPart = token.split('.')[1]
  if (!payloadPart) return null

  try {
    const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    const payload = JSON.parse(new TextDecoder().decode(bytes))

    return payload.role === 'authenticated' && typeof payload.sub === 'string'
      ? payload.sub
      : null
  } catch {
    return null
  }
}

function takeRateLimitToken(userId) {
  const now = Date.now()
  const bucket = buckets.get(userId) ?? { tokens: MAX_TOKENS, lastRefill: now, lastSeen: now }
  const elapsed = Math.max(0, now - bucket.lastRefill)
  const earned = Math.floor(elapsed / REFILL_INTERVAL_MS)

  bucket.tokens = Math.min(MAX_TOKENS, bucket.tokens + earned)
  if (earned > 0) bucket.lastRefill += earned * REFILL_INTERVAL_MS
  bucket.lastSeen = now

  if (bucket.tokens < 1) {
    buckets.set(userId, bucket)
    return false
  }

  bucket.tokens -= 1
  buckets.set(userId, bucket)

  if (buckets.size > MAX_BUCKETS) {
    for (const [id, entry] of buckets) {
      if (now - entry.lastSeen > BUCKET_TTL_MS) buckets.delete(id)
      if (buckets.size <= MAX_BUCKETS) break
    }
    if (buckets.size > MAX_BUCKETS) {
      const oldestId = buckets.keys().next().value
      if (oldestId) buckets.delete(oldestId)
    }
  }

  return true
}

function mergeCookie(cookie, extra) {
  const base = cookie.trim().replace(/;+$/, '')
  return base ? `${base}; ${extra}` : extra
}

/** One request to Bilibili with the headers a browser page would send. */
async function biliFetch(url, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...init,
      headers: {
        'User-Agent': BILI_USER_AGENT,
        'Referer': BILI_REFERER,
        'Accept': 'application/json, text/plain, */*',
        ...(init.headers || {}),
      },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function readJson(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { code: -1, message: `Upstream returned ${response.status}` }
  }
}

/** `Set-Cookie` values, from Deno's getSetCookie or a conservative fallback. */
function setCookieList(headers) {
  if (typeof headers.getSetCookie === 'function') {
    const all = headers.getSetCookie()
    if (Array.isArray(all) && all.length > 0) return all
  }
  const raw = headers.get('set-cookie') || ''
  return raw ? splitSetCookies(raw) : []
}

/** Split a combined `set-cookie` header without breaking `Expires=Wed, 21 …`. */
function splitSetCookies(raw) {
  const out = []
  let start = 0
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== ',') continue
    const rest = raw.slice(i + 1).trimStart()
    if (!/^[^=;,\s]+\s*=/.test(rest)) continue
    out.push(raw.slice(start, i).trim())
    start = i + 1
  }
  out.push(raw.slice(start).trim())
  return out.filter(Boolean)
}

/** The `name=value` pairs of `set-cookie` values, last value of a name wins. */
function cookiePairs(setCookies) {
  const byName = new Map()
  for (const item of setCookies) {
    const first = item.split(';')[0].trim()
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const name = first.slice(0, eq)
    const value = first.slice(eq + 1)
    if (value.toLowerCase() === 'deleted') continue
    byName.set(name, first)
  }
  return [...byName.values()]
}

const buvidCache = new Map()

/** Add `buvid3`/`buvid4` when the login cookie has no device id yet. */
async function ensureBuvid(cookie, userId) {
  if (/(?:^|;\s*)buvid3=/.test(cookie)) return cookie
  const cached = buvidCache.get(userId)
  if (cached && Date.now() - cached.at < 3_600_000 && cached.value !== '') {
    return mergeCookie(cookie, cached.value)
  }
  try {
    const response = await biliFetch(`${BILI_API}/x/frontend/finger/spi`)
    const body = await readJson(response)
    const data = asObject(body.data)
    const b3 = asString(data?.b_3)
    const b4 = asString(data?.b_4)
    if (b3 !== '') {
      const value = `buvid3=${b3}${b4 === '' ? '' : `; buvid4=${b4}`}`
      buvidCache.set(userId, { at: Date.now(), value })
      if (buvidCache.size > 1_000) buvidCache.clear()
      return mergeCookie(cookie, value)
    }
  } catch {
    // Best effort; the API may still answer without a fresh device id.
  }
  return cookie
}

async function biliApi(path, params, cookie) {
  const url = new URL(`${BILI_API}${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  const response = await biliFetch(url.toString(), {
    headers: cookie === '' ? {} : { Cookie: cookie },
  })
  return { response, body: await readJson(response) }
}

function sessionHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  }
}

async function saveSession(userId, cookie) {
  if (!SESSION_ENABLED) return false
  const now = new Date()
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000)
  try {
    const response = await fetch(`${BASE_URL}/rest/v1/${SESSION_TABLE}?on_conflict=user_id`, {
      method: 'POST',
      headers: { ...sessionHeaders(), Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        user_id: userId,
        cookie,
        updated_at: now.toISOString(),
        expires_at: expires.toISOString(),
      }),
    })
    if (!response.ok) {
      console.error(`bb session save failed: HTTP ${response.status}`)
      return false
    }
    return true
  } catch (error) {
    console.error('bb session save failed', error instanceof Error ? error.message : String(error))
    return false
  }
}

async function loadSession(userId) {
  if (!SESSION_ENABLED) return ''
  try {
    const response = await fetch(
      `${BASE_URL}/rest/v1/${SESSION_TABLE}?user_id=eq.${encodeURIComponent(userId)}`
      + '&select=cookie,expires_at&limit=1',
      { headers: sessionHeaders() },
    )
    if (!response.ok) return ''
    const rows = await response.json()
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row || typeof row.cookie !== 'string') return ''
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return ''
    return row.cookie
  } catch {
    return ''
  }
}

async function deleteSession(userId) {
  if (!SESSION_ENABLED) return
  try {
    await fetch(
      `${BASE_URL}/rest/v1/${SESSION_TABLE}?user_id=eq.${encodeURIComponent(userId)}`,
      { method: 'DELETE', headers: sessionHeaders() },
    )
  } catch {
    // Best effort; an expired session is ignored on read.
  }
}

async function readJsonBody(request) {
  const text = await request.text()
  if (text.trim() === '') return { ok: true, body: {} }
  if (text.length > 64_000) return { ok: false, status: 413, error: 'Request body too large' }
  try {
    const body = asObject(JSON.parse(text))
    return body ? { ok: true, body } : { ok: false, status: 400, error: 'Expected a JSON object' }
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON' }
  }
}

Deno.serve(async (request) => {
  const origin = request.headers.get('Origin')
  const callerAllowed = origin === null || originAllowed(origin)

  if (request.method === 'OPTIONS') {
    return new Response(callerAllowed ? 'ok' : 'origin not allowed', {
      status: callerAllowed ? 200 : 403,
      headers: corsHeaders(origin),
    })
  }

  try {
    if (!callerAllowed) return jsonResponse({ error: 'Origin not allowed' }, 403, origin)
    if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, origin)

    const userId = getVerifiedUserId(request.headers.get('Authorization'))
    if (!userId) return jsonResponse({ error: 'Unauthorized' }, 401, origin)
    if (!takeRateLimitToken(userId)) return jsonResponse({ error: 'Too many requests' }, 429, origin)

    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      return jsonResponse({ error: 'Expected application/json' }, 415, origin)
    }

    const pathname = new URL(request.url).pathname
    const route = pathname.match(
      new RegExp(`^(?:/functions/v1)?/(?:${FUNCTION_NAMES.join('|')})(/.*)?$`),
    )
    if (!route) return jsonResponse({ error: 'Not found' }, 404, origin)

    const routePath = (route[1] || '/').replace(/\/+$/, '') || '/'
    const parsed = await readJsonBody(request)
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, origin)
    const body = parsed.body

    if (routePath === '/qr') {
      const response = await biliFetch(
        `${BILI_PASSPORT}/x/passport-login/web/qrcode/generate?source=main-fe-header`,
      )
      const upstream = await readJson(response)
      return jsonResponse(upstream, response.ok ? 200 : 502, origin)
    }

    if (routePath === '/poll') {
      const qrcodeKey = asString(body.qrcode_key).trim()
      if (qrcodeKey === '') return jsonResponse({ error: 'qrcode_key is required' }, 400, origin)

      const response = await biliFetch(
        `${BILI_PASSPORT}/x/passport-login/web/qrcode/poll`
        + `?qrcode_key=${encodeURIComponent(qrcodeKey)}&source=main-fe-header`,
      )
      const upstream = await readJson(response)
      const loginOk = asObject(upstream.data)?.code === 0
      const pairs = loginOk ? cookiePairs(setCookieList(response.headers)) : []
      const hasSessdata = pairs.some(
        pair => pair.split('=')[0]?.trim().toLowerCase() === 'sessdata',
      )
      if (loginOk && !hasSessdata) {
        return jsonResponse({ ...upstream, stored: false, cookie: '', cookies: [] }, 502, origin)
      }
      const cookie = pairs.join('; ')
      const stored = pairs.length > 0 && SESSION_ENABLED ? await saveSession(userId, cookie) : false
      return jsonResponse({
        ...upstream,
        stored,
        cookie: stored ? '' : cookie,
        cookies: stored ? [] : pairs,
      }, response.ok ? 200 : 502, origin)
    }

    if (routePath === '/api') {
      const path = asString(body.path).trim()
      if (!API_PATHS.has(path)) {
        return jsonResponse({ code: -1, message: 'Path not allowed', data: null }, 400, origin)
      }

      let cookie = asString(body.cookie).trim().slice(0, 8_192)
      if (/[\r\n]/.test(cookie)) return jsonResponse({ error: 'Invalid cookie' }, 400, origin)
      const usedClientCookie = cookie !== ''
      if (cookie === '' && SESSION_ENABLED) cookie = await loadSession(userId)
      if (cookie === '') {
        return jsonResponse({ code: -101, message: 'not logged in', data: null }, 200, origin)
      }

      const params = asObject(body.params) || {}
      for (const [key, value] of Object.entries(params)) {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          return jsonResponse({ error: `Invalid parameter: ${key}` }, 400, origin)
        }
      }

      cookie = await ensureBuvid(cookie, userId)
      const { response, body: upstream } = await biliApi(path, params, cookie)
      if (upstream?.code === -101 && SESSION_ENABLED && !usedClientCookie) {
        await deleteSession(userId)
      }
      return jsonResponse(upstream, response.ok ? 200 : 502, origin)
    }

    if (routePath === '/logout') {
      if (SESSION_ENABLED) await deleteSession(userId)
      return jsonResponse({ ok: true }, 200, origin)
    }

    return jsonResponse({ error: 'Not found' }, 404, origin)
  } catch (error) {
    console.error('cors_bb failed', error instanceof Error ? error.message : String(error))
    return jsonResponse({ error: 'Upstream request failed' }, 502, origin)
  }
})
