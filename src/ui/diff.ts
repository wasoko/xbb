/** Diff one row version against another, for the diff tab.
 *
 *  `diffHunks` runs diff-match-patch once and groups its edit runs, with one line of context,
 *  into hunks; each hunk carries both region strings plus a display string whose ANSI colour
 *  runs mark the local-only text (red) and the server-only text (green).
 *  `applyHunk` writes one hunk's local wording back onto the current text.
 *
 *  Pure; the tab that shows a hunk owns the row write.
 */
import * as diffmp from 'diff-match-patch'

/** One changed region, with enough context to place it in both texts. */
export interface DiffHunk {
  /** Offset of `local` in the local text, in characters. */
  atLocal: number
  /** Offset of `server` in the server text, in characters. */
  atServer: number
  /** Region on the local side: shared context plus the text only the local side has. */
  local: string
  /** The same region on the server side. */
  server: string
  /** `local` with ANSI colour runs: red for the local-only text, green for the server-only one. */
  ansi: string
}

/** Unchanged characters kept on each side of an edit run, so a hunk reads in place. */
const CONTEXT = 40
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const RESET = '\x1b[0m'

/** Split one text against another into changed regions.
 * @param local text of the version being compared (a `cr` or `ver` entry)
 * @param server text the row carries now
 * @returns the changed regions in document order; empty when the two texts match */
export function diffHunks(local: string, server: string): DiffHunk[] {
  if (local === server) return []
  const dmp = new diffmp.diff_match_patch()
  const ops = dmp.diff_main(local, server)
  // merge equalities that exist only to align one character, so a reworded region reads as one hunk
  dmp.diff_cleanupSemantic(ops)
  const hunks: DiffHunk[] = []
  let atLocal = 0
  let atServer = 0
  let i = 0
  while (i < ops.length) {
    const [type, text] = ops[i]
    if (type === diffmp.DIFF_EQUAL) {
      atLocal += text.length
      atServer += text.length
      i++
      continue
    }
    // an edit run: the equal op before it is already consumed, so the context we pull back in
    // has to come off both offsets to keep the regions addressable in the two texts
    const before = i > 0 ? ops[i - 1][1].slice(-CONTEXT) : ''
    const at = { local: atLocal - before.length, server: atServer - before.length }
    const localOnly: string[] = []
    const serverOnly: string[] = []
    while (i < ops.length && ops[i][0] !== diffmp.DIFF_EQUAL) {
      const [t, s] = ops[i]
      if (t !== diffmp.DIFF_INSERT) { localOnly.push(s); atLocal += s.length }
      if (t !== diffmp.DIFF_DELETE) { serverOnly.push(s); atServer += s.length }
      i++
    }
    const after = i < ops.length ? ops[i][1].slice(0, CONTEXT) : ''
    const del = localOnly.join('')
    const ins = serverOnly.join('')
    hunks.push({ atLocal: at.local, atServer: at.server
      , local: before + del + after, server: before + ins + after
      , ansi: before + (del ? RED + del + RESET : '') + (ins ? GREEN + ins + RESET : '') + after })
  }
  return hunks
}

/** Write one hunk's local wording back onto `txt`, leaving every other region as it is.
 * @param txt current text of the row, normally the server-side text the hunk was diffed against
 * @param hunk hunk from `diffHunks`
 * @returns the text with that region replaced, and whether the region could be placed */
export function applyHunk(txt: string, hunk: DiffHunk): { txt: string; failed: boolean } {
  const at = Math.min(hunk.atServer, txt.length)
  const found = txt.startsWith(hunk.server, at) ? at : txt.indexOf(hunk.server)
  if (found < 0) return { txt, failed: true }
  return { txt: txt.slice(0, found) + hunk.local + txt.slice(found + hunk.server.length)
    , failed: false }
}

/** One coloured run of an ANSI display string. */
export interface AnsiRun {
  text: string
  color?: 'red' | 'green'
}

/** Split a string carrying `\x1b[31m`/`\x1b[32m`/`\x1b[0m` into coloured runs.
 *  Other escape sequences are dropped from the text and leave the colour unchanged, so row
 *  text cannot smuggle control codes into the view.
 * @param text display string, normally a `DiffHunk.ansi`
 * @returns the runs in order, each coloured or plain */
export function parseAnsi(text: string): AnsiRun[] {
  const runs: AnsiRun[] = []
  const escape = /\x1b\[[0-9;]*[A-Za-z]/g
  let color: AnsiRun['color']
  let last = 0
  const push = (t: string) => { if (t) runs.push(color ? { text: t, color } : { text: t }) }
  for (let m = escape.exec(text); m; m = escape.exec(text)) {
    push(text.slice(last, m.index))
    last = m.index + m[0].length
    if (!m[0].endsWith('m')) continue // not an SGR code: drop it, keep the colour
    for (const p of m[0].slice(2, -1).split(';')) {
      if (p === '31') color = 'red'
      else if (p === '32') color = 'green'
      else if (p === '0' || p === '') color = undefined
    }
  }
  push(text.slice(last))
  return runs
}
