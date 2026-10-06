/** Diff one row version against another, for the diff tab.
 *
 *  `diffHunks` runs diff-match-patch once and groups its edit runs, with one line of context,
 *  into hunks; each hunk carries both region strings plus a display string whose ANSI colour
 *  runs mark the local-only text (red) and the server-only text (green). A hunk also carries
 *  its `changes`: the same region split into the delete/insert blocks a user can take one at
 *  a time.
 *  `applyHunk` writes one hunk's — or one change's — local wording back onto the current text.
 *  `diffStat` measures a version against the row text as a line count, for the tab menu.
 *
 *  Pure; the tab that shows a hunk owns the row write.
 */
import * as diffmp from 'diff-match-patch'

/** One applicable change: the local-only text and the server-only text it replaces.
 *  Applying it leaves every other change of the same region in place. */
export interface DiffChange {
  /** Offset of `local` in the local text, in characters. */
  atLocal: number
  /** Offset of `server` in the server text, in characters. */
  atServer: number
  /** Text only the local side has here; empty for a pure deletion. */
  local: string
  /** Text only the server side has here; empty for a pure insertion. */
  server: string
  /** `local` red and `server` green, without context. */
  ansi: string
}

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
  /** The changes this region holds, in document order, each applicable on its own. */
  changes: DiffChange[]
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
    const changes: DiffChange[] = []
    let del = ''
    let ins = ''
    let atChange = { ...at }
    let last: number | undefined
    // one change is a delete block plus the insert block replacing it; a further delete after
    // an insert opens the next change, so one region can be applied in pieces
    const flush = () => {
      if (del === '' && ins === '') return
      changes.push({ atLocal: atChange.local, atServer: atChange.server, local: del, server: ins
        , ansi: (del ? RED + del + RESET : '') + (ins ? GREEN + ins + RESET : '') })
      del = ''
      ins = ''
      last = undefined
    }
    while (i < ops.length && ops[i][0] !== diffmp.DIFF_EQUAL) {
      const [t, s] = ops[i]
      if (last === diffmp.DIFF_INSERT && t === diffmp.DIFF_DELETE) flush()
      if (del === '' && ins === '') atChange = { local: atLocal, server: atServer }
      if (t !== diffmp.DIFF_INSERT) { del += s; atLocal += s.length }
      if (t !== diffmp.DIFF_DELETE) { ins += s; atServer += s.length }
      last = t
      i++
    }
    flush()
    const after = i < ops.length ? ops[i][1].slice(0, CONTEXT) : ''
    hunks.push({ atLocal: at.local, atServer: at.server
      , local: before + changes.map(c => c.local).join('') + after
      , server: before + changes.map(c => c.server).join('') + after
      , ansi: before + changes.map(c => c.ansi).join('') + after, changes })
  }
  return hunks
}

/** Lines one version would add and remove against the text the row carries now.
 *  Counts a run's partial trailing line as one line. */
export interface DiffStat {
  /** Lines only the version has: what applying it would write in. */
  add: number
  /** Lines only the row text has: what applying the version would take out. */
  del: number
}

/** Measure one version against the text the row carries now.
 * @param version text of a `ver` or `cr` entry
 * @param row text the row carries now
 * @returns the added and removed line counts; both zero when the two texts match */
export function diffStat(version: string, row: string): DiffStat {
  if (version === row) return { add: 0, del: 0 }
  const dmp = new diffmp.diff_match_patch()
  let add = 0
  let del = 0
  for (const [t, s] of dmp.diff_main(version, row)) {
    if (t === diffmp.DIFF_EQUAL || s === '') continue
    const lines = s.split('\n').length - (s.endsWith('\n') ? 1 : 0)
    // a `DELETE` op is text the version has and the row does not
    if (t === diffmp.DIFF_DELETE) add += lines
    else del += lines
  }
  return { add, del }
}

/** Write one hunk's — or one change's — local wording back onto `txt`, leaving the rest as it is.
 * @param txt current text of the row, normally the server-side text the hunk was diffed against
 * @param hunk hunk from `diffHunks`, or one of its `changes`
 * @returns the text with that region replaced, and whether the region could be placed */
export function applyHunk(txt: string, hunk: Pick<DiffHunk, 'atServer' | 'local' | 'server'>)
  : { txt: string; failed: boolean } {
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
