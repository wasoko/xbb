// @vitest-environment happy-dom
/**
 * recr-fetch.test.ts — which endpoint `fetchLLM` posts to.
 *
 * An extension page answers CORS through its host permissions, so it calls the
 * provider directly. A webapp page cannot reach `ollama.com` and uses the
 * Supabase function instead.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLLM, type ChatMessage, type SecretsConfig } from '../src/recr';
import { treeCac } from '../src/sdb';

// The proxy path reads the signed-in session; the greeting module's own side
// effects would open a Supabase client in this test.
vi.mock('../src/greet', () => ({
  sbg: { auth: { getSession: async () => ({ data: { session: { access_token: 'session-token' } } }) } },
}));

const CONFIG: SecretsConfig = {
  apiBaseUrl: 'https://ollama.com',
  apiKey: 'sk-ollama',
  model: 'test-model',
};
const SETTINGS = { maxIterations: 1, maxToolCalls: 1 };
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const PROXY_URL = `${String(treeCac['server']).replace(/\/+$/, '')}/functions/v1/v1a/v1/chat/completions`;

/** One SSE round with a text reply and no tool call. */
function sseOk(reply = 'answered') {
  const encoder = new TextEncoder();
  const stream = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  return {
    ok: true,
    body: {
      getReader: () => {
        let sent = false;
        return { read: async () => (sent ? { done: true, value: undefined }
          : (sent = true, { done: false, value: encoder.encode(stream) })) };
      },
    },
    text: async () => stream,
  };
}

/** Stub `fetch` and return the URL and headers each call sent. */
function capture() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return sseOk();
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchLLM endpoint', () => {
  it('calls the provider directly from an extension page', async () => {
    vi.stubGlobal('chrome', { runtime: { id: 'ext-id' } });
    vi.stubGlobal('location', { protocol: 'chrome-extension:' });
    const calls = capture();

    const result = await fetchLLM({
      messages: MESSAGES, tools: [], config: CONFIG, settings: SETTINGS,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://ollama.com/v1/chat/completions');
    expect(calls[0].headers['Authorization']).toBe('Bearer sk-ollama');
    expect(calls[0].headers['x-ollama-auth']).toBeUndefined();
    expect(calls[0].headers['apikey']).toBeUndefined();
    expect(result.text).toBe('answered');
  });

  it('routes a webapp page through the Supabase proxy', async () => {
    vi.stubGlobal('chrome', undefined);
    vi.stubGlobal('location', { protocol: 'https:' });
    const calls = capture();

    await fetchLLM({
      messages: MESSAGES, tools: [], config: CONFIG, settings: SETTINGS,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(PROXY_URL);
    expect(calls[0].headers['Authorization']).toBe('Bearer session-token');
    expect(calls[0].headers['x-ollama-auth']).toBe('sk-ollama');
    expect(calls[0].headers['apikey']).toBe(String(treeCac['pub_key']));
  });
});
