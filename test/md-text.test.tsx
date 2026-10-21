// @vitest-environment happy-dom
/**
 * Chat markdown: block syntax becomes markup, model-supplied HTML stays escaped,
 * and a link keeps the anchor the click handler diverts to a new tab.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MdText } from '../src/ui/MdText';

/** Markup of one markdown body. */
const html = (text: string): string =>
  renderToStaticMarkup(<MdText text={text} className="md-body" />);

describe('MdText', () => {
  it('renders headings, lists and fenced code', () => {
    const out = html('# Title\n\n- one\n- two\n\n```ts\nconst x = 1;\n```');
    expect(out).toContain('<h1');
    expect(out).toContain('<li>one</li>');
    expect(out).toContain('<pre><code class="language-ts">');
  });

  it('escapes HTML the model wrote', () => {
    const out = html('<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;img');
  });

  it('keeps a link as an anchor the click handler can open elsewhere', () => {
    const out = html('see [docs](https://example.test/a)');
    expect(out).toContain('href="https://example.test/a"');
    expect(out).toContain('>docs</a>');
  });

  it('renders a table, which the display instance enables', () => {
    const out = html('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(out).toContain('<table>');
    expect(out).toContain('<th>a</th>');
  });

  it('opens a link in a new tab instead of navigating the app', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(<MdText text="[docs](https://example.test/a)" />); });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const anchor = host.querySelector('a');
    expect(anchor).not.toBeNull();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.test/a', '_blank', 'noopener,noreferrer');
    open.mockRestore();
    await act(async () => { root.unmount(); });
    host.remove();
  });
});
