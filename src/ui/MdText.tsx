/**
 * `MdText.tsx` — markdown displayed as HTML, used by the chat transcript.
 *
 * `renderMd` keeps model-supplied HTML escaped and leaves `$..$` math as a
 * placeholder until {@link hydrateMath} fills it after paint. A link opens in a
 * new tab: the options page is the app itself, so following a link in place would
 * replace the chat with the target.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { hydrateMath, renderMd } from '../md';

interface MdTextProps {
  /** Markdown source. */
  text: string;
  /** Classes for the host element; `.md-body` carries the block typography. */
  className?: string;
}

/**
 * Opens `href` outside the app, without handing the opener to the target.
 *
 * @param href - Resolved link target.
 */
function openElsewhere(href: string): void {
  window.open(href, '_blank', 'noopener,noreferrer');
}

/**
 * Renders markdown into a host element and hydrates its math placeholders.
 *
 * @param props.text - Markdown source.
 * @param props.className - Classes for the host element.
 * @returns the host element carrying the rendered HTML.
 */
export function MdText({ text, className }: MdTextProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const html = useMemo(() => renderMd(text), [text]);

  useEffect(() => {
    if (host.current) void hydrateMath(host.current);
  }, [html]);

  /** Keep the app in place: every link in the rendered body leaves in a new tab. */
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as Element).closest('a[href]');
    if (!anchor || !host.current?.contains(anchor)) return;
    e.preventDefault();
    openElsewhere((anchor as HTMLAnchorElement).href);
  };

  return (
    <div ref={host} className={className} onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }} />
  );
}
