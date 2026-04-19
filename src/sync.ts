import * as fc from './fc';
import { stts } from './fc';
import {DEF_TREE, Tag, db} from './idb'
import Dexie from 'dexie';
import * as sb from '@supabase/supabase-js';

export class MergingMan {  // while keeping traces
  constructor(private table: Dexie.Table
    , protected snap:string
    , private deepMerge: (local, server) => any
    , private uniqstr: (row) => string
    , private pk: (row)=> any
    , private nopk: (row)=> any
  ){}
  
  /**
   * syncAll: sync dirty rows up, then always pull latest from server
   * https://share.google/aimode/HTls7bUqqX7okxDu1
   */
  async syncAll() {
    const MAX_RETRIES = 5;
    const BASE_DELAY = 500; 
    const MAX_DELAY = 10000;
    let retryCount = 0;
    while (1) {
      console.log('syncAll: getting dirty rows...')
      let dirtyRows = await this.table.filter(row => row.modAt != null).toArray();
      console.debug('syncAll: dirtyRows count:', dirtyRows.length)
      // console.log('sess', sess, sess?.user)
      const res = await this._doSync(dirtyRows)
      if (res.dl.length==0) break
      retryCount++;
      if (retryCount >= MAX_RETRIES) break;

      const delay = Math.min(MAX_DELAY, BASE_DELAY * Math.pow(2, retryCount));
      const jitter = delay * 0.25 * Math.random();
      await new Promise(r => setTimeout(r, delay + jitter));
    }
  }

  private async _doSync(dirtyRows: any[]) {
    console.debug(`_doSync START: dirtyRows.length=${dirtyRows.length}, snap=${this.snap}`)
    const last_dt = await this.table.orderBy('dt').last()
    console.debug(`_doSync: last_dt=`, last_dt)
    console.debug(`_doSync: sess?.user.id:`, sess?.user.id)
    const payload = dirtyRows.map(r=> ({uniqs: this.uniqstr(r), dt: r.dt, stuff: r, user_id: sess?.user.id}))
    console.debug(`_doSync: payload.length=`, payload.length)
    const uniqsmap = Object.fromEntries(payload.map(pkr=> [pkr.uniqs, pkr.stuff]))
    const puts = []
    await sessReady
    console.log(`_doSync: sessReady, user.id=`, sess?.user.id)
    const {data: result, error} = await sbg.rpc('ups_same_base',{
      snap_name:this.snap, payload, max_dt: last_dt?.dt});
    console.debug(`_doSync: RPC result:`, {ok_uniqs_count: result?.ok_uniqs?.length, dl_count: result?.dl?.length, server_now: result?.server_now})
    if (!result) {
      console.error('sync error:', error)
      return
    }
    if (this.pk){
      const ok_pk = result.ok_uniqs.map(uniqs=> this.pk(uniqsmap[uniqs]))
      const pk_dict_dl = Object.fromEntries( result.dl.map(row=> 
          [ this.pk( row.stuff), row]))
        // assert modAt=null in all result.dl
      await this.table.where(':id').anyOf( ok_pk).modify((row) => {
          if (row.modAt===uniqsmap[this.uniqstr(row)].modAt) {
            row.dt = result.server_now
            row.modAt = null
            }})
          
        await this.table.where(':id').anyOf( ...Object.keys(pk_dict_dl)).modify((live_row) => {
          const server_row = pk_dict_dl[ this.pk(live_row)].stuff
                    let rep = server_row
          // if uniqstr match, then deepmerge, else move away
          if (this.uniqstr(live_row) ===this.uniqstr(server_row))
            rep = this.deepMerge(live_row, server_row)
          else puts.push({...this.nopk(Dexie.deepClone(live_row)), modAt: new Date() })
          Object.assign(live_row, rep)
          live_row.modAt = new Date()
          delete pk_dict_dl[this.pk(live_row)]
        })
        await this.table.bulkPut(Object.values(pk_dict_dl).map(dl=> 
          ({...dl.stuff, dt:result.server_now, modAt:null})))
              this.table.bulkPut(puts)        
    } else 
      this.table.bulkPut((result.dl || []).map(dl=>
        ({...dl.stuff, dt:result.server_now, modAt:null})))
        // NOTE modAt:null bulkPut could miss dirtyRow, dead retry
    return result
  }
}

let isExt = typeof chrome !== 'undefined' && chrome.storage;
const storage = isExt? chrome.storage.sync || chrome.storage.local : null;
const tokenStorageAdapter = { getItem: async (key: string) => {
    const result = await storage.get(key);
    return result[key] || null;
  },
  setItem: async (key: string, value: string) => await storage?.set({ [key]: value }),
  removeItem: async (key: string) => await storage?.remove(key),
};
console.log(`isExt: `, isExt)
const sb_options = { db:{schema:'tt'}, auth: {
    autoRefreshToken:   !isExt && !process.env.VITEST,// ??    // For Chrome extensions, disable auto-refresh to avoid redirect issues
    detectSessionInUrl: !isExt, // Prevent chromium-extension:// URL issues
    persistSession: true,
    storage: isExt? tokenStorageAdapter : undefined,
    debug:false,
}}
export const getSessionAsync = (sbc:sb.SupabaseClient) :Promise<sb.Session|null> => 
  new Promise((resolve) =>  // const { data: { subscription } } = 
    sbc.auth.onAuthStateChange((event, session) => {
      // Logic: Only resolve if we have a session 
      // or if the initial check is complete and confirms no user.
      // console.log(`on auth state: `, event, session)
      if (session) // && event === 'SIGN3ED_IN' || event === 'INITIAL_SESSION') 
        // subscription.unsubscribe();
        resolve(session)
      }))
export let sbg:sb.SupabaseClient = sb.createClient(DEF_TREE['server'], DEF_TREE['pub_key']
  , sb_options);
export let crdt: MergingMan |null = null
// export let userReady = sbg.auth.getUser()
// userReady.then((ures)=> console.log(`user: `, ures,user = ures.data.user))
// export let user: sb.User |null = null
export let sess: sb.Session |null = null
export let sessReady = getSessionAsync(sbg) //  sbg.auth.getSession() return memory even null, getUser slow
sessReady.then((session)=> sess = session)
// authReady.then((event, session) => {
//   sess = session;
//   stts(sess?.user.email ??'', 'Sigin')
//   if (event==='SIGNED_IN' && session) crdt = new MergingMan('tags', db.tags)// subRt(sbg)
//   if (event==='SIGNED_OUT') fc.sideLog('SIGNED_OUT',sbg.removeAllChannels())
// });
export async function signinGoogle() {
  const nextPath = window.location
  const { data, error } = await sbg.auth.signInWithOAuth({
    provider: 'google', options: isExt? {
      skipBrowserRedirect: true, // Returns the URL instead of redirecting
      redirectTo: chrome.identity.getRedirectURL(),
    }:{redirectTo: nextPath.href} });
  if (error) return ['', fc.sideLog('err signin Google: ',error).message]
  if (isExt) {
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
export function set_sbg(server, pub_key) {
  // try {
    const tmp_sbc = sb.createClient(server, pub_key, sb_options)
    // if (tmp_sbc) last_sync_desc(tmp_sbc).then(res=> {
    //   if (res.ok) stts('cred test done', "Sync")
    //   else return fc.sideLog('cred test error: ',res)
    if (sbg) {
      sbg.realtime.disconnect(); 
      sbg.removeAllChannels();
      sess = null
    }
    sbg = tmp_sbc
  // }) } catch(e) {
  //   stts(e.message, "Sync")
  //   console.error(`error: `,e)
  // }
}
export async function last_sync(sbc:sb.SupabaseClient) {
  const st = performance.now()
  const {ok, name} = await last_sync_desc(sbc)
  // if (!ok) return 
  const res = fc.dl(sbc.storage.from('bb'), name)
  fc.nowWarn(st, 'sync', 'dl last')
  return res
}
export async function last_sync_desc(sbc:sb.SupabaseClient) {
  const st = performance.now()
  const { data: { user } } = await sbc.auth.getUser()
  if (!user) return {ok:false, error: stts("err Not logged in"), result:user}
  const path = `${user.id}`
  const result = await sbc.storage.from('bb').list(path, { limit: 11, sortBy: { column: 'created_at', order: 'desc' } });    
  if (result.error) 
    return {ok:false, error: stts(`err [listing buckets]  ${result.error.name}: ${result.error.message}`), result}
  if (!result.data.length)
    return {ok:false, error: stts(`No snapshot found yet.`), result}

  const matched = result.data?.filter((o: { name: string; })=> o.name.startsWith('tags'))
  if (!matched.length)
    return {ok:false, error: stts(`err no matched sync image found`), result}  // already return false after async wrapper
  fc.nowWarn(st, 'sync', 'list last')
  return {ok: true, name: path+'/'+matched[0].name, updated_at: matched[0].updated_at, result}
}