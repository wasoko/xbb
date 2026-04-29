import * as cbor from 'cbor-x';
import { keyBy } from 'es-toolkit';
import { object } from 'framer-motion/client';
// import { fromMarkdown } from 'mdast-util-from-markdown';
// import { toString } from 'mdast-util-to-string';
import {visit} from 'unist-util-visit';
import {remark} from 'remark'
import * as pako from 'pako';
import { useEffect, useState } from 'react';
export const isTEST = 0
export const isUT = "undefined" !=  typeof UNIT_TEST
export const inChrome = "undefined" !=  typeof chrome
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }
export const HF_OR = [  //'Xenova/jina-embeddings-v2-base-zh',
  // https://developer.volcengine.com/articles/7382408396873400371
  // 'TownsWu/PEG', // onnx missing https://developer.volcengine.com/articles/7382408396873400371

  'Xenova/bge-small-zh-v1.5', // onnx of 'BAAI/bge-large-zh-v1.5',
  'Classical/Yinka',
  'aspire/acge_text_embedding',
  'iampanda/zpoint_large_embedding_zh',
  'thenlper/gte-small-zh',
  'intfloat/multilingual-e5-small',
  'moka-ai/m3e-base',
  'sentence-transformers/paraphrase-MiniLM-L6-v2',
  'sentence-transformers/all-MiniLM-L6-v2',
  'sentence-transformers/all-mpnet-base-v2',
  'sentence-transformers/multi-qa-mpnet-base-dot-v1',
  'sentence-transformers/distilbert-base-nli-mean-tokens'
];
export const DEF_MODEL = HF_OR[0]


const tag2md=(ts)=>  ts.map(t=> t.txt).join('')
/**
 * Flattens mdast root children into the requested custom structure.
 * @param {import('mdast').Root} tree - The mdast tree from fromMarkdown.
 * 1l xi xp xt
 *     +-2l xi xp xt
 *           +-3i xp xt
 *           +-4i xp xt
 *  +-5i xp xt
 * heading text
 */
export function md2tag(mdText:string) {
  mdText = mdText.replace(/[ \t]+$/ugm, "")
  const tree = remark().parse(mdText);
  const result = [];
  let prevEnd = 0
  visit(tree, (node, index, parent) => {
    const inlineNode = node.type==='link'
    if (prevEnd < node.position?.end.offset 
      && (node.value || node.type==='link') )
      result.push({ txt: mdText.slice(prevEnd, (prevEnd = 
        node.type==='link' ? parent.position?.end.offset 
        : node.position?.end.offset + (parent.type=='strong'? 2 :0)))
        , ref: ['html','link','blockquote','inlineCode'].includes(node.type)? node.type
        : parent.type==='paragraph' && parent.parent ? parent.parent.type: parent.type
        , type:'md'})
    })
  return result;
}
if(isTEST) {let text = ` ## Heading __strong__ \`inlineCode\`
- Item 1
  - Nested item
  - N2
    1. NN3
  * b1
  - N3
- I3

# Heading preceded by new-line
> blockquote
1. I3`
  const delog = (...arg:any[]) => { return sideLog(...arg)}
  let tree = remark().parse(text) //, res = []; visit(tree, n => n.type !== 'root' && res.push({ txt: text.split('\n').slice(n.position.start.line - 1, n.position.end.line).join('\n'), ref: JSON.stringify(n) }))
  console.log(`md2..`, tree, tag2md(delog('md2tag',md2tag(text))))
}
export function reAddCB(callback:
  (message: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => void
) {
  if (!inChrome) return
  chrome.runtime.onMessage.removeListener(callback)
  chrome.runtime.onMessage.addListener(callback)
}
export const sttsCB =  (message:any, _s?:any, _sr?:any) => {
  if (typeof document === 'undefined') return
  const dd = document.getElementById(message.type)
  if (dd !==null && message.type.startsWith('stts') )
    dd.textContent = message.stts
  return false
}
export const sttsDict:{[key:string]:string} = {}
export const stts = (str: string, scope = '') => {
  const stKey=scope+'STTS'
  sttsDict[stKey] = str
  if (str.startsWith("err"))
    console.error(str);
  console.info(str);
  sttsCB({type: 'stts'+scope, stts: str})
  if (inChrome) {
    if (chrome.runtime) chrome.runtime.sendMessage({type:'stts'+scope,stts:str})  // FIXME avoid recur
    if (chrome.storage) chrome.storage.session.get({[stKey]:''}).then((items) => {
      if (str!='')chrome.storage.session.set({[stKey]: items[stKey] + str})
      })
  }
  return str;
}
export const scrollToTbodyN = (tbodyRef: React.RefObject<HTMLTableSectionElement>, n:number) => {
  if (tbodyRef.current && tbodyRef.current.children.length >0) {
    const i = n>=0? n: tbodyRef.current.children.length +n
    const scrollableElement = tbodyRef.current.children[i] satisfies HTMLElement;
    scrollableElement.scrollIntoView({behavior: 'smooth',block:'nearest'});
  }
}
export function input2options(id:string, options:string[]) {
  const input = document.getElementById(id) satisfies HTMLInputElement;
  const datalist = document.createElement('datalist') satisfies HTMLDataListElement;
  if (input && datalist) {
    options.forEach(i => datalist.appendChild(Object.assign(document.createElement('option'), { value: i })));
    input.parentNode?.append(Object.assign(datalist, { id: 'datalist-' + input.id }));
    input.setAttribute('list', datalist.id);
  }
} // let UT=1  ;if (typeof exports === 'undefined') { var exports = {}} // for bun repl
const hashtagRegex = /\s#[\p{L}\p{N}_]+/gu
const hashtail = /(?:\s+#[\p{L}\p{N}_]+#?)+$/gu;  // (?:... group non-capture
const hashDelSymbols = /[^\p{L}\p{N}_]/gu
export function t2txt(txt:string, sts:string[]) {
    const exHash = txt.match(hashtagRegex)?.map((m:string)=> 
      m.trim().slice(1).toLocaleLowerCase()) || []
    // console.info(exHash)
    return `${txt} ${sts.filter(s=> !exHash.includes(s.toLocaleLowerCase()))
        .map(s => ` ${s.replace(hashDelSymbols,'')}`).join('')}`
}
export function txtRx(txt:string) {
  let cleaned = txt
  let MIN_SUFFIX = 33
  let sts:string[] = []
  // if (txt.length <=MIN_SUFFIX) 
  //   return [txt, sts]
  ; let SEP =  [' - ', ' | ', '-','|',' _',' · ',' — ',' – ','/ X',' 鸡娃客','_哔哩哔哩_bilibili']
  ; let offset = Math.max(...SEP.map(sep=> txt.lastIndexOf(sep)))
  if (offset > Math.max(1,txt.length-MIN_SUFFIX)) {
    // console.debug('txtRx:', txt.slice(offset,txt.length))
    sts.unshift(`suffix_`+txt.slice(offset,txt.length).replace(hashDelSymbols, ''))
    cleaned = txt.slice(0, offset).trim()
  }
  sts.unshift(...new Set(cleaned.match(hashtagRegex)?.map(s=> s.slice(1)) as string[]))
  cleaned = cleaned.replace(hashtail,'')
  ; let TERM = ['. ', '。','; ','；'] // first 
  const keepcode = cleaned.indexOf('`', cleaned.indexOf('`')+1)  // keep `code`
  offset = Math.min(...TERM.map(sep=> cleaned.indexOf(sep, Math.max(33, keepcode))).filter(o=>o!==-1)) // trunc long paragraph at nearest sentences
  if (offset)  cleaned = cleaned.slice(0, offset).trim()
  return [cleaned, sts]
} if(isUT)["快讯：昆仑万维公告，第三季度营收为20.72亿元，同比增长56.16%；净利润为1.9亿元，同比增长180.13%。前三季度营收为58.05亿元，同比增长51.63%；净利润亏损6.65亿元，同比下降6.19%。 - 华尔街见闻"
  , "快讯：中共中央关于制定国民经济和社会发展第十五个五年规划的建议发布。其中指出，适度超前建设新型基础设施，推进信息通信网络、全国一体化算力网、重大科技基础设施等建设和集约高效利用，推进传统基础设施更新和数智化改造。完善现代化综合交通运输体系，加强跨区域统筹布局、跨方式一体衔接，强化薄弱地区覆盖和通达保障。健全多元化、韧性强的国际运输通道体系。优化能源骨干通道布局，加力建设新型能源基础设施。加快建设现代化水网，增强洪涝灾害防御、水资源统筹调配、城乡供水保障能力。推进城市平急两用公共基础设施建设。 - 华尔街见闻"
  , "平安保险在线客服,平安理赔查询,平安理赔系统- 中国平安官方直销网站"
  , "中港通巴士 - Google Search"
  , "由浅入深，万字解析：人民币的发行机制和汇率走势（下）_哔哩哔哩_bilibili"
  , "开车必备！自动朗读微信通知的神器玩过吗-微信 ——快科技(驱动之家旗下媒体)--科技改变未来"
  , "Watch 'Schonfeld University | Rates & Financing' | Microsoft Stream"
  , "繫年 - 維基百科，自由的百科全書"
  , "Bacterial Flagellar Motor #biology #science #bacterialflagellum - YouTube"
  , "3~6年级竞赛数学导引（PDF扫描版，含详细解答） 鸡娃客"
  , "👍九龍灣出租 EPSON FF-680W FastFoto scan 相片 相 高速掃描器, Computers & Tech, Printers, Scanners & Copiers on Carousell"
  ].forEach(t=> console.log(txtRx(t)))
export function txtref2tab(txt:string, ref:string) {
  const [cleaned, sts] = txtRx(txt)
  return { txt: cleaned, ref, sts} //: ['ref_'+cleanDomain(ref).replace('.','_'),...sts] }
}
export function str2tag(str:string ) {
  const all = str.split(/\s+/)
  const hash = all.filter(s=> s.startsWith('#'))
  return {txt: hash.join(' '),  sts:all.filter(s=>!s.startsWith('#'))}
} if(isUT) ['test   as',].forEach(s=> console.log(s))
export function markdown2tab(markdown: string) {
  let rx =  /^\s*(?:\d+\.)?\s*\[(.+)(?<!\\)\]\s*\((.+)\)\s*$/g    // escape ]( in url
  const ts = [];
  let match, endMatch;
  while ((match = rx.exec(markdown)) !== null) 
    ts.push(txtref2tab(match[1], (match[2]).replaceAll('\\](','](')))
  return {ts, lastIndex: rx.lastIndex}  // undo escape added from popup.tsx
} if(isUT) ['[t\\](UR](L)','[t](UR\\](L)','[t](UR](L)'].map(s=> (/\[(.+)(?<!\\)\]\((.+)\)/g.exec(s)))
export function cleanDomain(url: string) {
    // Remove protocol (http://, https://) and optional "www."
    if (url.startsWith('file:'))
      return url.slice(7, url.indexOf('\/',11))
    const cleanUrl = url.replace(/https?:\/\/(www\.)?/, '');
    return cleanUrl.split('/')[0]
} if(isUT) ['file:///C:/Users/wso/Downloads/JIRA.html', 'file://ny5-na-risk-01.corp.schonfeld.com/risk_vol1/src/barra/BarraOptimizer9.0/doc/Optimizer_User_Guide.pdf'
  ,'blah.co.uk', 'news.yahoo.co.jp', 'tsmc.com.tw', 'news.google.com', 'news.google.com.hk',
].forEach(r=> console.log(cleanDomain(r)))

export function useDebounce(value, delay=400) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => { 
    if (value==="" || value===0 ) {
      setDebouncedValue(value)
      return
    }
    const timer = setTimeout(() => setDebouncedValue(value), delay);
      return () => clearTimeout(timer) 
    }, [value, delay]);
  return debouncedValue;
}
export function extractLinksFromSelection(selection: Selection): string[] {
  const links: string[] = [];
  const range = selection.getRangeAt(0);
  const container = document.createElement("div");
  container.appendChild(range.cloneContents());

  // Find actual <a> tags
  const anchors = container.querySelectorAll("a");
  anchors.forEach(a => links.push(a.href));

  // Optional: Find plain text URLs using regex
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const textMatches = container.textContent?.match(urlRegex);
  if (textMatches) links.push(...textMatches);

  return [...new Set(links)]; // Remove duplicates
}
export function showOpenLinksButton(event: MouseEvent | TouchEvent, links: string[]) {
  // 1. Remove any existing button first
  const existingBtn = document.getElementById('floating-open-links');
  if (existingBtn) existingBtn.remove();

  // 2. Get selection coordinates
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect(); // Viewport coordinates

  // 3. Create the button
  const btn = document.createElement('button');
  btn.id = 'floating-open-links';
  btn.textContent = `Open ${links.length} link${links.length > 1 ? 's' : ''}`;
  
  // Style for 2025 modern look
  Object.assign(btn.style, {
    position: 'fixed',
    top: `${rect.top - 40 + window.scrollY}px`, // Position above selection
    left: `${rect.left + rect.width / 2}px`,
    transform: 'translateX(-50%)',
    zIndex: '9999',
    padding: '8px 12px',
    backgroundColor: '#007bff',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    boxShadow: '0 2px 5px rgba(0,0,0,0.2)'
  });

  // 4. Handle the opening logic
  const handler = () => {
    let blocked = false;
    
    links.forEach((url, index) => {
      // window.open returns null if blocked by the browser
      const newTab = window.open(url, '_blank');
      if (!newTab || newTab.closed || typeof newTab.closed === 'undefined') {
        blocked = true;
      }
    });

    if (blocked) {
      alert("Multiple links were blocked. Please enable popups for this site in your browser settings.");
    }
    
    btn.remove();
    selection.removeAllRanges();
  };
  btn.onclick = handler
  btn.onmouseup = handler
 // --- CLEANUP LOGIC: Remove button on unselect/click-away ---
  const removeOnUnselect = (e: MouseEvent | TouchEvent) => {
    if (e.target !== btn) { btn.remove();
      document.removeEventListener('mousedown', removeOnUnselect);
      document.removeEventListener('touchstart', removeOnUnselect);
    }
  };  
  setTimeout(() => {
    document.addEventListener('mousedown', removeOnUnselect);
    document.addEventListener('touchstart', removeOnUnselect);
  }, 10); // Delay slightly to prevent the current event from triggering it immediately
  
  document.body.appendChild(btn);
}
export async function ul(data:any, fileApi:any, obj_prefix: string, checksum:number) {
  let start = performance.now()
  const b2 = encZip(data)
  nowWarn(start, `ul_${obj_prefix}`,"encZip",111)
  if (b2.byteLength /1024/1025 > 50)
    console.error(`${obj_prefix} too large >50MB after cbor.encode ${(b2.byteLength/1024/1024).toFixed(3)}MB`)
  else {
    const { error } = await fileApi.upload(`${obj_prefix}.${checksum}.cbor.pako`
      , b2, {contentType: 'application/octet-stream', upsert: true})
    if (error)
      console.error(`uploading :${obj_prefix}`, error);
    else stts(`${obj_prefix} stored in ${performance.now() - start} msec`) 
  }
  nowWarn(start, `ul_${obj_prefix}`)
}
export function encZip(data: any) { return pako.gzip(cbor.encode(data))}
export function decZip(data: pako.Data) { return cbor.decode(pako.ungzip(data))}
export async function dl(fileApi:any, obj_path: string) {
  let start = performance.now()
  const res = await fileApi.download(obj_path)
  const buf = await res.data?.arrayBuffer()
  nowWarn(start, `dl`,`${obj_path}`)
  return decZip(new Uint8Array(buf ?? new Uint8Array()))
}
/**
 * Recursively merges two objects/arrays up to a specified depth.
 */
export function recMerge<T>(target: T, source: any, depth: number = Infinity): T {
  // If we hit depth 0, we perform a shallow merge (arrays/objects from source overwritten by target)
  if (depth <= 0) {
    return { ...target, ...source };
  }

  // Case 1: Both are Arrays -> Concatenate
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source] as any;
  }

  // Case 2: Both are Objects -> Recurse
  if (isObject(target) && isObject(source)) {
    const output = { ...target } as any;

    Object.keys(source).forEach((key) => {
      const targetValue = (target as any)[key];
      const sourceValue = source[key];

      if (
        (isObject(targetValue) && isObject(sourceValue)) || 
        (Array.isArray(targetValue) && Array.isArray(sourceValue))
      ) {
        // If both are objects or both are arrays, dive deeper
        output[key] = recMerge(targetValue, sourceValue, depth - 1);
      } else {
        // Otherwise (primitives or mismatched types), source wins
        output[key] = sourceValue;
      }
    });

    return output;
  }

  // Case 3: Mismatched types or primitives -> source wins
  return source;
}
const isObject = (item: any): item is Record<string, any> => {
  return item && typeof item === 'object' && !Array.isArray(item);
};
// export const pick = <T, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> =>
//   Object.fromEntries(
//     keys.filter(key => key in obj).map(key => [key, obj[key]])
//   ) as Pick<T, K> // Type 'T' is not assignable to type 'object'.ts(2322)
export function escapeXml(unsafe: string): string {
    return unsafe
        .replaceAll('&', "&amp;")
        .replaceAll('<', "&lt;")
        .replaceAll('>', "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll('\'', "&apos;")
}
export function sumArray(...numbers: number[]): number {
  return numbers.reduce((total, num) => total + num, 0);
}
export function logRet(...data: any[]) {
  console.log(data)
  return data.join('')
}
export  function sideLog(msg:string, _stuff:any, ...data:any[]) {
  console.log(msg, _stuff, data)
  return _stuff
}
export  function ifDo(stuff:unknown, cond:boolean, cb:()=>void) {
  if (cond) cb()
  return stuff
}
export function nowWarn(start: DOMHighResTimeStamp, scope:string, note='', msWarn = 333, alpha = .5) {
  const d = performance.now() - start
  if (d > msWarn)
    console.warn(`${scope} ${d.toLocaleString('en-US')} ms - ${note}`)
  const key = `log-maxTime ${scope}`
  const kl = `log-xTime ${scope}`
  if (inChrome) 
    if(chrome.storage) {
    chrome.storage.session.get(key).then(kv=> {
      if (kv && kv[key]) if (d > kv[key]) chrome.storage.session.set({[key]:d})
      })
    chrome.storage.local.get(kl).then(kv=> {
      chrome.storage.local.set({[kl]: (kv[kl] ??d) * (1-alpha) +alpha *d })
      })
  }
  return performance.now()
}
export function userAgentStr() {
  return navigator.userAgentData?.brands?.map(b => b.brand)
  .find(b => !['Not','Chromium','Mozilla'].some(p=>b.startsWith(p)) ) 
  || navigator.userAgent.match(/(\w+)\/([\d.]+)/)?.[1] || 'BrowserX'
}


export const get_weibo_posts = async (user_ids=["1402400261"], cnt=111): Promise<string[]> => {
  const results: string[] = [];
    for (const user_id of user_ids) {
      const ref = `https://m.weibo.cn/api/container/getIndex?containerid=230413${user_id}&page=1&count=${cnt}`;
      const res = await fetch(ref, { "headers": {// dev tool copy fetch(node.js)
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh-TW;q=0.7,zh;q=0.6,ja;q=0.5,es;q=0.4,fr;q=0.3,ru;q=0.2,de;q=0.1,uk;q=0.1,it;q=0.1",
        "cache-control": "max-age=0",
        "priority": "u=0, i",
        "sec-ch-ua": "\"Chromium\";v=\"142\", \"Opera\";v=\"126\", \"Not_A Brand\";v=\"99\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
        "upgrade-insecure-requests": "1",
        "cookie": "SCF=AqigtxH74D-kQ06yBD0-_eRkrLYN4LoC_gdDqn725iDDC328UA1QnDKxSeatUd6qyJQTyWNGipg3sCeVjIoT-zA.; SUB=_2A25EkqhGDeRhGedH6lAV9CnEwjyIHXVn0aWOrDV6PUJbktANLUTXkW1NUPW8e4oCGLvJ-etCNBejKlSubB5pl8bA; SUBP=0033WrSXqPxfM725Ws9jqgMF55529P9D9WFnX-7ZxAreXuIO.To0n_fv5JpX5KMhUgL.Fo24eKzXShMR1K52dJLoIEMLxK-LBK2L1K2LxKqL1KqL1K.LxKqL1h.L1-zLxK-LB-BL1KWbIg7t; SSOLoginState=1771493398; ALF=1774085398; WEIBOCN_FROM=1110006030; MLOGIN=1; _T_WM=29857790721; XSRF-TOKEN=f0b169; M_WEIBOCN_PARAMS=luicode%3D10000011%26lfid%3D2304131402400261"
      },
      "body": null,
      "method": "GET"
    })
    // console.debug(res)
    const tt = await res.text();
    // console.debug(tt.substring(0, 55)); // 如果看到 <!DOCTYPE html>，代表你被踢回登入頁了
    // console.debug(JSON.parse(tt)); // 如果看到 <!DOCTYPE html>，代表你被踢回登入頁了
    const js = JSON.parse(tt) // await res.json();
    const cards: any[] = js?.data?.cards ?? [];
    
    // Each card with card_type==9 is a weibo post; take the first one
    const latest = cards.find((c) => c.card_type === 9);
    if (latest?.mblog?.text) {
      // Strip HTML tags from text
      const text = latest.mblog.text.replace(/<[^>]+>/g, "").trim();
      results.push(`${user_id}: ${text}`);
    } else {
      results.push(`${user_id}: (no post found)`);
    }
    const randomSleep_weibo = () => {
      const ms = Math.floor(Math.random() * 3000) + 1000; // 1 to 4 seconds
      return new Promise(resolve => setTimeout(resolve, ms));
    }
    randomSleep_weibo()
  }
  return results;
}
// Generics (? lodash)
export function topFew<T>(k: number, arr: T[]
  , compare: (a: T, b: T) => number = (a: any, b: any) => a-b): T[] {
  if(k >=arr.length) return arr
  const result: T[] = arr.slice(0, k); 
  for (const item of arr) {
    result.push(item)
    result.sort((a, b) => compare(b, a));  // descending order
    // init k already // if (result.length > k) 
    result.pop();  // remove largest
  }
  return result;
}

export const diffDays = (d1, d2) => (d1-d2)/(1000 *60*60 *24)
export function fmt_ym(dt) { 
  const p=fmt2parts(dt) 
  return`${p.year}-${p.month.padStart(2,'0')}`
}
export function fmt_mdwhm(dt) { 
  const p=fmt2parts(dt) 
  return`${p.year} ${p.month.padStart(2,' ')}/${p.day.padStart(2,'0')} ${p.weekday} ${p.hour}:${p.minute}`
}
export function fmt2parts(dt) { return Object.fromEntries( new Intl.DateTimeFormat('en-US', {
    month: 'numeric', // MM
    day: '2-digit',   // dd
  year: 'numeric',
    weekday: 'short',  // ddd
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
  }).formatToParts(dt).map(({type,value})=> [type,value]))
}; // { // new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) // #,##0.##
export const fmt_md = new Intl.DateTimeFormat('en-US', { month: 'numeric', day: '2-digit', })
// //unused
// function setKVjoin(rec: Record<string,string>, arg1: string, arg2: string) {
//     rec[arg1] = arg2;
//     return Object.keys(rec).map(key => `${key}:${rec[key]}`).join('; ')
// }