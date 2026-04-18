import {Dexie} from 'dexie';
import * as fc from './fc';
import { countBy } from 'es-toolkit';
import * as diffmp from 'diff-match-patch'
export interface Tag { tid?: number, txt: string, ref: string // sync live-->tid less clash
  , sts?: string[] // no , as `${t.sts}` default join by , (NOTE: largest index space)
  , dt:Date, type: string, modAt?:Date, rec: Record<string,unknown> } // dt=server dt , 'bookmark' | 'history' | 'tab' | 'tag'
export const eqTags = (r1: Tag, r2: Tag) => r1.ref === r2.ref && r1.txt === r2.txt && r1.type== r2.type
export const uniqsTag = (t: Tag) => t.ref+t.type
export const nopkTag = ({tid:_, ...rest}:any) => rest 
export const tid_last = async ()=>await db.tags.orderBy(':id').last()
export async function clean() {
  const now = new Date()
  const null_dt = await db.tags.filter(t=> t.dt===undefined).toArray()
  let updates = null_dt.map(t=> ({key:t.tid, changes:{dt: now}}))
  if (updates.length >0) return await db.tags.bulkUpdate(updates)
  
  return 0
}
export const DEF_TREE:{[key:string]: unknown} = { //"cred": "https://PROJECTID.supabase.co|anon"
  "user_browser": "browserX",
  "server": 'https://qhumewjpkzxaltwefqch.supabase.co',
  "pub_key": 'sb_publishable_5Stcng45Jofw5Wv3FA4GnQ_BivUYQ_K',
  // , "emb_model-HF":HF_OR[0]
}
export async function binPut(key:string, bin: any) {
  db.bins.put({ key, rec: { date: new Date().toLocaleString('zh-cn',{hour12:false}) }
      , bin: fc.encZip(bin) });
}
export class DDB extends Dexie {
  tree!: Dexie.Table<{ key: string, value: unknown }>;
  tags!: Dexie.Table<Tag>;
  vecs!: Dexie.Table<{ tid: number, mdl: string, vec: Float32Array }>;
  stat!: Dexie.Table<{ tid: number, key: string, value:unknown }>;
  bins!: Dexie.Table<{ key: string, rec: unknown, bin: Uint8Array, addAt?: Date, modAt?:Date}>;

  constructor(dbName: string = 'tagDB_0') {
    super(dbName)

    this.version(8).stores({  // to infer 2nd generic type
      tree: 'key', // href+title, 
      tags: '++tid, dt, type, *sts, [ref+type]',
      vecs: '[tid+mdl]', // for orama or psqlvec
      stat: '[tid+key]',
      bins: 'key, [key+addAt], [key+modAt]',
      refs: '++id, title, href, dt, type'
    })
    this.version(9).stores({  // to infer 2nd generic type
      tree: 'key', // href+title, 
      tags: '++tid, dt, type, *sts, [ref+type]',
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

export async function getRowsAroundTid(tid: number, n: number) {
  // Get n rows before tid (in reverse order, then reverse back for chronological)
  n = Math.max(3, n)
  const b4 = await db.tags.where('tid').below(tid).reverse().limit(n/2).toArray()
  const af = await db.tags.where('tid').above(tid).limit(n -n/2 -1).toArray();
  const eq = await db.tags.get(tid)
  return [...af.reverse(), eq , ...b4] .filter(t=> t!==undefined);
}

// utils
export const where_pk_last = (tab: { where: (arg0: string) => { (): any; new(): any; between: { (arg0: any[], arg1: any[]): { (): any; new(): any; last: { (): any; new(): any; }; }; new(): any; }; }; }, pairs: any[]) =>Promise.all(
  pairs.map((tup: any) => tab.where(':id')
      .between([...tup, Dexie.minKey], [...tup, Dexie.maxKey])
      .last() ) )

export const dev_PREFFIX = 'dev_'
async function stat_tags(){
  let str = ''
  let cntRef = {}
  ;(await db.tags.orderBy('[ref+type]').keys()).forEach(k=>  cntRef[k] = 1+(cntRef[k] ??0))
  // str += `dup ref+type: ` + Object.entries( cntRef).filter(([k,v]) => v >1).map(kv =>kv[0]).join()
  const dts = await db.tags.orderBy('dt').reverse().limit(11).uniqueKeys()
  if (dts.length==0) return str
  str += ` updated ${fc.diffDays(new Date(), dts[0]).toFixed(2)} days ago`
  for(const dt of dts) {
    const ts = db.tags.where('dt').equals(dt)
    str += `\n`+`${await ts.count()}`.padStart(4,' ')+` at `+fc.fmt_mdwhm(dt) 
    const tsa = await ts.toArray()
    if (tsa.length===1) str += ' '+ tsa[0].type+`: `+tsa[0].txt + tsa[0].sts?.map(s=> ` #${s}`)?.join()
    // const cnt = ts.filter(t=> t.type!=='tab')
    str += ` max(tid)=${Math.max(...tsa.map(t=> t.tid ?? 0))}`
    const alltags = tsa.flatMap(t=>t.sts ??[])
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
  await db.tags.orderBy('[ref+type]').eachUniqueKey(async key => {
    const collection = db.tags.where('[ref+type]').equals(key);
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
  return (`local saved: ${await db.tags.count()} tags ${await stat_tags()}
  ...\n${await db.stat.count()} stats max(tid)=${
    (await db.stat.reverse().last())?.tid},  ${await db.vecs.count()} vecs max(tid=${
      (await db.vecs.reverse().last())?.tid})`)
}
/** ignore identicals, split clashing by tid, ignoring exact match
 * @param ts 
 * @param dl 
 * @returns 
 */
export function diffTags( ts:Tag[], dl:Tag[]) {
  // TODO clean ancient backup
  let clash: Tag[] = []
  let newDL = dl  // default save all downloaded
  if (ts.length>0) {
    const tag2str=(t:Tag) => `${t.ref}|${t.txt}|${t.type}|${t.sts}` // for now ignore |${t.ats} 
    const tsSet = new Set(ts.map(tag2str))
    newDL = dl.filter(rt=> ! tsSet.has(tag2str(rt)))  // any diff, except rec
    if (newDL.length >33)
      console.log(`${newDL.length} diff in idb`)
    else
      newDL.forEach(d=> console.log(`diff:[${d.txt}]\n  vs:(${d.ref})`))
    // upsert do not 
    const idSet = new Set(ts.map(t=> t.tid))
    if (newDL.some(t=> idSet.has(t.tid))) {
      clash = newDL.filter(t=> idSet.has(t.tid))
      const idClash = new Set(clash.map(t=> t.tid))
      newDL = newDL.filter(t=> ! idClash.has(t.tid))
    }
  }
  return { newDL, clash, ts}
}
export function patchMod(base: Tag, b4mod: unknown, mod: Tag): any {
  if (!b4mod) return base
  const dmp = new diffmp.diff_match_patch()
  base.txt = dmp.patch_apply(dmp.patch_make(b4mod.txt, mod.txt), base.txt)[0]
  base.sts = dmp.patch_apply(dmp.patch_make(
    `${b4mod.sts??[]}`, `${mod.sts??[]}`), `${base.txt}`)[0].split(',')
  return base
}
export function deepMerge(rin: Tag, rl:Tag) {
  const [newer,older] = rin.dt >rl.dt ? [rin,rl] : [rl,rin]  // TODO if local modAt, patch
  const seq = [... (rin.rec.seq as any[] ??[]), ...(rl.rec.seq as any[] ??[])]
  const deduped = [ ...Object.values(Object.fromEntries(seq.map(item => [item.dt, item]))).reverse()]
  deduped.unshift(({dt: older.dt, txt: older.txt, sts: older.sts}))
  const {rec, ...b4mod} = Dexie.deepClone(newer)
  if (older.modAt) patchMod(newer, older.rec.b4mod, older)
  if (newer.modAt) patchMod(newer, newer.rec.b4mod, newer)
  rec.seq = deduped
  rec.b4mod = b4mod
  return {...newer, rec, modAt: new Date()}
}
export async function bulkMerge(clash: Tag[]) {
  const puts:Tag[] = []
  const tid2row = Object.fromEntries(clash.map(row=> [row.tid, row]))
  const tidSet = new Set(clash.map(row=> row.tid))
  await db.tags.filter(row=> tidSet.has(row.tid)).modify((live_row) => {
    let in_row = tid2row[live_row.tid!]
    if (uniqsTag(live_row)=== uniqsTag(in_row))
      in_row = deepMerge(in_row, live_row)
    else puts.push( {...nopkTag(Dexie.deepClone(live_row)), modAt:new Date()})
    Object.assign(live_row, in_row)
    live_row.modAt = new Date()
    delete tid2row[live_row.tid!]
  })
}