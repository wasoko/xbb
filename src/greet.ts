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
export function bulk2put<R>(
  stale    : R[],
  modrw    : R[],
  dl       : R[],
  pk       : (r: R) => unknown,       // primary-key extractor  (this.pk)
  uniq     : (r: R) => string,        // unique-key extractor   (this.uniqstr)
  toStr    : (r: R) => string,        // content identity       (this.sts2str)
  deepMerge: (local: R, srv: R) => R, // this.deepMerge
  nopk     : (r: R) => Partial<R>,    // strip pk for relocation (this.nopk)
) {
  let st = performance.now()
  // ── index stale ──────────────────────────────────────────────────────────
  const staleByPk  = new Map(stale.map(r => [pk(r),    r]))   // clash lookup
  const staleStrs  = new Set(stale.map(toStr))                 // identity set
  const stalePks   = new Set(stale.map(pk))
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
        : { ...srv, modAt: null } as R
    )
  }
  // ── clash: row2put + relocate displaced local row ─────────────────────
  for (const srv of pkClash) {
    const mod        = modrwByUniq.get(uniq(srv))        // FIX: was toStr(srv)
    const local2move = staleByPk.get(pk(srv))!
    upsPK.push(
      mod
        ? deepMerge(mod, srv)
        : { ...srv, modAt: null } as R
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
  return { rows: up, cnt: ren_cnt, snapName:'up-'+snapName }
}
export async function dl_merge (tab: Table, curSnap='', testOld=false){
    let st = performance.now()
    if (!sess?.user) 
      return {error: 'dl merge no user', sess};
    const path = `${sess.user.id}`
    const res = await sbg.storage.from('bb').list(path, { 
      limit: 22, sortBy: { column: 'created_at', order: 'desc' } });    
    if (res.error) return res
    if (!res.data || res.data.length==0 ) 
      return {error: 'dl merge lack cdn snap: ', result:res}
    await tab.update(-1, { modAt: null }).catch(() => {});  // cleanup meta dirty bug

    const modrw = await tab.filter(row => row.modAt != null).toArray()
    let stale  = modrw.slice(0,0)
    if (testOld && res.data.length >1){
      const oldName = res.data[res.data.length - 1].name;
      const oldUp = upgrade_rows(await fc.dl(sbg.storage.from('bb'), path + `/` + oldName), oldName);
      const testOld = oldUp.rows;
      const toMerge = bulk2put([], [], testOld, (t:sdb.Da)=>t.tid
        , sdb.uniqsTag, sdb.tags2str,sdb.deepMerge, sdb.nopkTag )
      console.log(Object.entries(toMerge).map(([k,v])=> k+`[${v.length}] `).join())
      const chunk = 0x1000;
      for(const [_,toPut] of Object.entries(toMerge))
        while(toPut.length >0) tab.bulkPut(toPut.splice(0, chunk))
      fc.nowWarn(st, 'initial merge',undefined,33)
      stale = testOld
    } else stale = await tab.toArray()

    let snapName = res.data[0].name
    let upSnapName = upgrade_rows([], snapName).snapName  // empty rows to check snapname
    if (curSnap===upSnapName) // if no new snap
      return{upSnapName,toPut: { newPK: [], upsPK: [], noPK: [],}}
    const lastSnapPath = path + `/` + snapName; // TODO 36k rows 4s
    const snapUp = upgrade_rows(await fc.dl(sbg.storage.from('bb'), lastSnapPath), snapName);
    stts(`ren ${snapUp.ren_cnt} sts ->tags`,'greet')
    st = fc.nowWarn(st, `dl snap`, upSnapName)
    const toPut = bulk2put(stale, modrw, snapUp.rows, (t:sdb.Da)=>t.tid
      , sdb.uniqsTag, sdb.tags2str,sdb.deepMerge, sdb.nopkTag )
    if (toPut.upsPK.length>0)
      stts(`upserted ${toPut.upsPK.length}`)
    return {upSnapName, toPut}
  }
/** if non-dirty loss ie upsBase left in old snap, atomic snap TODO
 * 
 */
export async function upSnap() {
  let st = performance.now()
  // const { data: { user } } = await sbg.auth.getUser() 
  // if (!user) return stts("err Not logged in")
  let oName = `tags${fc.fmt_ym(new Date())}.${await sdb.db.das.count()}.cbor.pako`;
  const res = await sbg.storage.from('bb').list(`${sess?.user.id}`
    , { limit: 11, sortBy: { column: 'created_at', order: 'desc' } });
  if (res.error) 
    return fc.sideLog(stts('err:'+res.error.message, 'greet'),res) 
  const matched = res.data.filter((o: { name: string; })=> o.name.startsWith('tags'));
  console.log('stale check: ',matched)
  if(matched.length?? 0 >0)
    if (oName== (matched[0].name as string))
      return {status: stts(`skipped stale ${oName} count`)}
  await sanitize_md()
  const ta =  await sdb.db.das.toArray()
  // const es = await sdb.db.vecs.toArray();
  const fileApi = sbg.storage.from('bb')
  const msg = await fc.ul(ta, fileApi, `${sess?.user.id}/tags`,ta.length)
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
export class Greeter<R extends { modAt?: Date; dt?: Date; rec?: Record<string, unknown> },PK=unknown> {
  constructor(private table: Dexie.Table<R>
    , protected sessReady:Promise<sb.Session|null>, protected sbg:sb.SupabaseClient
    , public snap:string
    , private deepMerge: (local:R, server:R) => any
    , private uniqstr: (row:R) => string  // uniq string for unique key(s)
    , private pk: (row:R)=> PK
    , private nopk: (row:R)=> Partial<R> // remove pk for auto-gen
    , public meta = (stat:any): R => (stat as any)
  ) {}
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
      const { data: res, error } = await this.sbg.rpc('ups_same_base', {
        snap_name: this.snap, payload, last_dt: last_dt?.dt });
      acc.rpc+= performance.now() -st
      console.log( {ok_uniqs: res?.ok_uniqs, dl_len: res?.dl?.length, status: res?.status, server_now: res?.server_now})
      if (error || !res) {
        // A failed round must not consume the retry budget of the merge loop, and must not spin:
        // retry once after a backoff, then leave the dirty rows for the next greet.
        console.error('Error greeting server:', error)
        stts(`err greeting server ${error?.code ?? ''}: ${error?.message ?? 'no result'}`,'greet')
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
              , rec: sdb.shelfVer(r.rec, sdb.verKey(res.server_now, null)
                , sdb.verSnap({ ...r, dt: res.server_now })) } as UpdateSpec<R>
          }))
          await this.table.bulkUpdate(okChanges)
          acc.ok += performance.now() -st
          stts(stts(`${okRows.length} pulled`,'greet'),'-tabs')
        }
        const dlStuff = (res.dl || []).map(d => ({...d.stuff, dt:d.dt}));
        st = performance.now()
        if (res.dl.length >0) await this.merge(dlStuff, modrw)
          .then(s=> stts(stts(s, 'greet'),'-tabs') )
        else await this.table.filter(row => row.modAt != null)
            .modify({dt:undefined})   // last_dt null to trigger server ins (dt already voided if modAt)
        acc.merge += performance.now() -st

      })  // TODO FIXME init dl /w 1st empty payload
      if (res.dl.length==0 && res.ok_uniqs.length==0)
        if (modrw.length==0) break
        else {
          stts(`err greet stalled: ${modrw.length} row(s)`, 'greet')
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
    else toPut.push(serverRow)
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

export const greeter = new Greeter(
    sdb.db.das,
    sessReady,
    sbg,
    sdb.treeCac['snap_name'] as string,
    sdb.deepMerge,
    sdb.uniqsTag,
    (r: sdb.Da) => r.tid,
    sdb.nopkTag,
    metaStat
  )
sdb.db.tree.get('snap_name').then(kv=> 
  stts((greeter.snap = kv?.value as string).replace('.cbor.pako',''), '-snapname'))
let greetTill = 0;
const MS_TIMEOUT_GREET = 4321
  /** dl latest snap if new, then greet pull any new TODO init 15s
 * @param tab dexie table
 * @returns 
 */
export const greet = async (tab: Table)=> {
  if (Date.now() < greetTill) return {};
  greetTill = Date.now() + MS_TIMEOUT_GREET
    let st = performance.now()
    console.log('greet with: ', sess?.user.email)
    const curSnap = await sdb.db.tree.get('snap_name') 
    const res = await dl_merge(tab, curSnap?.value as string, false)
    if (res.error || !res.toPut ){
      console.error(`greet ${res.error}`, res)
      stts(`err greet: ${res.error}`,'greet')
      greetTill = 0
      return res
    }
    if(res.upSnapName!==curSnap?.value) {
      const putlen = Object.values(res.toPut).reduce((acc,a)=> acc +a.length,0)
      const putstr = Object.entries(res.toPut).map(([k,v])=> k+`[${v.length}] `).join()
      stts(putstr+` new snap ${res.upSnapName.replace('.cbor.pako','')} `, 'greet')
      sdb.db.tree.put(({key:'snap_name', value: 
        stts(greeter.snap = res.upSnapName, '-snapname')}))
      const chunk = 0x1000; // TODO tune bulkPut 36k rows 6s
      for(const [_,toSplice] of Object.entries(res.toPut))
        while(toSplice.length >0) tab.bulkPut(toSplice.splice(0, chunk))
      st = fc.nowWarn(st, `put ${putlen} `+putstr)
    }
    const toBak = await greeter.pullPush()
    sdb.db.stat.bulkPut(toBak).catch(e=>
      console.error(`db.stat bulkPut toBak`,JSON.stringify(e))
    )
    fc.nowWarn(st, `greeter.pullPush`,` ${toBak.length} bak b4merge`,33)
    if(toBak.length >0)
      stts(`greeter merged ${toBak.length}`,'greet')
    greetTill = 0
    return {}
  }