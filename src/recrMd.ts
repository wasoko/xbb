/**
 * recrMd.ts — the small Markdown dialect `secret.md` and `gate.md` are written in.
 *
 * Both documents share one shape: `## Section` headings holding `* Key: value`
 * lines, with `- item: value` lists nested under a bullet key.
 *
 *   ## Default
 *   * Provider: fb g4
 *
 *   ## Providers
 *   ### fb g4
 *   * Models:
 *     - qw35: qwen3.5
 */

/** Bodies of the `## Name` sections, keyed by trimmed heading text. */
export function splitSections(md: string): Map<string, string> {
  return headings(md, 2);
}

/** Bodies of the `### Name` subsections inside one section body. */
export function subSections(body: string): Map<string, string> {
  return headings(body, 3);
}

/** `* Key: value` lines, key lowercased; a bullet key without a value yields ''. */
export function bulletKv(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^\*\s*([^:*]+):\s*(.*)$/);
    if (m) out[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return out;
}

/**
 * The `- item: value` entries listed under `* <label>:` in `block`.
 * The list ends at the next `*` bullet, which starts the next key.
 */
export function bulletList(block: string, label: string): Record<string, string> {
  const lines = block.split('\n');
  const start = lines.findIndex(l => l.trim().toLowerCase() === `* ${label.toLowerCase()}:`);
  const out: Record<string, string> = {};
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    if (lines[i].startsWith('*')) break;
    const m = lines[i].match(/^\s*-\s*([^:]+):\s*(.+)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/**
 * Split `md` into `depth`-level heading bodies, keyed by trimmed heading text.
 * A deeper heading is content, not a boundary.
 *
 * @param md markdown source
 * @param depth number of `#` characters that start a boundary heading
 * @returns one entry per heading, in document order
 */
function headings(md: string, depth: number): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (name !== undefined) out.set(name, buf.join('\n').trim());
    buf = [];
  };
  for (const line of md.split('\n')) {
    const m = line.match(/^(#+)\s*(.*?)\s*$/);
    if (m && m[1].length === depth) { flush(); name = m[2]; continue; }
    if (name !== undefined) buf.push(line);
  }
  flush();
  return out;
}
