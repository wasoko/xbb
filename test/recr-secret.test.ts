/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getSecret } from '../src/sdb';
import { getStore, parseSecrets } from '../src/recr';

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

  it('falls back to the provider first key when Keys is blank, and warns', async () => {
    await putSecret(DOC);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const cfg = await parseSecrets(getStore());
    expect(cfg.apiKey).toBe('sk-first');
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('blank "Keys"');
    warn.mockRestore();
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
