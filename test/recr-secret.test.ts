/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getSecret } from '../src/sdb';
import {
  createBranchingSession, KEYS_REF, getStore, nextKeyAlias, parseSecrets, readKeyPrefs,
  sessionModelOverride, setKeyPref, setSecretKeys, withKeyPref, withSecretKeys,
} from '../src/recr';

/** The document shape the user writes into the `secret.md` row. */
const DOC = `## Default
* Provider: fb g4
* Model: qw35
* Keys:

## Providers
### ds
* API: openai-completions
* Base URL: https://api.deepseek.com
* Models:
  - dsv4pro: deepseek-v4-pro
* API Keys:
  - wasgsd: sk-ds

### fb g4
* API: openai-completions
* Base URL: https://api.example.com
* Models:
  - qw35: qwen3.5
* API Keys:
  - first: sk-first
  - second: sk-second
`;

async function putSecret(txt: string) {
  await db.das.put({ ref: 'secret.md', type: 'md', txt, rec: {}, dt: new Date() });
}

describe('parseSecrets', () => {
  beforeEach(async () => {
    await db.das.clear();
  });

  it('resolves a provider heading that contains spaces', async () => {
    await putSecret(DOC);
    const cfg = await parseSecrets(getStore());
    expect(cfg.apiBaseUrl).toBe('https://api.example.com');
    expect(cfg.model).toBe('qwen3.5');
    expect(cfg.providerName).toBe('fb g4');
    expect(cfg.modelAlias).toBe('qw35');
  });

  it('auto tracks a blank Keys line: records the first key in settings/keys', async () => {
    await putSecret(DOC);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const cfg = await parseSecrets(getStore());
    expect(cfg.apiKey).toBe('sk-first');
    expect(cfg.keyAlias).toBe('first');
    expect(cfg.keyAliases).toEqual(['first', 'second']);
    expect(warn).not.toHaveBeenCalled();
    // The rotation lands beside the session rows, so secret.md keeps the text a human wrote.
    expect(await readKeyPrefs(getStore())).toEqual({ 'fb g4': 'first' });
    expect(await getStore().get('secret.md')).toBe(DOC);
    warn.mockRestore();
  });

  it('uses the alias the rotation settled on, ahead of the first listed key', async () => {
    await putSecret(DOC);
    await setKeyPref(getStore(), 'fb g4', 'second');

    const cfg = await parseSecrets(getStore());

    expect(cfg.apiKey).toBe('sk-second');
    expect(cfg.keyAlias).toBe('second');
    expect(await getStore().get('secret.md')).toBe(DOC);
  });

  it('ignores a tracked alias the provider no longer lists', async () => {
    await putSecret(DOC);
    await setKeyPref(getStore(), 'fb g4', 'retired');

    const cfg = await parseSecrets(getStore());

    expect(cfg.keyAlias).toBe('first');
    expect(await readKeyPrefs(getStore())).toEqual({ 'fb g4': 'first' });
  });

  it('lets a manual Keys line win over the tracked rotation', async () => {
    await putSecret(DOC.replace('* Keys:', '* Keys: second'));
    await setKeyPref(getStore(), 'fb g4', 'first');

    const cfg = await parseSecrets(getStore());

    expect(cfg.keyAlias).toBe('second');
    expect(await readKeyPrefs(getStore())).toEqual({ 'fb g4': 'first' });
  });

  it('resolves the provider and model a chat is pinned to', async () => {
    await putSecret(DOC);

    const cfg = await parseSecrets(getStore(), 'ds:dsv4pro');

    expect(cfg.providerName).toBe('ds');
    expect(cfg.model).toBe('deepseek-v4-pro');
  });

  it('pins a chat through its meta and reads the pin back as an override', () => {
    const session = createBranchingSession('s1', 'chat', { provider: 'fb g4', model: 'qw35' });
    expect(session.provider).toBe('fb g4');
    expect(session.model).toBe('qw35');
    expect(sessionModelOverride(session)).toBe('fb g4:qw35');
    expect(sessionModelOverride(createBranchingSession('s2'))).toBeUndefined();
    expect(sessionModelOverride({ ...session, model: undefined })).toBeUndefined();
  });

  it('uses the named key when it exists', async () => {
    await putSecret(DOC.replace('* Keys:', '* Keys: second'));
    const cfg = await parseSecrets(getStore());
    expect(cfg.apiKey).toBe('sk-second');
  });

  it('warns about unmatched key aliases and lists them', async () => {
    await putSecret(DOC.replace('* Keys:', '* Keys: nope, other'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const cfg = await parseSecrets(getStore());
    expect(cfg.apiKey).toBe('sk-first');
    expect(String(warn.mock.calls[0][0])).toContain('nope, other');
    warn.mockRestore();
  });

  it('reports the missing document by ref', async () => {
    await expect(parseSecrets(getStore())).rejects.toThrow(/ref=secret\.md/);
  });

  it('reports an unknown provider', async () => {
    await putSecret(DOC.replace('* Provider: fb g4', '* Provider: nope'));
    await expect(parseSecrets(getStore())).rejects.toThrow(/Provider not found.*"nope"/);
  });

  it('reports an unknown model alias', async () => {
    await putSecret(DOC.replace('* Model: qw35', '* Model: nope'));
    await expect(parseSecrets(getStore())).rejects.toThrow(/Model not found.*"nope"/);
  });

  it('reads the row through getSecret, the same lookup the store uses', async () => {
    await putSecret(DOC);
    expect(await getSecret()).toBe(DOC);
  });

  it('ignores a tombstoned secret row', async () => {
    await putSecret(DOC);
    await getStore().delete('secret.md');
    await expect(parseSecrets(getStore())).rejects.toThrow(/ref=secret\.md/);
  });
});

describe('nextKeyAlias', () => {
  it('steps through the listed keys and wraps', () => {
    expect(nextKeyAlias(['a', 'b', 'c'], 'a')).toBe('b');
    expect(nextKeyAlias(['a', 'b', 'c'], 'c')).toBe('a');
    expect(nextKeyAlias(['a', 'b', 'c'])).toBe('a');
    expect(nextKeyAlias(['a', 'b', 'c'], 'gone')).toBe('a');
  });

  it('has no next key when the provider lists fewer than two', () => {
    expect(nextKeyAlias(['a'], 'a')).toBeUndefined();
    expect(nextKeyAlias([], 'a')).toBeUndefined();
  });
});

describe('withSecretKeys', () => {
  it('replaces only the Default Keys line', () => {
    const out = withSecretKeys(DOC, ['second']);
    expect(out).toContain('* Keys: second');
    expect(out.slice(out.indexOf('## Providers'))).toBe(DOC.slice(DOC.indexOf('## Providers')));
  });

  it('is what setSecretKeys writes to the row', async () => {
    await putSecret(DOC);
    await setSecretKeys(getStore(), ['second']);
    expect(await getSecret()).toBe(withSecretKeys(DOC, ['second']));
  });
});

describe('key rotation state', () => {
  beforeEach(async () => {
    await db.das.clear();
  });

  it('is empty until a provider rotates', async () => {
    expect(await readKeyPrefs(getStore())).toEqual({});
  });

  it('appends a provider section and keeps every other byte', async () => {
    await setKeyPref(getStore(), 'fb g4', 'first');
    await setKeyPref(getStore(), 'ds', 'wasgsd');

    expect(await getStore().get(KEYS_REF)).toBe('\n## fb g4\n* Key: first\n\n## ds\n* Key: wasgsd\n');
    expect(await readKeyPrefs(getStore())).toEqual({ 'fb g4': 'first', ds: 'wasgsd' });
  });

  it('rewrites only the one provider line', () => {
    const md = '\n## fb g4\n* Key: first\n\n## ds\n* Key: wasgsd\n';
    const out = withKeyPref(md, 'fb g4', 'second');
    expect(out).toContain('## fb g4\n* Key: second');
    expect(out.slice(out.indexOf('## ds'))).toBe('## ds\n* Key: wasgsd\n');
  });

  it('matches a provider heading whose name holds regex characters', () => {
    const out = withKeyPref('\n## a.b (test)\n* Key: one\n', 'a.b (test)', 'two');
    expect(out).toContain('* Key: two');
    expect(out.match(/\* Key:/g)).toHaveLength(1);
  });
});
