import * as fc from './fc';
import * as diffmp from 'diff-match-patch'
import { countBy } from 'es-toolkit';
import {Dexie} from 'dexie';
import { dt } from 'framer-motion/client';
import { RECR_TYPE, SECRET_REF } from './recrConst';
// no , as `${t.tags}` default join by , (NOTE: largest index space)
export interface Da { tid?: number, txt: string, ref: string, type: string
  , tags?: string[]
  , dt?:Date, modAt?:Date, rec: Record<string,unknown> } // dt=server dt , 'bookmark' | 'history' | 'tab' | 'tag'
export const eqDas = (r1: Da, r2: Da) => r1.ref === r2.ref && r1.txt === r2.txt && r1.type== r2.type
export const daUniq = (t: Da) => t.type+t.ref
export const daPk = (t: Da) => t.tid
/** Row without its auto-increment key, for a relocated copy that must take a fresh `tid`. */
export const daNoPk = ({tid:_, ...rest}:any) => rest 
export const tags2str=(t:Da) => JSON.stringify([t.ref, t.txt, t.type, t.tags ?? []])
export const tid_last = async ()=>await db.das.orderBy(':id').last()
export async function clean() {
  const now = new Date()
  const null_dt = await db.das.filter(t=> t.dt===undefined).toArray()
  let updates = null_dt.map(t=> ({key:t.tid, changes:{dt: now}}))
  if (updates.length >0) return await db.das.bulkUpdate(updates)
  
  return 0
}
/** Archive one value under `key` in `db.bins`, gzipped+cbor.
 * @param key archive name
 * @param bin value to store
 * @returns the Dexie put, so a caller that must not lose the archive can await it */
export async function binPut(key:string, bin: any) {
  return db.bins.put({ key, rec: { date: new Date().toLocaleString('zh-cn',{hour12:false}) }
      , bin: fc.encZip(bin) });
}
export class DDB extends Dexie {
  tree!: Dexie.Table<{ key: string, value: unknown }>;
  das!: Dexie.Table<Da>;
  vecs!: Dexie.Table<{ tid: number, mdl: string, vec: Float32Array }>;
  /** Content-keyed embeddings; see `src/vecCache.ts`. */
  embs!: Dexie.Table<{ hash: string, mdl: string, vec: Float32Array }>;
  stat!: Dexie.Table<{ tid: number, key: string, value:unknown }>;
  bins!: Dexie.Table<{ key: string, rec: unknown, bin: Uint8Array, addAt?: Date, modAt?:Date}>;

  constructor(dbName: string = 'tagDB_0') {
    super(dbName)

    this.version(12).stores({  // to infer 2nd generic type
      tree: 'key', // href+title, 
      das: '++tid, dt, type, *tags, [ref+type], modAt',
      vecs: '[tid+mdl]', // for orama or psqlvec
      stat: '[tid+key]',
      bins: 'key, [key+addAt], [key+modAt]',
      refs: '++id, title, href, dt, type'
    })
    /* `embs` holds an embedding under its content hash rather than under a row id,
       so an edited title invalidates itself (`srctag.textHash`, `src/vecCache.ts`).
       It is a new table rather than a re-key of `vecs`, because Dexie aborts an
       upgrade that changes a table's primary key (`UpgradeError`); nothing ever
       wrote the old row-keyed one, so the same version drops it. */
    this.version(13).stores({
      vecs: null,
      embs: '[hash+mdl], mdl',
    })
    function updatingHook(mod:any) { return {...mod, modAt: new Date()}}
    function creatingHook(_priKey:any, row:any) { 
      if (!row.addAt) row.addAt = new Date();
      if (!row.modAt) row.modAt = row.addAt
    }

    this.bins.hook('updating', updatingHook)
    this.bins.hook('creating', creatingHook)
  }
}
export const db = new DDB(); 
export const dbReady = db.open()
export const treeCac:{[key:string]: unknown} = {
  "devAgent": "this"+fc.userAgentStr(),
  "server": 'https://qhumewjpkzxaltwefqch.supabase.co',
  "pub_key": 'sb_publishable_5Stcng45Jofw5Wv3FA4GnQ_BivUYQ_K',
  // FI|XME sbg await dbInit async treeCac 
  // "server": 'https://dwimmnjiowmzvoswyxgm.supabase.co',
  // "pub_key": 'sb_publishable__LynaQz69kH--YZOG3k2ug_ovBOgZhu',
  'snap_name': 'tabext-beta',
  // '' follows the newest CDN snapshot; a filename pins the working set to that snapshot.
  'snap_pin': '',
  'tabSeer': 'cardtab',
  'cardSeer': 'cs1',
  'restGrouper': 'rsdt',
  // , "emb_model-HF":HF_OR[0]
}
export let treeCacOpts: Record<string, string[]> = {
  'tabSeer': ['cardtab', 'card'],
  'cardSeer': ['cs1', 'cs2'],
  // `snap_pin` options are the recent CDN snapshots, cached here by the settings menu.
  'snap_pin': [],
  // `rsdt`/`rsid`/`rsess`/`rstag`/`rstext`/`rsfreq`/`rstrank`/`rstt` are built in; `restGroupers/...` refs are appended from `db.das` at render.
  'restGrouper': ['rsdt', 'rsid', 'rsess', 'rstag', 'rstext', 'rsfreq', 'rstrank', 'rstt', 'none'],
  'provider-model': ['Default'],
};

export let treeCacCurrent: Record<string, string> = {};
export async function dbInit() {
  await dbReady
  const exist = await db.tree.bulkGet(Object.keys(treeCac))
  await db.tree.bulkPut(Object.entries(treeCac).filter((_, i) => !exist[i] || exist[i].value === '')
    .map(([key, value]) => ({ key, value: value })))
  Object.assign(treeCac, ...exist.filter(Boolean).map(r => ({ [r.key]: r.value })))
  return treeCac
}
export const treeCacReady = dbInit()
export async function getRowsAroundTid(tid: number, n: number) {
  // Get n rows before tid (in reverse order, then reverse back for chronological)
  n = Math.max(3, n)
  const b4 = await db.das.where('tid').below(tid).reverse().limit(n/2).toArray()
  const af = await db.das.where('tid').above(tid).limit(n -n/2 -1).toArray();
  const eq = await db.das.get(tid)
  return [...af.reverse(), eq , ...b4] .filter(t=> t!==undefined);
}

/** Minimal query: filter by tags via MultiEntry index, or anchor on tid */
export async function iq(filters: string[], search?: string, tidNum?: number, limit?: number): Promise<Da[]> {
  if (tidNum) {
    const rows = await getRowsAroundTid(tidNum, limit ?? 33);
    return rows.filter((t): t is Da => t !== undefined && isUiTag(t));
  }
  filters = filters.filter(f=> f.trim().length>0)
  // `f=recr` is the one way recr's own rows reach the card list; every other query
  // keeps them out of the tag UI (`isUiTag`), so a session node is never listed as a tag.
  const recrMode = filters.length === 1 && filters[0] === RECR_FILTER;
  let col = recrMode
    ? db.das.where('type').equals(RECR_TYPE)
    : filters.length > 0
      ? db.das.where('tags').equals(filters[0])
      : db.das.toCollection();

  if (!recrMode) col = col.filter(isUiTag);
  const extra = recrMode ? [] : filters.slice(1);
  if (extra.length)
    col = col.filter(row => extra.every(f => row.tags?.includes(f)));

  const arr = await col.reverse().limit(limit ?? 555).toArray()
  // filter out deleted rows
  const active = arr.filter(r => !r.tags?.includes(DEL_TAG))
  if (search) return active.filter(s=> s.txt.toLocaleLowerCase()
    .includes(search?.toLocaleLowerCase()));// FIXME beyond limit full search
  return active
}


// CrumbItem enriched with per-tag max timestamps from rec
export interface CrumbItem {
  tag: string;
  count: number;
  maxVisitTime?: number;
  maxAccess2discard?: number;
}

// 2. Global or Module-level Cache
const iqCache = new Map<string, CrumbItem[]>();

/** Extract max numeric key from a dict stored in tag.rec[field]. */
function maxRecKey(rec: Record<string, unknown>, ...fields: string[]): number | undefined {
  for (const f of fields) {
    const dict = rec[f];
    if (dict && typeof dict === 'object') {
      const keys = Object.keys(dict as Record<string, unknown>).map(Number).filter(k => !isNaN(k));
      if (keys.length > 0) return Math.max(...keys);
    }
  }
  return undefined;
}

// 1. availableDas — returns CrumbItem[] with per-tag max timestamps
export function availableDas(tags: Da[]): CrumbItem[] {
  const counts: Record<string, number> = {};
  const maxVisit: Record<string, number> = {};
  const maxAccess: Record<string, number> = {};
  tags.forEach(tag => {
    tag.tags?.forEach(s => {
      counts[s] = (counts[s] || 0) + 1;
      if (!tag.rec) return;
      const mv = maxRecKey(tag.rec, 'visitTime', 'visitTIme');
      if (mv !== undefined) maxVisit[s] = Math.max(maxVisit[s] ?? 0, mv);
      const ma = maxRecKey(tag.rec, 'access2discard');
      if (ma !== undefined) maxAccess[s] = Math.max(maxAccess[s] ?? 0, ma);
    });
  });
  const items = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({
      tag,
      count,
      ...(maxVisit[tag] !== undefined ? { maxVisitTime: maxVisit[tag] } : {}),
      ...(maxAccess[tag] !== undefined ? { maxAccess2discard: maxAccess[tag] } : {}),
    }));

  // Find index of the item with the highest maxVisitTime
  const vi = items.reduce((best, cur, i) =>
    (cur.maxVisitTime ?? 0) > (items[best]?.maxVisitTime ?? 0) ? i : best, -1);
  const ai = items.reduce((best, cur, i) =>
    (cur.maxAccess2discard ?? 0) > (items[best]?.maxAccess2discard ?? 0) ? i : best, -1);

  // Collect winners in order: visitTime first, then access2discard
  const visited = new Set<number>();
  const winners: CrumbItem[] = [];
  if (vi !== -1) { winners.push(items[vi]); visited.add(vi); }
  if (ai !== -1 && ai !== vi) { winners.push(items[ai]); visited.add(ai); }

  return [...winners, ...items.filter((_, i) => !visited.has(i))];
}

/** Format a single CrumbItem for Drag options display. */
export function fmtCrumb(crumb: CrumbItem): { item: string; display: string } {
  const maxTs = Math.max(crumb.maxVisitTime ?? 0, crumb.maxAccess2discard ?? 0);
  const display = maxTs > 0
    ? `${crumb.tag} (${fc.fmtAgo(maxTs)} x${crumb.count})`
    : `${crumb.tag} (${crumb.count})`;
  return { item: crumb.tag, display };
}

/** Format an array of CrumbItems into Drag-compatible options. */
export function fmtCrumbs(crumbs: CrumbItem[]): { item: string; display: string }[] {
  return crumbs.map(fmtCrumb);
}
// 3. The Wrapper Function
export async function iqWithCrumbs(
  filters: string[],
  search?: string,
  tidNum?: number,
  limit?: number
) {
  // Clean empty filters just like the original iq function does
  const cleanFilters = filters.filter(f => f.trim().length > 0);

  const crumbsSequence: Array<{
    level: number;
    filtersApplied: string[];
    availableCrumb: CrumbItem[];
  }> = [];

  let finalDas: Da[] = [];

  // Iterate through each filtering stage: No filters -> 1st -> 1st+2nd, etc.
  for (let i = 0; i <= cleanFilters.length; i++) {
    const currentFilters = cleanFilters.slice(0, i);

    // Build a deterministic string key for caching crumbs
    // Note: search, tidNum, and limit are included to prevent stale/incorrect cache hits
    const cacheKey = JSON.stringify({
      f: currentFilters,
      s: search,
      t: tidNum,
      l: limit,
    });

    let crumbs: CrumbItem[];

    // Always execute iq to ensure Dexie reactivity for useLiveQuery
    const tags = await iq(currentFilters, search, tidNum, limit);

    // Cache only the computationally expensive crumbs
    if (iqCache.has(cacheKey)) {
      crumbs = iqCache.get(cacheKey)!;
    } else {
      crumbs = availableDas(tags);
      iqCache.set(cacheKey, crumbs);
    }

    // Record the sequence for this level
    crumbsSequence.push({
      level: i,
      filtersApplied: currentFilters,
      availableCrumb: crumbs,
    });

    // If we've reached the deepest filter level, save the tags to return
    if (i === cleanFilters.length) {
      finalDas = tags;
    }
  }

  return {
    finalDas,
    crumbsSequence,
  };
}

// utils
export const where_pk_last = (tab: { where: (arg0: string) => { (): any; new(): any; between: { (arg0: any[], arg1: any[]): { (): any; new(): any; last: { (): any; new(): any; }; }; new(): any; }; }; }, pairs: any[]) =>Promise.all(
  pairs.map((tup: any) => tab.where(':id')
      .between([...tup, Dexie.minKey], [...tup, Dexie.maxKey])
      .last() ) )

export const dev_PREFFIX = 'dev_'
export const DEL_TAG = '[del]'
/** Marks a row whose local edit a server-wins merge discarded, so the tag UI can list and
 *  clean the rows that still carry a `rec.cr` log. */
export const CHG_REJ_TAG = 'FIXMEchange_rejected'

/** Rows the tag UI owns. recr keeps its session, settings, and tool rows in the same table. */
export const isUiTag = (r: Da) => r.type !== RECR_TYPE

/**
 * Filter value that lists recr's own rows (`sess/*`, `settings/main`, `tools/*`) instead of
 * the tag rows, so the card list can offer them as buttons. Reserved: while it is the only
 * filter, a tag named `recr` is unreachable.
 */
export const RECR_FILTER = RECR_TYPE

/** The `secret.md` document carrying the agent's provider, model, and key selection. */
export async function getSecret(): Promise<string | undefined> {
  return (await daRead(SECRET_REF, 'md'))?.txt
}

/** Row type for a file ref, matching the `src`/`md` pair the editor offers. */
export function daType(ref: string): string {
  return ref.toLowerCase().endsWith('.md') ? 'md' : 'src'
}

/** Row types the editor writes for a tab; `daType` maps a ref onto this pair. */
export const EDITOR_TYPES = ['md', 'src'] as const

/** Rows with no `[del]` tombstone. */
export const daLive = (rows: Da[]) => rows.filter(r => !r.tags?.includes(DEL_TAG))

/** A row whose local edit has not reached the server yet. */
export const daDirty = (row: Da) => row.modAt != null

/** The row carries a discarded-edit log (`rec.cr`): an edit of its own met a server version
 *  whose ancestor copy this client did not hold, so the merge kept the server text and filed
 *  the local text under `cr`. The log is the row's obligation until the diff tab offers it
 *  back, and it merges across clients, so a row can carry another client's discarded edit. */
export const daStale = (row: Da) =>
  Object.keys((row.rec?.cr ?? {}) as Record<string, unknown>).length > 0

/** A row's effective update time: the later of its server `dt` and its local `modAt`. */
export function daStamp(row: Da): number {
  const t = (v?: Date) => (v ? new Date(v).getTime() : -Infinity)
  return Math.max(t(row.dt), t(row.modAt))
}

/** Live rows for `ref`, read through indexes: dirty rows via `modAt`, synced rows via
 *  `[ref+type]`. Only the types the editor writes are searched. */
export async function daRows(ref: string, types: readonly string[] = EDITOR_TYPES): Promise<Da[]> {
  const dirty = await db.das.where('modAt').above(new Date(0)).filter(r => r.ref === ref).toArray()
  const synced = (await Promise.all(types.map(t =>
    db.das.where('[ref+type]').equals([ref, t]).toArray()))).flat()
  const byTid = new Map<number, Da>()
  for (const r of [...dirty, ...synced]) if (r.tid != null) byTid.set(r.tid, r)
  return [...byTid.values()]
}

/** The row that wins among live rows of one `ref`+`type`: a local edit (`modAt`) shadows the
 *  synced copy, otherwise the newest server `dt`. Callers pass rows already free of `[del]`
 *  tombstones. This is the rule `IRecrStore` resolves reads with. */
export function daWin(live: Da[]): Da | undefined {
  if (live.length === 0) return undefined
  const dirty = live.filter(daDirty)
  if (dirty.length > 0) return dirty[dirty.length - 1]
  return daNewest(live)
}

/** The newest server `dt` among rows, ignoring `modAt`. */
export function daNewest(rows: Da[]): Da | undefined {
  if (rows.length === 0) return undefined
  return rows.reduce((a, b) => (new Date(a.dt ?? 0).getTime() > new Date(b.dt ?? 0).getTime() ? a : b))
}

/** The row with the newest effective stamp, tombstone included: it decides whether a key
 *  still exists at all. */
export function daLatest(rows: Da[]): Da | undefined {
  if (rows.length === 0) return undefined
  return rows.reduce((a, b) => (daStamp(a) > daStamp(b) ? a : b))
}

/** Stamps already reported, so one stale row alerts once per version rather than per read. */
const staleReported = new Set<string>()

/** `daStale` is the case the diff tab exists for: log it critically once per discarded edit. */
function reportStale(row: Da) {
  if (!daStale(row)) return
  const keys = Object.keys((row.rec?.cr ?? {}) as Record<string, unknown>)
  const key = `${daUniq(row)}@${keys[keys.length - 1]}`
  if (staleReported.has(key)) return
  staleReported.add(key)
  fc.stts(`err ${keys.length} discarded local edit(s) on ${daUniq(row)}`
    + ` [${keys.join()}] — ancestor version not held, offer the diff tab`, 'sync')
}

/** The row for `ref` (+ optional `type`) the app resolves: a tombstoned newest row means the
 *  key is gone; otherwise the dirty-wins rule picks the visible row.
 *  @param ref row ref
 *  @param type row type; omitted searches the editor's `md`/`src` pair
 *  @returns the winning row, or undefined when absent or deleted */
export async function daRead(ref: string, type?: string): Promise<Da | undefined> {
  const rows = await daRows(ref, type ? [type] : EDITOR_TYPES)
  const newest = daLatest(rows)
  if (newest?.tags?.includes(DEL_TAG)) return undefined
  const win = daWin(daLive(rows))
  if (win) reportStale(win)
  return win
}

/** The single local-write recipe: replace the text and mark the row dirty.
 *  The first edit of a clean row also shelves the row under its own server `dt` in `rec.ver`:
 *  that copy is the ancestor `deepMerge` patches the edit back through when the server
 *  re-delivers the same version. A later edit while the row is still dirty shelves nothing,
 *  because the row then holds post-edit text, which is not the version its `dt` names.
 *  @param row the row as read before the edit
 *  @param txt the new text
 *  @returns the Dexie update spec for the row */
export function daEdit(row: Da, txt: string) {
  const shelf = row.dt != null && row.modAt == null && !pickVer(row.rec, row.dt)
  return shelf
    ? { txt, modAt: new Date(), rec: putVer(row.rec, row.dt, row) }
    : { txt, modAt: new Date() }
}

async function stat_tags(){
  let str = ''
  let cntRef = {}
  ;(await db.das.orderBy('[ref+type]').keys()).forEach(k=>  cntRef[k] = 1+(cntRef[k] ??0))
  // str += `dup ref+type: ` + Object.entries( cntRef).filter(([k,v]) => v >1).map(kv =>kv[0]).join()
  const dts = await db.das.orderBy('dt').reverse().limit(11).uniqueKeys()
  if (dts.length==0) return str
  str += ` updated ${fc.diffDays(new Date(), dts[0]).toFixed(2)} days ago`
  for(const dt of dts) {
    const tsa = (await db.das.where('dt').equals(dt).toArray()).filter(isUiTag)
    if (tsa.length===0) continue
    str += `\n`+`${tsa.length}`.padStart(4,' ')+` at `+fc.fmt_mdwhm(dt) 
    if (tsa.length===1) str += ' '+ tsa[0].type+`: `+tsa[0].txt + tsa[0].tags?.map(s=> ` #${s}`)?.join()
    // const cnt = ts.filter(t=> t.type!=='tab')
    str += ` max(tid)=${Math.max(...tsa.map(t=> t.tid ?? 0))}`
    const alltags = tsa.flatMap(t=>t.tags ??[])
    const tags = alltags.filter(t=>!t.startsWith(dev_PREFFIX))
    if (tags.length >0)
      str += ` top tags: ${JSON.stringify( Object.fromEntries( fc.topFew(3, 
        Object.entries( countBy(tags, x=>x)))))}`
    if (alltags.length === tags.length) continue
    const cntdev = countBy(alltags.filter(t=> t.startsWith(dev_PREFFIX)), x=> x.substring(4))
    str += ` `+dev_PREFFIX +JSON.stringify(cntdev)
    //.reduce((acc, s)=>
    //(acc[s] = (acc[s] || 0) +1, acc), {})
    // if (str.length>33) return false  // to stop dexie cursor
  }
  if(0) // 5s too slow
    fc.nowWarn(performance.now(), ( // (op1, str) eval to str, ignoring op1
  await db.das.orderBy('[ref+type]').eachUniqueKey(async key => {
    const collection = db.das.where('[ref+type]').equals(key);
    const count = await collection.count(); // Fast index-only scan
    if (count > 1) {
      const items = await collection.toArray(); // Only run if duplicates exist
      const dts = items.map(i => i.dt.getTime());
      str+=`\nDup ${count} [${new Date(Math.min(...dts))} ~ ${new Date(Math.max(...dts))}] `
      + JSON.stringify(key);
    }
  }) , 'dup cnt'))

  return str
}
export async function statStr() {
  const byModel = new Map<string, number>();
  await db.embs.each((v) => { byModel.set(v.mdl, (byModel.get(v.mdl) ?? 0) + 1); });
  const embs = byModel.size === 0
    ? '0 embeddings'
    : `${await db.embs.count()} embeddings (${[...byModel.entries()]
      .map(([mdl, n]) => `${mdl}:${n}`).join(', ')})`;
  return (`local saved: ${await db.das.count()} tags ${await stat_tags()}
  ...\n${await db.stat.count()} stats max(tid)=${
    (await db.stat.reverse().last())?.tid},  ${embs}`)
}

export function sanitize(arr: any[]): any[] {
  const visited = new WeakSet();
  const walk = (node: any): any => {
    if (node === null || typeof node !== 'object') return node;
    
    // If we hit a cycle, break it HARD with a non-object value or shallow copy
    if (visited.has(node)) {
      return `[Circular Reference: ${node.ref || 'unknown'}]`; 
    }
    
    visited.add(node);
    
    if (Array.isArray(node)) return node.map(walk);
    
    const clone: any = {};
    for (const key in node) {
      clone[key] = walk(node[key]);
    }
    return clone;
  };
  
  // Reset visited set per top-level element to allow the same object 
  // to appear in different tags, but not inside itself.
  return arr.map(item => {
    const localVisited = new WeakSet();
    const walkLocal = (node: any): any => {
      if (node === null || typeof node !== 'object') return node;
      if (localVisited.has(node)) return `[Circular]`;
      localVisited.add(node);
      if (Array.isArray(node)) return node.map(walkLocal);
      const c: any = {};
      for (const k in node) c[k] = walkLocal(node[k]);
      return c;
    };
    return walkLocal(item);
  });
}
const arr2lines=(tags: string[] | undefined): string => (tags ?? []).join('\n')
function lines2arr(s: string): string[] | undefined {
  const arr = s.split('\n').filter(Boolean);
  return arr.length ? arr : undefined;
}

/** A row as kept in a `rec.ver`/`rec.cr` entry: everything but `rec`, so history cannot nest. */
export type DaVer = Omit<Da, 'rec'>
/** One row's history: `rec.ver` keyed by server `dt`, `rec.cr` keyed by local `modAt`. */
export type VerHist = Record<string, DaVer>

/** ISO stamp naming one `ver` entry: a server `dt`.
 * Undefined when the row carries no such stamp, i.e. the entry cannot be named. */
export function stamp(d?: Date|string|null): string|undefined {
  return d ? new Date(d).toISOString() : undefined
}
/** The ISO tail of a history key: the part `stampTime` reads off a `cr` key. */
const ISO_TAIL = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
/** Key of one `cr` entry: the discarding client's `devAgent` plus the local `modAt` ISO stamp,
 *  so a log that merged across clients names the client each discarded edit came from.
 *  @param modAt the discarded edit's local stamp
 *  @returns the key, or undefined when the edit carries no stamp */
export function crStamp(modAt?: Date|string|null): string|undefined {
  const iso = stamp(modAt)
  return iso ? `${treeCac['devAgent']}_${iso}` : undefined
}
/** The time a history key names.
 * @param key a `ver` key, or a `cr` key carrying its ISO stamp after the `devAgent` prefix
 * @returns the epoch milliseconds that key names */
export function stampTime(key: string): number {
  return Date.parse(ISO_TAIL.exec(key)?.[0] ?? key)
}
/** Snapshot of `row` for a history entry, minus `rec`. */
export function verSnap<R extends { rec?: unknown }>(row: R): Omit<R, 'rec'> {
  const { rec:_, ...snap } = row
  return snap
}
/** Add the server version `dt` to `rec.ver`. No-op when the row carries no `dt`:
 *  nothing the server has named, so nothing to key a version by. */
export function putVer<R extends { rec?: unknown }>(rec: Record<string,unknown>|undefined
  , dt: Date|string|null|undefined, row: R) {
  const key = stamp(dt)
  if (!key) return rec ?? {}
  return { ...rec, ver: { ...(rec?.ver as VerHist|undefined), [key]: verSnap(row) }
    } as Record<string,unknown>
}
/** File the discarded local edit `modAt` under `rec.cr`, so the merge that dropped it can
 *  still offer its wording for a diff/apply. Same no-op rule as `putVer`. */
export function putCr<R extends { rec?: unknown }>(rec: Record<string,unknown>|undefined
  , modAt: Date|string|null|undefined, row: R) {
  const key = crStamp(modAt)
  if (!key) return rec ?? {}
  return { ...rec, cr: { ...(rec?.cr as VerHist|undefined), [key]: verSnap(row) }
    } as Record<string,unknown>
}
/** Union two histories, local entries winning. */
export function mergeVer(local?: unknown, srv?: unknown): VerHist {
  return { ...(srv as VerHist|undefined), ...(local as VerHist|undefined) }
}
/** The stored copy of exactly server version `dt`, or undefined when this client never held it. */
export function pickVer(rec: Record<string,unknown>|undefined, dt?: Date|string|null): DaVer|undefined {
  const key = stamp(dt)
  return key ? (rec?.ver as VerHist|undefined)?.[key] : undefined
}
/** Add or drop the discarded-edit marker on the row's `tags`, so the tag UI can list the rows
 *  that lost a local edit.
 *  @param row row to mark
 *  @param on whether the row carries a `rec.cr` log
 *  @returns the marked row, or the same row when the tag is already correct */
export function withChgTag<R extends { tags?: string[] }>(row: R, on: boolean): R {
  const tags = row.tags ?? []
  if (tags.includes(CHG_REJ_TAG) === on) return row
  return { ...row, tags: on ? [...tags, CHG_REJ_TAG] : tags.filter(t => t !== CHG_REJ_TAG) }
}

/** Carry a discarded-edit log onto the row that replaces a local one, so a `cr` entry survives
 *  a snap merge or a PK relocation. The marker tag follows the log.
 *  @param srv the row that replaces the local one
 *  @param local the local row being replaced, when there is one
 *  @returns the server row carrying the union of both logs */
export function withCr<R extends { rec?: Record<string, unknown>; tags?: string[] }>(
  srv: R, local?: R): R {
  const cr = { ...((srv.rec?.cr ?? {}) as VerHist), ...((local?.rec?.cr ?? {}) as VerHist) }
  const on = Object.keys(cr).length > 0
  const row = withChgTag(srv, on)
  return on ? { ...row, rec: { ...(row.rec ?? {}), cr } } : row
}

/** Drop one `cr` entry and, with the last one, the marker tag. The caller writes the returned
 *  update spec, so an apply retires the version and the tag in one write.
 *  @param row the row the entry came from
 *  @param key the `cr` key to drop
 *  @returns the Dexie update spec for the row */
export function dropCrEntry(row: Da, key: string) {
  const { [key]: _consume, ...rest } = (row.rec?.cr ?? {}) as VerHist
  const remaining = Object.keys(rest).length
  const { cr: _drop, ...rec } = row.rec ?? {}
  const tags = remaining > 0 ? row.tags : withChgTag(row, false).tags
  const next = remaining > 0 ? { ...rec, cr: rest } : rec
  return tags === row.tags ? { rec: next } : { rec: next, tags }
}

/** Trash one `ver`/`cr` history entry from the row.
 *  A `cr` discard marks the row dirty so the reduced log is pushed: the log travels in the
 *  RPC payload, so a clean row would take the entry back from the server copy on the next
 *  merge. A `ver` entry is local bookkeeping and needs no push.
 *  @param row the row the entry belongs to
 *  @param source which history the key names
 *  @param key the entry to drop
 *  @returns the Dexie update spec for the row */
export function dropHistEntry(row: Da, source: 'ver' | 'cr', key: string) {
  if (source === 'cr') return { ...dropCrEntry(row, key), modAt: new Date() }
  const { [key]: _drop, ...rest } = (row.rec?.ver ?? {}) as VerHist
  const { ver: _ver, ...rec } = row.rec ?? {}
  return { rec: Object.keys(rest).length > 0 ? { ...rec, ver: rest } : rec }
}

/** One row as the CDN snapshot stores it: the client-held `ver` history is dropped, so the
 *  snapshot carries row state rather than the history the RPC already delivers.
 *  @param row row to strip
 *  @returns the row without `rec.ver` */
export function withoutVer<R extends { rec?: Record<string, unknown> }>(row: R): R {
  if (!row.rec?.ver) return row
  const { ver:_, ...rec } = row.rec
  return { ...row, rec } as R
}

/** 3-way text/tags merge: apply the local diff `ancestor`→`mod` onto the server copy `base`.
 *  A hunk the patch cannot place keeps the server text for that region and is counted in
 *  `rec.patchFail`, so a partially applied merge is visible instead of looking clean. */
export function patchMod(base: Da, ancestor: DaVer|undefined, mod: Da): Da {
  if (!ancestor) return base
  const dmp = new diffmp.diff_match_patch()
  const [txt, txtFlags] = dmp.patch_apply(dmp.patch_make(ancestor.txt, mod.txt), base.txt)
  const [tags] = dmp.patch_apply(dmp.patch_make(
    arr2lines(ancestor.tags), arr2lines(mod.tags)), arr2lines(base.tags))
  const failed = txtFlags.filter(ok => !ok).length
  return { ...base, // Create the new object and new array here
    txt,
    tags: tags.split('\n'),
    rec: failed > 0
      ? { ...base.rec, patchFail: { at: new Date().toISOString(), hunks: failed } }
      : base.rec,
  }
}
/** Conflicts `deepMerge` discarded since the last drain; the greet round announces them so the
 *  editor can offer the diff tab. Kept here because a merge is where the edit is dropped. */
const crAdded: { ref: string; stamp: string; reason: string }[] = []
/** Take the conflicts added since the last call.
 * @returns one entry per discarded local edit, in merge order, each naming why the patch
 *  gate had no ancestor (`no-base-dt`, `server-no-dt`, `server-ahead`, `server-behind`),
 *  or `patch-unplaced` for a buffer write the editor could not merge (`fileDiscardedCr`) */
export function drainCr(): { ref: string; stamp: string; reason: string }[] {
  return crAdded.splice(0)
}

/** Why the patch gate had no ancestor for the server row: the local edit named no base
 *  version, the server row carries none, or the server moved ahead of / behind that base. */
function missReason(rl: Da, rin: Da): string {
  if (!rl.dt) return 'no-base-dt'
  if (!rin.dt) return 'server-no-dt'
  return new Date(rin.dt).getTime() > new Date(rl.dt).getTime() ? 'server-ahead' : 'server-behind'
}

/**
 * Merge a locally-modified row (rl) with the server row (rin).
 * Ver gate: `rl.rec.ver` holding an exact copy of server version `rin.dt` is the only
 * trusted ancestor — patch that copy against rl and apply the diff onto rin, then
 * re-push (dirty). Without it the server copy wins outright (`modAt` null, not pushed):
 * its version is adopted into `rec.ver`, and the discarded local edit is filed under
 * `rec.cr` for the diff/apply tab.
 * tid avoid: keep local tid only for fixed special tid <0 (e.g. -1 tabstat-cnt), else
 * follow the server tid so uniq+tid pairs converge instead of clients dead-looping.
 */
export function deepMerge(rl: Da, rin: Da): Da {
  const { ver: rlVer, cr: rlCr, ...rlRec } = (rl.rec ?? {}) as Record<string, unknown>
  const { ver: rinVer, cr: rinCr, ...rinRec } = (rin.rec ?? {}) as Record<string, unknown>
  // ver and cr merged by hand: recMerge lets the server side win same-stamp entries, and a
  // cr key names the client that discarded the edit, so a union keeps every client's log
  const cr = { ...(rinCr as VerHist|undefined), ...(rlCr as VerHist|undefined) }
  const tagged = Object.keys(cr).length > 0
  const rec = { ...fc.recMerge(rlRec, rinRec, 5), ver: mergeVer(rlVer, rinVer)
    , ...(tagged ? { cr } : {}) }
  const base = pickVer(rl.rec, rin.dt)
  if (base) return withChgTag(patchMod({ ...rin, rec, modAt: new Date() }, base, rl), tagged)
  const key = crStamp(rl.modAt)
  if (key) crAdded.push({ ref: rl.ref, stamp: key, reason: missReason(rl, rin) })
  const kept = putCr(rec, rl.modAt, rl)
  const out = { ...rin, rec: putVer(kept, rin.dt, rin), modAt: undefined
    , tid: rl.tid === -1 ? rl.tid : rin.tid } as Da
  return withChgTag(out, tagged || Boolean(key))
}

/** Keep the server copy and file the local edit under `rec.cr`, for a writer that already
 *  knows the edit cannot be placed on it: the editor's buffer merge failed a hunk
 *  (`ui/reapply.planPersist`). Same recipe as the server-wins branch of `deepMerge`: the
 *  version is adopted into `rec.ver`, so applying the entry back from the diff tab pushes
 *  over the base the row now carries, and the row is left clean and tagged.
 *  @param row the server copy to keep
 *  @param local the local edit to file; its `modAt` names the `cr` key
 *  @returns the row to write */
export function fileDiscardedCr(row: Da, local: Da): Da {
  const key = crStamp(local.modAt)
  if (key) crAdded.push({ ref: local.ref, stamp: key, reason: 'patch-unplaced' })
  const rec = putVer(putCr({ ...(row.rec ?? {}) }, local.modAt, local), row.dt, row)
  return withChgTag({ ...row, rec, modAt: undefined }, true)
}
/** bulk resolving clash of uniq ref+type and PK */
export async function bulkMerge(clash: Da[]) {
  const toPut:Da[] = []
  const tid2row = Object.fromEntries(clash.map(row=> [row.tid, row]))
  const tidSet = new Set(clash.map(row=> row.tid))
  await db.das.filter(row=> tidSet.has(row.tid)).modify((live_row) => {
    let in_row = tid2row[live_row.tid!]
    if (daUniq(live_row)=== daUniq(in_row))
      in_row = deepMerge(in_row, live_row)
    else toPut.push( {...daNoPk(Dexie.deepClone(live_row)), modAt:new Date()})
    Object.assign(live_row, in_row)
    live_row.modAt = new Date()
    delete tid2row[live_row.tid!]
  })
}