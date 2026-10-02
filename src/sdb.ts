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
export const uniqsTag = (t: Da) => t.type+t.ref
export const nopkTag = ({tid:_, ...rest}:any) => rest 
export const tags2str=(t:Da) => JSON.stringify([t.ref, t.txt, t.type, t.tags ?? []])
export const tid_last = async ()=>await db.das.orderBy(':id').last()
export async function clean() {
  const now = new Date()
  const null_dt = await db.das.filter(t=> t.dt===undefined).toArray()
  let updates = null_dt.map(t=> ({key:t.tid, changes:{dt: now}}))
  if (updates.length >0) return await db.das.bulkUpdate(updates)
  
  return 0
}
export async function binPut(key:string, bin: any) {
  db.bins.put({ key, rec: { date: new Date().toLocaleString('zh-cn',{hour12:false}) }
      , bin: fc.encZip(bin) });
}
export class DDB extends Dexie {
  tree!: Dexie.Table<{ key: string, value: unknown }>;
  das!: Dexie.Table<Da>;
  vecs!: Dexie.Table<{ tid: number, mdl: string, vec: Float32Array }>;
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
  'tabSeer': 'cardtab',
  'cardSeer': 'cs1',
  // , "emb_model-HF":HF_OR[0]
}
export let treeCacOpts: Record<string, string[]> = {
  'tabSeer': ['cardtab', 'card'],
  'cardSeer': ['cs1', 'cs2'],
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
  let col = filters.length > 0
    ? db.das.where('tags').equals(filters[0])
    : db.das.toCollection();

  col = col.filter(isUiTag);
  const extra = filters.slice(1);
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

/** Rows the tag UI owns. recr keeps its session, settings, and tool rows in the same table. */
export const isUiTag = (r: Da) => r.type !== RECR_TYPE

/** The `secret.md` document carrying the agent's provider, model, and key selection.
 *  A tombstoned row counts as absent, matching how `IRecrStore` resolves the same key. */
export async function getSecret(): Promise<string | undefined> {
  const row = await getLatestByRefType(SECRET_REF, 'md')
  return row && !row.tags?.includes(DEL_TAG) ? row.txt : undefined
}

/** Get the latest (max dt) row for ref+type, or ref alone if type is empty/omitted.
 *  Returns null if deleted ([del] tag on max-dt row). */
export async function getLatestByRefType(ref: string, type?: string): Promise<Da | null> {
  const rows = type
    ? await db.das.where('[ref+type]').equals([ref, type]).toArray()
    : await db.das.filter(t => t.ref === ref && !t.tags?.includes(DEL_TAG)).toArray()
  if (rows.length === 0) return null
  // max dt wins
  const latest = rows.reduce((a, b) => (new Date(a.dt ?? 0).getTime()) > (new Date(b.dt ?? 0).getTime()) ? a : b)
  // if (latest.tags?.includes(DEL_TAG)) return null
  // console.debug(`getLatestby..`, latest)
  return latest
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
  return (`local saved: ${await db.das.count()} tags ${await stat_tags()}
  ...\n${await db.stat.count()} stats max(tid)=${
    (await db.stat.reverse().last())?.tid},  ${await db.vecs.count()} vecs max(tid=${
      (await db.vecs.reverse().last())?.tid})`)
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

/** A row as kept in `rec.ver`: everything but `rec`, so history cannot nest itself. */
export type DaVer = Omit<Da, 'rec'>
/** One row's version history; key = the ISO stamp `verKey` derives for that version. */
export type VerHist = Record<string, DaVer>
/** Shelf life of a `rec.ver` entry before the next shelf drops it. */
export const VER_KEEP_MS = 30 * 24 * 3600 * 1000

/** ISO stamp naming a row version: the later of its server `dt` and its local `modAt`.
 * Undefined when the row carries neither, i.e. the version cannot be named. */
export function verKey(dt?: Date|string|null, modAt?: Date|string|null): string|undefined {
  const ms = (v?: Date|string|null) => (v ? new Date(v).getTime() : -Infinity)
  const t = Math.max(ms(dt), ms(modAt))
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}
/** Snapshot of `row` for `rec.ver`, minus `rec`. */
export function verSnap<R extends { rec?: unknown }>(row: R): Omit<R, 'rec'> {
  const { rec:_, ...snap } = row
  return snap
}
/** Add one version to `rec.ver` under `key`, dropping entries older than `VER_KEEP_MS`.
 * No-op without a key (unnamed version). */
export function shelfVer(rec: Record<string,unknown>|undefined, key: string|undefined, snap: unknown) {
  if (!key) return rec ?? {}
  return { ...rec, ver: { ...pruneVer(rec?.ver), [key]: snap } } as Record<string,unknown>
}
/** Union two version histories, local entries winning; entries older than `VER_KEEP_MS` dropped. */
export function mergeVer(local?: unknown, srv?: unknown): VerHist {
  return { ...pruneVer(srv), ...pruneVer(local) }
}
/** The stored copy of exactly server version `dt`, or undefined when this client never held it. */
export function pickVer(rec: Record<string,unknown>|undefined, dt?: Date|string|null): DaVer|undefined {
  const key = dt ? verKey(dt, null) : undefined
  return key ? (rec?.ver as VerHist|undefined)?.[key] : undefined
}
function pruneVer(ver: unknown): VerHist {
  const cutoff = Date.now() - VER_KEEP_MS
  const kept: VerHist = {}
  for (const [k, v] of Object.entries((ver ?? {}) as VerHist))
    if (Date.parse(k) >= cutoff) kept[k] = v
  return kept
}

/** 3-way text/tags merge: apply the local diff `b4mod`→`mod` onto the server copy `base`. */
export function patchMod(base: Da, b4mod: DaVer|undefined, mod: Da): Da {
  if (!b4mod) return base
  const dmp = new diffmp.diff_match_patch()
  return { ...base, // Create the new object and new array here
    txt: dmp.patch_apply(dmp.patch_make(b4mod.txt, mod.txt), base.txt)[0],
    tags: dmp.patch_apply(dmp.patch_make(
      arr2lines(b4mod.tags), arr2lines(mod.tags)), arr2lines(base.tags))[0].split('\n')
  }
}
/**
 * Merge a locally-modified row (rl) with the server row (rin).
 * Ver gate: `rl.rec.ver` holding an exact copy of server version `rin.dt` is the only
 * trusted ancestor — patch that copy against rl and apply the diff onto rin, then
 * re-push (dirty). Without it the server copy wins outright (`modAt` null, not pushed),
 * and rl's own version plus the adopted version are shelved into `rec.ver`.
 * tid avoid: keep local tid only for fixed special tid <0 (e.g. -1 tabstat-cnt), else
 * follow the server tid so uniq+tid pairs converge instead of clients dead-looping.
 */
export function deepMerge(rl: Da, rin: Da): Da {
  const { ver: rlVer, ...rlRec } = (rl.rec ?? {}) as Record<string, unknown>
  const { ver: rinVer, ...rinRec } = (rin.rec ?? {}) as Record<string, unknown>
  // ver merged by hand: recMerge concatenates arrays, which would duplicate tags per version
  const rec = { ...fc.recMerge(rlRec, rinRec, 5), ver: mergeVer(rlVer, rinVer) }
  const base = pickVer(rl.rec, rin.dt)
  if (base) return patchMod({ ...rin, rec, modAt: new Date() }, base, rl)
  let kept = shelfVer(rec, verKey(rl.dt, rl.modAt), verSnap(rl))
  kept = shelfVer(kept, verKey(rin.dt, null), verSnap(rin))
  return { ...rin, rec: kept, modAt: undefined
    , tid: rl.tid === -1 ? rl.tid : rin.tid }
}
/** bulk resolving clash of uniq ref+type and PK */
export async function bulkMerge(clash: Da[]) {
  const toPut:Da[] = []
  const tid2row = Object.fromEntries(clash.map(row=> [row.tid, row]))
  const tidSet = new Set(clash.map(row=> row.tid))
  await db.das.filter(row=> tidSet.has(row.tid)).modify((live_row) => {
    let in_row = tid2row[live_row.tid!]
    if (uniqsTag(live_row)=== uniqsTag(in_row))
      in_row = deepMerge(in_row, live_row)
    else toPut.push( {...nopkTag(Dexie.deepClone(live_row)), modAt:new Date()})
    Object.assign(live_row, in_row)
    live_row.modAt = new Date()
    delete tid2row[live_row.tid!]
  })
}