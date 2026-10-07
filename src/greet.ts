import * as sdb from './sdb'
import * as fc from './fc';
import { stts } from './fc';
import Dexie, { Table, type UpdateSpec } from 'dexie';
import * as sb from '@supabase/supabase-js';
let extChrom = typeof chrome !== 'undefined' &&
  typeof chrome.storage?.local?.get === 'function';
const isVitest = typeof process !== 'undefined' && Boolean(process.env.VITEST)
  || typeof globalThis !== 'undefined' && '__vitest__' in globalThis;
const storage = extChrom? chrome.storage.sync || chrome.storage.local : null;

function parseSessionFromHash() {
  const hash = window.location.hash;
  if (!hash) return null;

  // Handle double hash for hash-routed apps: #/route#access_token=...
  const parts = hash.split('#');
  const sessionFragment = parts.length > 2 ? parts[parts.length - 1] : parts[1];
  
  if (!sessionFragment) return null;

  const params = new URLSearchParams(sessionFragment);
  const access_token = params.get('access_token');
  const refresh_token = params.get('refresh_token');

  if (access_token && refresh_token) {
    return { access_token, refresh_token };
  }
  return null;
}

const tokenStorageAdapter = { getItem: async (key: string) => {
    const result = await storage.get(key);
    return result[key] || null;
  },
  setItem: async (key: string, value: string) => await storage?.set({ [key]: value }),
  removeItem: async (key: string) => await storage?.remove(key),
};
const sb_options = { db:{schema:'tt'}, auth: {
    autoRefreshToken:   !extChrom && !isVitest, // disable auto refresh in tests and Chrome extension flow
    detectSessionInUrl: !extChrom, // Prevent chromium-extension:// URL issues
    persistSession: true,
    storage: extChrom? tokenStorageAdapter : undefined,
    debug:false,
}}
// console.debug(sb_options)
export const updSessionAsync = async (env:any=undefined)=> { //   // expect {access_token, refresh_token} 
  // await sdb.treeCacReady
  console.log(`sbg.createClient at `,sdb.treeCac['server'])
  
  // 1. Try manual hash parsing for double-hash URLs
  const hashSession = parseSessionFromHash();
  if (hashSession) {
    const { data } = await sbg.auth.setSession(hashSession);
    // Clean URL to remove tokens
    const routeHash = window.location.hash.split('#').slice(0, -1).join('#');
    window.history.replaceState(null, '', routeHash || '#/');
    console.log('Session recovered from double-hash URL');
  }

  const res = env? await sbg.auth.setSession(env) : await sbg.auth.getSession()
  console.log(`upd sess`, res)
  return (sess = res.data.session)
}
  console.log(`sbg.createClient at `,sdb.treeCac['server'])
export let sbg = sb.createClient(sdb.treeCac['server'] as string, sdb.treeCac['pub_key'] as string, sb_options);
export let sess: sb.Session | null = null;
export const sessReady = updSessionAsync();
export async function signinGoogle() {
  const nextPath = window.location
  const { data, error } = await sbg.auth.signInWithOAuth({
    provider: 'google', options: extChrom? {
      skipBrowserRedirect: true, // Returns the URL instead of redirecting
      redirectTo: chrome.identity.getRedirectURL(),
      // scopes: 'https://www.googleapis.com/auth/userinfo.email https://googleapis.com',
    }:{redirectTo: nextPath.href} });
  if (error) return ['', fc.sideLog('err signin Google: ',error).message]
  if (extChrom) {
    const callbackUrl = await chrome.identity.launchWebAuthFlow({ 
      url: data.url, interactive: true }) //, async (callbackUrl) => {
    if (callbackUrl) {
      const params = new URLSearchParams(new URL(callbackUrl).hash.substring(1));
      const access_token = params.get('access_token');
      const refresh_token = params.get('refresh_token');
      if (!access_token || !refresh_token) 
        return ['',fc.sideLog('err token missing', params)]
      const {data, error} = await sbg.auth.setSession({access_token, refresh_token});
      sess = data.session
    }
    window.history.replaceState(null, '', nextPath.href)
  } else {
    const {data, error} = await sbg.auth.getSession()
    sess = data.session
  }
  return [sess?.user?.email ?? '', null]
}

/** Pure 3-way merge (for bulkput) — from CDN, no DB calls.
 * https://claude.ai/chat/a1ce3976-1f66-4a9b-b660-2f6c79aeeb67
 * claude更结构化专业 https://gemini.google.com/app/48692f18563ea18f
 *
 * stale     full local snapshot (replaces the .where(':id').anyOf() query)
 * modrw     locally-modified rows to preserve / deep-merge with server
 * dl        incoming server array
 *
 * Returns the rows that should be passed to table.bulkPut().
 *
 * Mirrors merge() + diffTags() logic:
 *   identical to stale  → skip   (no-op, like diffTags tsSet filter)
 *   newDL (no PK clash) → put as-is, or deepMerge if modrw matches by content
 *   clash  (PK exists)  → row2put: deepMerge + relocate displaced local row
 */
export function bulk2put<R extends { rec?: Record<string, unknown>; tags?: string[] }>(
  stale    : R[],
  modrw    : R[],
  dl       : R[],
  pk       : (r: R) => unknown,       // primary-key extractor  (this.pk)
  uniq     : (r: R) => string,        // unique-key extractor
  toStr    : (r: R) => string,        // content identity
  deepMerge: (local: R, srv: R) => R, // this.deepMerge
  nopk     : (r: R) => Partial<R>,    // strip pk for relocation (this.nopk)
) {
  let st = performance.now()
  // ── index stale ──────────────────────────────────────────────────────────
  const staleByPk  = new Map(stale.map(r => [pk(r),    r]))   // clash lookup
  const staleStrs  = new Set(stale.map(toStr))                 // identity set
  const stalePks   = new Set(stale.map(pk))
  const staleByUniq = new Map(stale.map(r => [uniq(r), r]))    // cr lookup, no PK clash
  // ── index local edits by UNIQUE KEY, not content ─────────────────────────
  // content diverges (e.g. dt=now after pullPush).  uniq is the stable
  // semantic identity that survives any content change on either side.
  const modrwByUniq = new Map(modrw.map(r => [uniq(r), r]))
  // ── diffTags-style split ──────────────────────────────────────────────────
  const changed = dl.filter(r => !staleStrs.has(toStr(r)))    // drop identicals
  st = fc.nowWarn(st, `bulk2put`, `dl filter same`,33)
  const toMerge = changed.filter(r => !stalePks.has(pk(r)))   // safe: no PK clash
  const pkClash = changed.filter(r =>  stalePks.has(pk(r)))   // PK occupied locally
  console.info(`stale(${stale.length}) mod(${modrw.length}) dl(${dl.length})`
    +`pkClash(${pkClash.length}) /${changed.length} changed`)
  const newPK: R[] = []
  const upsPK: R[] = []
  const noPK:  R[] = []
  // ── no PK clash: straight put, or deep-merge if uniq matches a local edit ─
  for (const srv of toMerge) {
    const mod = modrwByUniq.get(uniq(srv))   // FIX: was toStr(srv)
    newPK.push(
      mod
        ? deepMerge(mod, srv)                 // preserve local edit, take server pk
        : sdb.withCr({ ...srv, modAt: null } as R, staleByUniq.get(uniq(srv)))
    )
  }
  // ── clash: row2put + relocate displaced local row ─────────────────────
  for (const srv of pkClash) {
    const mod        = modrwByUniq.get(uniq(srv))        // FIX: was toStr(srv)
    const local2move = staleByPk.get(pk(srv))!
    upsPK.push(
      mod
        ? deepMerge(mod, srv)
        : sdb.withCr({ ...srv, modAt: null } as R, local2move)
    )
    // 2. relocate displaced local row unless it IS the modrw2merge we just kept
    // FIX: compare by pk() — unambiguous; old toStr() guard could false-match
    // a different row with the same content, or miss after a content change.
    if (!mod && (local2move as any).modAt) {
      noPK.push({ ...nopk(local2move), modAt: new Date() } as unknown as R)
    } else if (mod && toStr(local2move) !== toStr(mod)) {
      noPK.push({ ...nopk(local2move), modAt: new Date() } as unknown as R)
    }
  }
  st = fc.nowWarn(st, `bulk2put for`, `${toMerge.length} toMerge and ${pkClash.length} pkClash`)
  return {newPK,upsPK,noPK}
}
/** One row-level upgrade stage; must return the same row object when it changes
 *  nothing, so the cascade can count upgraded rows by identity. */
type UpStage = (row: any) => any
/** Legacy snaps keep the tag strings in `sts`. */
const up_sts_tags: UpStage = row => row && typeof row === 'object' && 'sts' in row
  ? (({sts, ...rest}: any) => ({...rest, tags: sts}))(row)
  : row
/** Snapshot upgrade cascade, in order of the filename prefix it starts applying
 *  at. A newer level re-applies the older stages first, so `da` snaps get the
 *  `sts`->`tags` fix plus whatever `da` adds. Unmatched names (hand-made test
 *  seeds) fall back to the first level, matching the old unconditional rename. */
const UPGRADES: { prefix: string; stages: UpStage[] }[] = [
    { prefix: 'tag', stages: [up_sts_tags] }
  , { prefix: 'da',  stages: [ ] }
]
/** Apply the cascade to one downloaded snapshot.
 * @param rows decoded snap rows
 * @param snapName snapshot filename from the CDN listing
 * @returns upgraded rows and how many rows a stage actually changed
 */
function upgrade_rows(rows: any[], snapName: string) {
  const { stages } = UPGRADES.findLast(u => snapName.startsWith(u.prefix)) ?? {stages:[]}
  if (stages.length==0) return {rows, ren_cnt: 0, snapName}
  let ren_cnt = 0
  const up = rows.map(row => {
    const r2 = stages.reduce((r, stage) => stage(r), row)
    if (r2 !== row) ren_cnt++
    return r2
  })
  return { rows: up, ren_cnt, snapName:'up-'+snapName }
}

/** The name a snapshot's rows are cached and pushed under. A filename an upgrade stage applies
 *  to is prefixed (`up-`), and that prefixed name also names the server partition the RPC
 *  locks on.
 * @param raw snapshot filename from the CDN listing
 * @returns the effective name, or `''` when there is no snapshot */
export function effSnapName(raw: string) {
  return raw ? upgrade_rows([], raw).snapName : ''
}

/** The newest snapshots in this user's CDN folder.
 * @param limit how many entries to list, newest first
 * @returns the listing, or an empty list plus an error when signed out */
export async function listSnaps(limit = 22) {
  if (!sess?.user) return { data: [] as { name: string }[], error: { message: 'no user' } };
  return sbg.storage.from('bb').list(`${sess.user.id}`
    , { limit, sortBy: { column: 'created_at', order: 'desc' } });
}

/** Load a snapshot into `tab`.
 * @param tab table to fill
 * @param curSnap effective name of the snapshot already loaded, `''` when none is
 * @param testOld also merge the oldest listed snapshot, to exercise old-format snaps
 * @param onStep checkpoint callback, `(step, frac)`
 * @param pin snapshot filename to load instead of the newest, `''` to follow the newest
 * @returns the effective name now loaded and the rows to put, or why nothing loaded */
export async function dl_merge (tab: Table, curSnap='', testOld=false
  , onStep?: (step: string, frac: number) => void, pin = ''){
    let st = performance.now()
    if (!sess?.user) 
      return {error: 'dl merge no user', sess};
    const path = `${sess.user.id}`
    const list = await listSnaps()
    if (list.error) return {error: `dl merge list: ${list.error.message}`, result:list}
    if (!list.data || list.data.length==0 ) 
      return {error: 'dl merge lack cdn snap: ', result:list}
    onStep?.('list', 0.1)
    await tab.update(-1, { modAt: null }).catch(() => {});  // cleanup meta dirty bug

    const modrw = await tab.filter(row => row.modAt != null).toArray()
    let stale  = modrw.slice(0,0)
    if (testOld && list.data.length >1){
      const oldName = list.data[list.data.length - 1].name;
      const oldUp = upgrade_rows(await fc.dl(sbg.storage.from('bb'), path + `/` + oldName), oldName);
      const testOld = oldUp.rows;
      const toMerge = bulk2put([], [], testOld, (t:sdb.Da)=>t.tid
        , sdb.daUniq, sdb.tags2str,sdb.deepMerge, sdb.daNoPk )
      console.log(Object.entries(toMerge).map(([k,v])=> k+`[${v.length}] `).join())
      const chunk = 0x1000;
      for(const [_,toPut] of Object.entries(toMerge))
        while(toPut.length >0) tab.bulkPut(toPut.splice(0, chunk))
      fc.nowWarn(st, 'initial merge',undefined,33)
      stale = testOld
    } else stale = await tab.toArray()

    // A pin names its file outright, so a newly listed snapshot cannot move the working set.
    let snapName = pin || list.data[0].name
    let upSnapName = effSnapName(snapName)  // empty rows to check snapname
    if (curSnap===upSnapName) { // if no new snap
      onStep?.('snap cached', 0.5)
      return{upSnapName,toPut: { newPK: [], upsPK: [], noPK: [],}}
    }
    const lastSnapPath = path + `/` + snapName; // TODO 36k rows 4s
    onStep?.('dl snap', 0.25)
    let snapRows: any[]
    try { snapRows = await fc.dl(sbg.storage.from('bb'), lastSnapPath) }
    catch (e) {
      return {error: `dl snap ${snapName}: ${e instanceof Error ? e.message : String(e)}`}
    }
    const snapUp = upgrade_rows(snapRows, snapName);
    stts(`ren ${snapUp.ren_cnt} sts ->tags`,'greet')
    st = fc.nowWarn(st, `dl snap`, upSnapName)
    const toPut = bulk2put(stale, modrw, snapUp.rows, (t:sdb.Da)=>t.tid
      , sdb.daUniq, sdb.tags2str,sdb.deepMerge, sdb.daNoPk )
    onStep?.('snap merge', 0.5)
    if (toPut.upsPK.length>0)
      stts(`upserted ${toPut.upsPK.length}`)
    return {upSnapName, toPut}
  }
/** if non-dirty loss ie upsBase left in old snap, atomic snap TODO
 *  The snapshot carries row state only: `rec.ver` is dropped before cbor+pako, because the
 *  history is client-held and the RPC payload already delivers it.
 */
export async function upSnap() {
  let st = performance.now()
  // const { data: { user } } = await sbg.auth.getUser() 
  // if (!user) return stts("err Not logged in")
  let oName = `da.${await sdb.db.das.count()}.cbor.pako`;
  const res = await sbg.storage.from('bb').list(`${sess?.user.id}`
    , { limit: 11, sortBy: { column: 'created_at', order: 'desc' } });
  if (res.error) 
    return fc.sideLog(stts('err:'+res.error.message, 'greet'),res) 
  const matched = res.data.filter((o: { name: string; })=> o.name.startsWith('da'));
  console.log('stale check: ',matched)
  if(matched.length?? 0 >0)
    if (oName== (matched[0].name as string))
      return {status: stts(`skipped stale ${oName} count`)}
  await sanitize_md()
  const ta = (await sdb.db.das.toArray()).map(sdb.withoutVer)
  // const es = await sdb.db.vecs.toArray();
  const fileApi = sbg.storage.from('bb')
  const msg = await fc.ul(ta, fileApi, `${sess?.user.id}/da`,ta.length)
  stts((msg.startsWith('err')? '': `✔Done upload `) +msg)
}
export async function sanitize_md() {
  const tags = await sdb.db.das.where('type').equals('md').toArray();
  const processed = tags.map((item, idx) => {
    const visited = new Map<any, string>();
    const walk = (node: any, path: string = 'root'): any => {
      if (node === null || typeof node !== 'object') return node;
      // Date fields are values, not containers: cloning one would empty it
      if (node instanceof Date) return node;
      if (visited.has(node)) {
        const originPath = visited.get(node);
        if (path.endsWith('.parent')) {
          return { ...node, parent_uid: node.uid }; // simplified circular fix
        }
        return `[Circular: ${originPath}]`;
      }
      visited.set(node, path);
      if (Array.isArray(node)) return node.map((val, i) => walk(val, `${path}[${i}]`));
      const clone: any = {};
      for (const key in node) {
        if (key === 'parent' && visited.has(node[key])) {
          clone.parent_uid = node[key].uid;
        } else {
          clone[key] = walk(node[key], `${path}.${key}`);
        }
      }
      return clone;
    };
    return walk(item, `Da[${idx}]`);
  });
  await sdb.db.das.bulkPut(processed);
}

async function backoff(loopCount:number) {
  const BASE_DELAY = 50; 
  const MAX_DELAY = 1000;
  const delay = Math.min(MAX_DELAY, BASE_DELAY * Math.pow(2, loopCount));
  const jitter = delay * 0.25 * Math.random();
  await new Promise(r => setTimeout(r, delay + jitter));
}
/** UTF-8 byte count of JSON.stringify — matches PostgREST JSONB body size */
const jsonB = (x: unknown) => new TextEncoder().encode(JSON.stringify(x ?? {})).length
/** rpc greeter rows live, with deepMerge on uniqstr, pk avoidance
 */
export class Greeter<R extends { modAt?: Date; dt?: Date; tags?: string[]
    ; rec?: Record<string, unknown> },PK=unknown> {
  constructor(private table: Dexie.Table<R>
    , protected sessReady:Promise<sb.Session|null>, protected sbg:sb.SupabaseClient
    , public snap:string
    , private deepMerge: (local:R, server:R) => any
    , private uniqstr: (row:R) => string  // uniq string for unique key(s)
    , private pk: (row:R)=> PK
    , private nopk: (row:R)=> Partial<R> // remove pk for auto-gen
    , public meta = (stat:any): R => (stat as any)
  ) {}
  /** Reports a failed round to the caller's activity store; `pullPush` keeps its own retry policy. */
  onError?: (message: string) => void
  /** Reports a checkpoint to the caller's progress store, as `(step, frac)`. */
  onStep?: (step: string, frac: number) => void
  async pullPush() {
    const acc = {rpc:0, ok:0, merge:0,}
    const MAX_RETRIES = 1, MIN_LOOP=3;
    let loopCount = 0;// trigger tid=-1 dl merge
    while (1) {
      let modrw = await this.modrwCheck();
      console.log({ [this.table.db.name + '-'.repeat(33)]: { loopCount: loopCount
        , greeter_pullPush_mod_rows: modrw.length > 5 ? modrw.length : modrw } });
      const last_dt = await this.table.orderBy('dt').last();
      const sess = await this.sessReady;

      const payload = modrw.map(r => ({
        uniqs: this.uniqstr(r), dt: r.dt, stuff: r, user_id: sess?.user.id
      }))
      // if (loopCount==0 && modrw.length > 0) {
      //   ;
      // }
      let st = performance.now()
      this.onStep?.(`rpc r${loopCount + 1}`, 0.55 + Math.min(0.25, loopCount * 0.08))
      const { data: res, error } = await this.sbg.rpc('ups_same_base', {
        snap_name: this.snap, payload, last_dt: last_dt?.dt });
      acc.rpc+= performance.now() -st
      console.log( {ok_uniqs: res?.ok_uniqs, dl_len: res?.dl?.length, status: res?.status, server_now: res?.server_now})
      if (error || !res) {
        // A failed round must not consume the retry budget of the merge loop, and must not spin:
        // retry once after a backoff, then leave the dirty rows for the next greet.
        console.error('Error greeting server:', error)
        stts(`err greeting server ${error?.code ?? ''}: ${error?.message ?? 'no result'}`,'greet')
        this.onError?.(`greet rpc: ${error?.message ?? 'no result'}`)
        if (++loopCount > MIN_LOOP+MAX_RETRIES) break
        await backoff(loopCount)
        continue
      }

      await this.table.db.transaction('rw', this.table, async () => {
        const okUniqs = new Set(res.ok_uniqs);
        const okRows = modrw.filter(r => okUniqs.has(this.uniqstr(r)));
        if (okRows.length) {
          st = performance.now()
          // UpdateSpec<R> cannot resolve KeyPaths against the generic row type, hence the cast
          const okChanges: { key: PK, changes: UpdateSpec<R> }[] = okRows.map(r => ({
            key: this.pk(r),
            changes: { modAt: undefined, dt: res.server_now
              // keep the accepted version, so a later re-delivery of it can still be patched
              , rec: sdb.putVer(r.rec, res.server_now, { ...r, dt: res.server_now }) } as UpdateSpec<R>
          }))
          await this.table.bulkUpdate(okChanges)
          acc.ok += performance.now() -st
          this.onStep?.('accepted', 0.85)
          stts(stts(`${okRows.length} pulled`,'greet'),'-tabs')
        }
        const dlStuff = (res.dl || []).map(d => ({...d.stuff, dt:d.dt}));
        st = performance.now()
        if (res.dl.length >0) await this.merge(dlStuff, modrw)
          .then(s=> stts(stts(s, 'greet'),'-tabs') )
        else await this.table.filter(row => row.modAt != null)
            .modify({dt:undefined})   // last_dt null to trigger server ins (dt already voided if modAt)
        this.onStep?.('round done', 0.9)
        acc.merge += performance.now() -st

      })  // TODO FIXME init dl /w 1st empty payload
      if (res.dl.length==0 && res.ok_uniqs.length==0)
        if (modrw.length==0) break
        else {
          stts(`err greet stalled: ${modrw.length} row(s)`, 'greet')
          this.onError?.(`greet stalled: ${modrw.length} row(s)`)
          console.log('error greet stalled:', modrw.map(r => this.pk(r)+':'+this.uniqstr(r)))
          break
        }
      if (++ loopCount > MIN_LOOP+MAX_RETRIES) break;
      if (loopCount <MIN_LOOP) continue
      stts(`${loopCount} retrying... modrw:${modrw.length}, oks:${res.ok_uniqs.length}, dl:${res.dl.length}`,'-tabs')
      await backoff(loopCount)
    }
    console.debug(acc)
    return this.toBackup
  }
  public toBackup:any[] = []
  row2put(serverRow:R, modrw2merge:R|undefined, local2move:R|undefined, toPut:R[]) {
    const now = fc.fmt_mdwhm(new Date())
    const bak = (key, stuff)=> {
      if(stuff) this.toBackup.push({tid:-11, key:`mod4merge:`+this.uniqstr(stuff)+` `+key+` `+now, stuff})
      return stuff
    }
    bak(`modrw`, modrw2merge)
    // bak(`local`, local2move)
    
    if (modrw2merge) // merge as dirty to push, /w local pk
      toPut.push(  this.deepMerge(modrw2merge, serverRow) )
    else toPut.push(sdb.withCr(serverRow, local2move))
    if (local2move && (!modrw2merge || 
      this.uniqstr(local2move) !== this.uniqstr(modrw2merge)) &&
      this.uniqstr(local2move) !== this.uniqstr(serverRow)) {
      if (local2move.modAt) {
        toPut.push({ ...this.nopk(local2move), modAt: new Date() } as unknown as R);
      }
    }
    return 
  }
  /**
   * Merges server updates into the local table, incl local modAt ok by server
   * Handles PK clashes by moving displaced local records to new auto-generated IDs.
   */
  public async merge(dlStuff: R[], modrw: R[]) {
    const localClash = await this.table
      .where(':id')
      .anyOf(dlStuff.map((s) => this.pk(s)))
      .toArray()
    const localByDlPk = new Map(localClash.map((r) => [this.pk(r), r]));
    const modrwByUniq = new Map(modrw.map((r) => [this.uniqstr(r), r]));
    const toPut: R[] = [];
    for (const serverStuff of dlStuff)
      this.row2put(
        { ...serverStuff, modAt: null },
        modrwByUniq.get(this.uniqstr(serverStuff)),
        localByDlPk.get(this.pk(serverStuff)),
        toPut
      )
    console.log({ name: this.table.db.name + ' toPut::: '
      , toPut: toPut.length >3? toPut.length : toPut });
    if (toPut.length) await this.table.bulkPut(toPut);
    return `${localClash.length} pk moved /${dlStuff.length} downloaded`
  }
  /** while any dirty rows, byte check before uploading, also slip in meta stats */
  public async modrwCheck() {
    const modrw = await this.table.filter(row => row.modAt != null).toArray()
    if (modrw.length==0) return modrw
    const recSizes = modrw.map(r => ({
      tid: (r as any).tid,
      uniq: this.uniqstr(r),
      sz: jsonB((r as any)?.rec)
    }));
    const recTotal = recSizes.reduce((a, b) => a + b.sz, 0);
    const top3 = [...recSizes].sort((a, b) => b.sz - a.sz).slice(0, 3)
      .map(x => `${x.tid}:${fc.fmtB(x.sz)} ${x.uniq}`).join(' | ');
    const cnt = await this.table.count();
    modrw.push( this.meta({ cnt, recTotal, top3 }))
    stts(`dirty:${modrw.length} /${cnt} rec:${fc.fmtB(recTotal)} top3[${top3}]`, 'sync');
    return modrw
  }
}
export function metaStat(stats:any) :sdb.Da {
  const modDate = new Date()
  return({
    tid: -1,
    type: 'stat-cnt',
    ref: 'greet stat-cnt',
    txt: 'stat',
    rec:  { [sdb.treeCac['devAgent'] as string]: {
      cnt: stats?.cnt,
      stat: stats?.recTotal,
      at: modDate,
    } },
    modAt: modDate,
  });
}
export const fmtSyncCnt=(o)=> `${o.cnt} at ${fc.fmtAgo(o.at)}`

/** One finished checkpoint of the current `greet()` run. */
export interface GreetStep { name: string; ms: number }

/** Observable state of the singleton `greet()`: staged progress plus the last outcome.
 *  A throttled call does no work and never counts as in-flight.
 *  `frac` is an estimate: checkpoints set it, and a 100 ms ticker creeps it toward the next
 *  expected checkpoint, so the ring keeps moving while a network step is in flight. */
export interface GreetStat {
  inflight: number
  /** Current stage name; `idle` between runs. */
  phase: string
  /** Estimated stage progress, 0..1. */
  frac: number
  /** Finished checkpoints of the last run, oldest first. */
  steps: GreetStep[]
  /** Message of the last failed round; cleared by the next round that finishes cleanly. */
  lastError?: string
  lastOkAt?: number
  /** Dirty rows still unpushed after the last round. */
  lastDirtyLeft: number
}
let stat: GreetStat = { inflight: 0, phase: 'idle', frac: 0, steps: [], lastDirtyLeft: 0 }
const statListeners = new Set<() => void>()
/** Snapshot for `useSyncExternalStore`; replaced on every change, never mutated. */
export const getGreetStat = () => stat
/** @returns the unsubscribe function for the listener. */
export function subscribeGreetStat(listener: () => void) {
  statListeners.add(listener)
  return () => { statListeners.delete(listener) }
}
function setStat(patch: Partial<GreetStat>) {
  stat = { ...stat, ...patch }
  statListeners.forEach(l => l())
}

/** How far past the last checkpoint the ticker may creep before the next one lands. */
const CREEP = 0.08
let ceiling = 0.15
let stepStart = 0
let ticker: ReturnType<typeof setInterval> | undefined

/** Record a checkpoint: closes the previous step, opens this one, and lets the ring creep
 *  toward `frac + CREEP` while the stage runs.
 *  @param name stage name shown in the tooltip
 *  @param frac progress this checkpoint proves */
export function markStep(name: string, frac: number) {
  const now = performance.now()
  ceiling = Math.min(0.97, frac + CREEP)
  setStat({
    phase: name,
    frac: Math.max(stat.frac, frac),
    steps: [...stat.steps, { name, ms: stepStart ? Math.round(now - stepStart) : 0 }].slice(-9),
  })
  stepStart = now
}
function startTicker() {
  if (ticker) return
  ticker = setInterval(() => {
    if (stat.inflight === 0) return
    const next = Math.min(ceiling, stat.frac + 0.01)
    if (next > stat.frac) setStat({ frac: next })
  }, 100)
}
function stopTicker() {
  if (!ticker) return
  clearInterval(ticker)
  ticker = undefined
}
function beginRun() {
  stepStart = 0
  ceiling = 0.15
  setStat({ inflight: stat.inflight + 1, phase: 'start', frac: 0.02, steps: [{ name: 'start', ms: 0 }] })
  startTicker()
}
function endRun() {
  stopTicker()
  stepStart = 0
  lastRunAt = Date.now()
  setStat({ inflight: Math.max(0, stat.inflight - 1), phase: 'idle', frac: 0 })
}

export const greeter = new Greeter(
    sdb.db.das,
    sessReady,
    sbg,
    sdb.treeCac['snap_name'] as string,
    sdb.deepMerge,
    sdb.daUniq,
    (r: sdb.Da) => r.tid,
    sdb.daNoPk,
    metaStat
  )
sdb.db.tree.get('snap_name').then(async kv=> {
  const pin = (await sdb.db.tree.get('snap_pin'))?.value as string | undefined
  const raw = pin || (kv?.value as string) || ''
  greeter.snap = effSnapName(raw)
  stts((pin ? 'pinned ' : '') + (greeter.snap || 'none').replace('.cbor.pako',''), '-snapname')
})
greeter.onError = message => setStat({ lastError: message })
greeter.onStep = (step, frac) => markStep(step, frac)
/** One local edit a server-wins merge discarded, still held in the row's `rec.cr`.
 *  `stamp` is the key it is filed under: the discarding client's `devAgent` plus the ISO form
 *  of the edit's `modAt`. */
export interface Conflict {
  ref: string
  stamp: string
  /** Why the edit was discarded, from `sdb.drainCr`: the patch gate's miss reason, or
   *  `patch-unplaced` for a buffer write the editor could not merge. */
  reason: string
}
let conflicts: Conflict[] = []
const conflictSeen = new Set<string>()
const conflictListeners = new Set<() => void>()
/** Announced conflicts the UI has not offered yet, oldest first. Replaced, never mutated, so
 *  `useSyncExternalStore` sees each change. */
export const getConflicts = () => conflicts
/** @returns the unsubscribe function for the listener. */
export function subscribeConflicts(listener: () => void) {
  conflictListeners.add(listener)
  return () => { conflictListeners.delete(listener) }
}
/** Drop one conflict once its diff has been opened or its edit applied. */
export function consumeConflict(conflict: { ref: string; stamp: string }) {
  conflicts = conflicts.filter(c => c.ref !== conflict.ref || c.stamp !== conflict.stamp)
  conflictListeners.forEach(l => l())
}
function announceConflicts(fresh: Conflict[]) {
  const added = fresh.filter(c => !conflictSeen.has(`${c.ref}@${c.stamp}`))
  if (added.length === 0) return
  added.forEach(c => { conflictSeen.add(`${c.ref}@${c.stamp}`)
    console.debug(`[cr] ${c.reason} ${c.ref}@${c.stamp}`) })
  conflicts = [...conflicts, ...added]
  conflictListeners.forEach(l => l())
}

let greetTill = 0;
const MS_TIMEOUT_GREET = 4321
/** The round now running, so a writer can wait for the server's version instead of racing it.
 *  `greet`'s throttle answers a concurrent call with `{}`, which is not a join. */
let rounding: Promise<unknown> | null = null
/** When the last round finished, whether it landed or failed: a writer only restarts a round
 *  the throttle swallowed, and never spins on a server that keeps failing. */
let lastRunAt = 0
  /** dl latest snap if new, then greet pull any new TODO init 15s
 * @param tab dexie table
 * @returns 
 */
const greetOnce = async (tab: Table)=> {
    let st = performance.now()
    console.log('greet with: ', sess?.user.email)
    const [curSnap, pinKv] = await Promise.all([
      sdb.db.tree.get('snap_name'), sdb.db.tree.get('snap_pin')])
    const pin = String(pinKv?.value ?? sdb.treeCac['snap_pin'] ?? '')
    const res = await dl_merge(tab, curSnap?.value as string, false, markStep, pin)
    if (res.error || !res.toPut ){
      console.error(`greet ${res.error}`, res)
      stts(`err greet: ${res.error}`,'greet')
      greetTill = 0
      setStat({ lastError: String(res.error) })
      return res
    }
    // the RPC partition and the loaded snapshot must agree, cached or freshly downloaded
    greeter.snap = res.upSnapName
    if(res.upSnapName!==curSnap?.value) {
      const putlen = Object.values(res.toPut).reduce((acc,a)=> acc +a.length,0)
      const putstr = Object.entries(res.toPut).map(([k,v])=> k+`[${v.length}] `).join()
      stts(putstr+` new snap ${res.upSnapName.replace('.cbor.pako','')} `, 'greet')
      sdb.db.tree.put({key:'snap_name', value: stts(greeter.snap, '-snapname')})
      const chunk = 0x1000; // TODO tune bulkPut 36k rows 6s
      for(const [_,toSplice] of Object.entries(res.toPut))
        while(toSplice.length >0) tab.bulkPut(toSplice.splice(0, chunk))
      st = fc.nowWarn(st, `put ${putlen} `+putstr)
    }
    const toBak = await greeter.pullPush()
    // a server-wins merge dropped a local edit: announce it so the editor can offer the diff tab
    announceConflicts(sdb.drainCr())
    markStep('push done', 0.95)
    sdb.db.stat.bulkPut(toBak).catch(e=>
      console.error(`db.stat bulkPut toBak`,JSON.stringify(e))
    )
    fc.nowWarn(st, `greeter.pullPush`,` ${toBak.length} bak b4merge`,33)
    if(toBak.length >0)
      stts(`greeter merged ${toBak.length}`,'greet')
    greetTill = 0
    const dirtyLeft = await sdb.db.das.where('modAt').above(new Date(0))
      .filter(r => r.tid !== -1).count()
    setStat({ lastError: undefined, lastOkAt: Date.now(), lastDirtyLeft: dirtyLeft })
    return {}
  }

/** Single-flight, throttled pull/push. A throttled call returns `{}` without doing any work,
 *  so it never counts as in-flight. */
export const greet = async (tab: Table) => {
  if (Date.now() < greetTill) return {}
  greetTill = Date.now() + MS_TIMEOUT_GREET
  beginRun()
  const run = greetOnce(tab)
  rounding = run
  try {
    return await run
  } catch (e) {
    setStat({ lastError: e instanceof Error ? e.message : String(e) })
    throw e
  } finally {
    if (rounding === run) rounding = null
    endRun()
  }
}

/** Start a sync without waiting for it: the local edit keeps moving while this runs.
 *  @param tab table to sync; defaults to the app's row table */
export function softGreet(tab: Table = sdb.db.das) {
  void greet(tab).catch(() => {})
}

/** Wait for the server's version of the rows before writing against it: join the round in
 *  flight, or start one when the throttle would swallow it and no round has finished since
 *  `idleSince` (the start of the current keystroke burst). A writer that skips this writes
 *  an older-based text over the version the row names, which the server admits as an `upd`.
 *  Resolves without error and without waiting past `maxWaitMs`, so a flush of a page that is
 *  going away is never held on the network.
 *  @param opts.idleSince epoch ms of the burst start; omit to only join a running round
 *  @param opts.maxWaitMs bound on the wait
 *  @returns when the round landed, failed, or the bound expired */
export async function greetSettled(opts: { idleSince?: number; maxWaitMs?: number } = {}) {
  const { idleSince, maxWaitMs = 2000 } = opts
  const bounded = (p: Promise<unknown>) => new Promise<void>(resolve => {
    const timer = setTimeout(resolve, maxWaitMs)
    void p.catch(() => {}).then(() => { clearTimeout(timer); resolve() })
  })
  if (rounding) return bounded(rounding)
  if (idleSince === undefined || lastRunAt >= idleSince) return
  greetTill = 0                        // the burst's own round was throttled away
  return bounded(greet(sdb.db.das))
}

/** Local rows whose `modAt` still marks them unsynced. The `tid -1` bookkeeping row
 *  (`greet stat-cnt`) is excluded: every round pushes it, the user does not edit it.
 *  @returns the dirty rows */
export async function outstandingDirty(): Promise<sdb.Da[]> {
  return sdb.db.das.where('modAt').above(new Date(0))
    .filter(r => r.tid !== -1).toArray()
}

/** The outstanding rows as confirmation lines.
 *  @param rows dirty rows from `outstandingDirty`
 *  @param max most lines to produce
 *  @returns one `ref (type)` line per row */
export function dirtyLabel(rows: sdb.Da[], max = 8): string[] {
  return rows.slice(0, max).map(r => `${r.ref} (${r.type})`)
}

/** Move the working set onto one snapshot: the CDN file `pin` names and, through
 *  `greeter.snap`, the `upsBase` partition the RPC locks on. The rows in hand are archived
 *  into `db.bins` and the table emptied first, so nothing dirty can leak into the pinned
 *  partition, then the pinned file is loaded by one greet round.
 *
 *  The pin is checked against a fresh listing before anything is deleted.
 *  @param pin snapshot filename to pin, or `''` to follow the newest snapshot
 *  @returns whether the switch was applied, plus the loading round's error when it had one */
export async function applySnapPin(pin: string): Promise<{ ok: boolean; error?: string }> {
  const next = pin.trim()
  if (next) {
    const list = await listSnaps()
    if (list.error) return { ok: false, error: `list: ${list.error.message}` }
    if (!list.data?.some(r => r.name === next))
      return { ok: false, error: `no such snap: ${next}` }
  }
  const rows = await sdb.db.das.toArray()
  await sdb.binPut(`das-${greeter.snap || 'auto'}-${new Date().toISOString()}`, rows)
  stts(`backed up ${rows.length} row(s) to db.bins`, 'greet')
  await sdb.db.das.clear()
  await sdb.db.tree.bulkPut([
    { key: 'snap_pin', value: next },
    { key: 'snap_name', value: '' },   // nothing loaded, so the pin is fetched
  ])
  sdb.treeCac['snap_pin'] = next
  greeter.snap = effSnapName(next)
  greetTill = 0                        // the switch must not be swallowed by the throttle
  const res = await greet(sdb.db.das)
  return { ok: true, error: 'error' in res && res.error ? String(res.error) : undefined }
}