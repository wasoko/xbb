/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getSecret } from '../src/sdb';
import {
  LlmHttpError, createBranchingSession, getStore, loadBranchingSession, parseSecrets, rcr,
  readKeyPrefs, saveBranchingSession, setSecretKeys, type IRecrStore,
} from '../src/recr';

/** A document whose Default section leans on the provider's listed keys. */
const DOC = `## Default
* Provider: p
* Model: m
* Keys:

## Providers
### p
* API: openai-completions
* Base URL: https://llm.test
* Models:
  - m: test-model
* API Keys:
  - first: sk-first
  - second: sk-second

### q
* API: openai-completions
* Base URL: https://q.test
* Models:
  - mq: other-model
* API Keys:
  - only: sk-q
`;

const SETTINGS = { maxIterations: 1, maxToolCalls: 4 };

/** One SSE round with a text reply and no tool call. */
function sseOk(reply: string) {
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

/** Statuses the stub answers, in order; a value answers a non-OK status. */
function stubLlm(statuses: number[]) {
  const auths: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
    auths.push(init.headers['Authorization']);
    const status = statuses.shift() ?? 200;
    if (status !== 200) return { ok: false, status, text: async () => `bad key (${status})` };
    return sseOk('answered');
  });
  return auths;
}

/** How many node rows the session holds: a retried turn must not add another. */
async function nodeRows(sessionId: string): Promise<number> {
  const store: IRecrStore = getStore();
  return (await store.scan(`sess/${sessionId}/node/`)).length;
}

beforeEach(async () => {
  await db.das.clear();
  await db.das.put({ ref: 'secret.md', type: 'md', txt: DOC, rec: {}, dt: new Date() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('key fallback after a non-OK status', () => {
  it('continues the same turn with the key the caller hands back', async () => {
    const auths = stubLlm([401]);
    const asked: string[] = [];

    const result = await rcr({
      prompt: 'hi', settings: SETTINGS,
      onHttpError: async (e) => {
        asked.push(`${e.status}:${e.keyAlias}`);
        await setSecretKeys(getStore(), ['second']);
        return parseSecrets(getStore());
      },
    });

    expect(asked).toEqual(['401:first']);
    expect(auths).toEqual(['Bearer sk-first', 'Bearer sk-second']);
    expect(result.finalNode.assistantResponse?.content).toBe('answered');
    // The selection is a row edit, so `greet` can push it to other clients.
    expect(await getSecret()).toContain('* Keys: second');
    // A retry is the same iteration: one node, not a second turn.
    expect(await nodeRows(result.session.id)).toBe(1);
    expect((await loadBranchingSession(getStore(), result.session.id)).currentHeadId)
      .toBe(result.finalNode.id);
  });

  it('rethrows the status when the caller offers no other key', async () => {
    const auths = stubLlm([429]);

    await expect(rcr({ prompt: 'hi', settings: SETTINGS, onHttpError: async () => undefined }))
      .rejects.toBeInstanceOf(LlmHttpError);
    expect(auths).toEqual(['Bearer sk-first']);
  });

  it('stops asking once every listed key has been tried', async () => {
    const auths = stubLlm([500, 500]);
    const asked: string[] = [];

    await expect(rcr({
      prompt: 'hi', settings: SETTINGS,
      onHttpError: async (e) => {
        asked.push(e.keyAlias!);
        await setSecretKeys(getStore(), e.keyAlias === 'first' ? ['second'] : ['first']);
        return parseSecrets(getStore());
      },
    })).rejects.toBeInstanceOf(LlmHttpError);

    expect(asked).toEqual(['first']);
    expect(auths).toHaveLength(2);
  });

  it('never asks about a request that did not reach the provider', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    const asked: string[] = [];

    await expect(rcr({
      prompt: 'hi', settings: SETTINGS,
      onHttpError: async (e) => { asked.push(e.keyAlias!); return undefined; },
    })).rejects.toThrow(/Cannot reach/);
    expect(asked).toEqual([]);
  });
});

describe('auto track', () => {
  it('records the first listed key in settings/keys, and reuses it after', async () => {
    const auths = stubLlm([]);

    const first = await rcr({ prompt: 'hi', settings: SETTINGS });
    expect(auths).toEqual(['Bearer sk-first']);
    expect(await readKeyPrefs(getStore())).toEqual({ p: 'first' });
    // a rotation is client state, so the shared document keeps its own text
    expect(await getSecret()).toBe(DOC);

    const session = createBranchingSession('sess-reuse');
    await rcr({ prompt: 'again', sessionId: session.id, config: await parseSecrets(getStore())
      , settings: SETTINGS });
    expect(auths[1]).toBe('Bearer sk-first');
    expect(first.finalNode.assistantResponse?.content).toBe('answered');
  });
});

describe('pinned chat', () => {
  it('sends the provider and model the session meta names, not the Default pair', async () => {
    const auths = stubLlm([]);
    const session = createBranchingSession('sess-pin', 'pinned', { provider: 'q', model: 'mq' });
    await saveBranchingSession(getStore(), session);

    await rcr({ prompt: 'hi', sessionId: session.id, settings: SETTINGS });

    expect(auths).toEqual(['Bearer sk-q']);
  });

  it('records a pin the caller passes on the session it starts', async () => {
    stubLlm([]);

    const result = await rcr({
      prompt: 'hi', settings: SETTINGS, pin: { provider: 'q', model: 'mq' },
    });

    const meta = await loadBranchingSession(getStore(), result.session.id);
    expect(meta.provider).toBe('q');
    expect(meta.model).toBe('mq');
  });
});
