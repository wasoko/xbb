import * as fc from './fc';
import { stts } from './fc';
import {DEF_TREE, Tag, db} from './idb'
import Dexie from 'dexie';
import * as sb from '@supabase/supabase-js';


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
export const getSessionAsync = (sbc:sb.SupabaseClient) :Promise<sb.Session> => 
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