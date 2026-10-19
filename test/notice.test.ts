/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { noticeStore, subscribeNotices } from '../src/ui/notice';
import { getStts, stts, subscribeStts } from '../src/fc';

describe('noticeStore', () => {
  beforeEach(() => localStorage.clear());

  it('notifies an open panel after the history write', async () => {
    let paints = 0;
    const off = subscribeNotices(() => { paints++; });

    await noticeStore({ scope: '-lastgreet', message: 'uploaded da.2.cbor.pako', level: 'info' });
    off();

    expect(paints).toBe(1);
    const history = JSON.parse(localStorage.getItem('noticeHistory') ?? '{}');
    expect(history['info:-lastgreet'].items[0].message).toBe('uploaded da.2.cbor.pako');
  });
});

describe('stts', () => {
  it('publishes the newest message of one scope to its subscribers', () => {
    let paints = 0;
    const off = subscribeStts(() => { paints++; });

    stts('da.2', '-lastgreet');
    off();

    expect(getStts('-lastgreet')).toBe('da.2');
    expect(paints).toBe(1);
  });
});
