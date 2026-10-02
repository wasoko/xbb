const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN')

if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required')

/**
 * Origins that may call this function: comma-separated `ALLOWED_ORIGIN`, or the
 * defaults below when it is unset.
 *
 * An entry is `scheme://host` or a bare `host`, and `*` matches one host label.
 * Ports are not compared, so every dev port works. A page `Origin` never carries
 * a path, so the entry is `https://wasoko.github.io`, not `.../xbb`.
 */
const ORIGINS = (ALLOWED_ORIGIN?.trim()
  || 'localhost,127.0.0.1,10.1.1.*,https://wasoko.github.io')
  .split(',')
  .map(entry => entry.trim().toLowerCase())
  .filter(Boolean)

const FUNCTION_NAME = 'v1a'
const MAX_TOKENS = 15
const REFILL_INTERVAL_MS = 1_000
const BUCKET_TTL_MS = 15 * 60_000
const MAX_BUCKETS = 10_000

type Bucket = {
  tokens: number
  lastRefill: number
  lastSeen: number
}

const buckets = new Map<string, Bucket>()

/** Whether a request `Origin` matches one `ORIGINS` entry. */
function originAllowed(origin: string): boolean {
  let url: URL
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

/** CORS headers for `origin`; the allow-origin header appears only when it is allowed. */
function corsHeaders(origin: string | null) {
  return {
    ...(origin && originAllowed(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-ollama-auth',
    'Vary': 'Origin',
  }
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  })
}

// The gateway must verify the JWT before this handler runs.
function getVerifiedUserId(authorization: string | null): string | null {
  if (!authorization?.startsWith('Bearer ')) return null

  const token = authorization.slice('Bearer '.length).trim()
  const payloadPart = token.split('.')[1]
  if (!payloadPart) return null

  try {
    const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const payload = JSON.parse(new TextDecoder().decode(bytes))

    return payload.role === 'authenticated' && typeof payload.sub === 'string'
      ? payload.sub
      : null
  } catch {
    return null
  }
}

function takeRateLimitToken(userId: string): boolean {
  const now = Date.now()
  const bucket = buckets.get(userId) ?? {
    tokens: MAX_TOKENS,
    lastRefill: now,
    lastSeen: now,
  }

  const elapsed = Math.max(0, now - bucket.lastRefill)
  const earned = Math.floor(elapsed / REFILL_INTERVAL_MS)

  bucket.tokens = Math.min(MAX_TOKENS, bucket.tokens + earned)

  // Retain unused fractional refill time instead of resetting the clock per request.
  if (earned > 0) {
    bucket.lastRefill += earned * REFILL_INTERVAL_MS
  }

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

    // Bound memory even if no entries have expired yet.
    if (buckets.size > MAX_BUCKETS) {
      const oldestId = buckets.keys().next().value
      if (oldestId) buckets.delete(oldestId)
    }
  }

  return true
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin')
  // A browser always sends Origin; a request without one is not a page.
  const callerAllowed = origin === null || originAllowed(origin)

  if (req.method === 'OPTIONS') {
    // Answer the preflight only for an allowed origin, so a rejected page reads a
    // status rather than a vanished header.
    return new Response(callerAllowed ? 'ok' : 'origin not allowed', {
      status: callerAllowed ? 200 : 403,
      headers: corsHeaders(origin),
    })
  }

  try {
    if (!callerAllowed) {
      return jsonResponse({ error: 'Origin not allowed' }, 403, origin)
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, origin)
    }

    const userId = getVerifiedUserId(req.headers.get('Authorization'))
    if (!userId) {
      return jsonResponse({ error: 'Unauthorized' }, 401, origin)
    }

    if (!takeRateLimitToken(userId)) {
      return jsonResponse({ error: 'Too many requests' }, 429, origin)
    }

    const ollamaAuth = req.headers.get('x-ollama-auth')?.trim()
    if (!ollamaAuth) {
      return jsonResponse({ error: 'Missing Ollama credentials' }, 400, origin)
    }

    const pathname = new URL(req.url).pathname
    const route = pathname.match(
      new RegExp(`^(?:/functions/v1)?/${FUNCTION_NAME}(/.*)?$`),
    )

    if (!route) return jsonResponse({ error: 'Not found' }, 404, origin)

    const upstreamPath = route[1] || '/'
    const allowedRoute =
      (req.method === 'GET' && upstreamPath === '/v1/models') ||
      (req.method === 'POST' && upstreamPath === '/v1/chat/completions')

    if (!allowedRoute) return jsonResponse({ error: 'Not found' }, 404, origin)

    if (
      req.method === 'POST' &&
      !req.headers.get('content-type')?.toLowerCase().startsWith('application/json')
    ) {
      return jsonResponse({ error: 'Expected application/json' }, 415, origin)
    }

    const incomingUrl = new URL(req.url)
    const targetUrl = new URL(`https://ollama.com${upstreamPath}`)
    targetUrl.search = incomingUrl.search

    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: {
        ...(req.method === 'POST'
          ? { 'Content-Type': 'application/json' }
          : {}),
        Authorization: ollamaAuth,
      },
      body: req.method === 'POST' ? req.body : undefined,
      signal: req.signal,
    })

    const headers = new Headers(corsHeaders(origin))
    const contentType = upstream.headers.get('content-type')
    const cacheControl = upstream.headers.get('cache-control')

    if (contentType) headers.set('Content-Type', contentType)
    if (cacheControl) headers.set('Cache-Control', cacheControl)

    // Returning the body stream directly avoids buffering SSE responses.
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    })
  } catch (error) {
    console.error('Ollama proxy request failed')
    return jsonResponse({ error: 'Upstream request failed' }, 502, origin)
  }
})