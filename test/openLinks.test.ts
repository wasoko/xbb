/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { linkAtText } from '../src/ui/openLinks';

describe('linkAtText', () => {
  it('takes a markdown link from its label and its destination', () => {
    const line = 'see [the docs](https://example.com/a) now';
    expect(linkAtText(line, line.indexOf('the docs'))).toBe('https://example.com/a');
    expect(linkAtText(line, line.indexOf('https'))).toBe('https://example.com/a');
  });

  it('trims a trailing full stop from a bare URL', () => {
    expect(linkAtText('go https://example.com/a.', 12)).toBe('https://example.com/a');
  });

  it('finds nothing outside a link', () => {
    expect(linkAtText('plain text', 3)).toBeUndefined();
  });
});
