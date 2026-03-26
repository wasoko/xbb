import React, { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { motion, PanInfo } from 'framer-motion';
import { useLiveQuery } from 'dexie-react-hooks';
// import * as yake from 'yake-wasm'
import {  flexRender,createColumnHelper,useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  SortingState,
} from '@tanstack/react-table'; // ColumnDef,ColumnFiltersState,getFilteredRowModel,
import * as idb from './idb'
import { markdown2tab, md2tag, sideLog, str2tag, stts, useDebounce } from './fc';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { sbg, subRt, upsRt } from './sub';
import {DragTag} from './dragTag';
// import { MinimalTextRank, textRankRobust } from '../textrank';
// Define the shape of your data
interface HiRow { txt: string; ref?:string; sts?: string[]; locTid?:number}
// input: h in [0,360] and s,v in [0,1] - output: r,g,b in [0,1]
function hsl2rgb(h,s,l) 
{ // https://stackoverflow.com/a/54014428/1773507
  let a= s *Math.min(l, 1-l);
  let f= (n:number ,k=(n +h /30) %12) => Math.floor(256* ( l - a *Math.max(Math.min(k-3 ,9-k ,1),-1) ))
  // return [f(0),f(8),f(4)];
  const toHex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `#${toHex( f(0))}${toHex( f(8))}${toHex( f(4))}`
}   
const getColorChar11 = (phrase: string) => {
  const hash = phrase.split('').slice(0,11).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  //const colors = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#ffeead'];
  return hsl2rgb(hash%360, .8, .2) //colors[hash % colors.length];
};
function useLiveTop(){
  return useLiveQuery( async()=> await idb.db.tags.where('type').anyOf(['topTag']).toArray()
  , [], [])
}
// Custom React hook that provides a live-updating array of rows
// based on the given tags and search parameters.
// It automatically re-queries and updates whenever:
// - The parameters (tags or search) change
// - Relevant data in the database changes
function useHiRows(search:string,filters:string[],tidNum?:number, tidLoc?:any) {
  return useLiveQuery(
    async () => {
      // 1. Start with the most restrictive indexed field
      let query = idb.db.tags.toCollection();
      let str2tid = Number(tidLoc)
      if (str2tid) tidNum = str2tid
      // 2. Filter by tags (using index if 'tags' is a MultiEntry index)
      if (filters.length > 0) {
        query = idb.db.tags.where('sts').equals(filters[0])
        .filter(row=> filters.every(t=> row.sts?.includes(t)));
      } 
      if (search!=="") query = query  // js custom scan (no index)
        .and(row => {
          // All selected tags must be present (AND logic)
          const matchesTags = row.sts ? false : row.sts?.includes(search);
          // Text search in 'txt' field (case-insensitive)
          const rowText = row.txt.toLowerCase();
          const terms = (search.match(/"[^"]*"|[^\s]+/g) || [])
            .map(str => str.replace(/^"|"$/g, '').trim().toLowerCase())
          const matchesSearch = terms.every(term => rowText.includes(term));
          return matchesTags || matchesSearch;
        })
      else if (tidNum==-1) 
        return sideLog('live 555',await query.reverse().limit(222).toArray()) satisfies HiRow[]
      else if (tidNum) 
        return (await idb.getRowsAroundTid(tidNum, 33)) satisfies HiRow[]
      // 3. Apply secondary filters (full AND for tags + text search)
      const res = await query.reverse().limit(555).toArray()
      return res.map(t=>({txt:t.txt, sts:t.sts, ref:t.ref, locTid:t.tid})satisfies HiRow)
    },  [search,filters,tidNum], [] //re-run when tags or search change, default [] empty prevent undefined
  );
}

// ──────── Highlighted text (unchanged) ────────
function HighlightedText ({ txt, sts, ref, locTid, ...fs }:{ 
  txt: string, sts: string[], ref: string, locTid?:number
  , locFn:(tid:number)=>void, navTag:(tag:string)=>void }) {
  // if (!sts.length) return <>{txt}</>;
  const escaped = sts.sort((a,b)=>b.length-a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  
  const txtElem = (<div>{sts.length==0? txt : txt.split(regex).map((part, i) =>
        regex.test(part) ? (<span style={{ 
          backgroundColor: getColorChar11(part),color: 'white' 
          , cursor: 'default', margin: '0 2px', borderRadius: '4px', padding: '2px 6px'
            }} key={i} onClick={()=>{fs.navTag(ref)}}> {part} </span>) : (<span key={i}>{part}</span>)  )}</div>)
  const matchedSts = new Set(txt.match(regex)?.map(m => m.toLowerCase()) || []);
  const unmatchedSts = sts.filter(s => !matchedSts.has(s.toLowerCase()));
  const commonStyle: React.CSSProperties = { display: 'inline-block',
    cursor: 'default', margin: '0 2px', borderRadius: '4px', padding: '2px 6px',
  };
  const tagElem = (<div> {unmatchedSts.map((part, i) => ( <span key={`unmatched-${i}`} style={{ 
          ...commonStyle,  border: `2px solid ${getColorChar11(part)}`, 
          backgroundColor: 'transparent', }}> {part} </span>))}</div>)
  const isSwapped = true

  return ( <div style={{display:'flex', flexDirection: 'row', overflowX: 'hidden',}}> {locTid && <button onClick={()=>{fs.locFn(locTid)}}>...</button>}
    {locTid && <a title="locate popup..." href={`/?tid=${locTid}`}> </a>}
    {tagElem} {txtElem}
    <Link to={ref}>🔗</Link></div>);
};
const MSG_CROSS = '🗙 (drop)'
export function ListTx({ups}) {
  const [search, setSearch] = useState('');
  const [tidNum, set_tidNum] = useState(-1);
  const [showEditTag, set_showEditTag] = useState(false)
  const [tag2edit, set_tag2edit] = useState<idb.Tag>()
  const { '*': currentTagsPath } = useParams<{ '*': string }>();
  const [searchParams] = useSearchParams();
  const tidLoc = useMemo( ()=>searchParams.get('tid'), [searchParams])
  const selectedTags = useMemo(() => 
    currentTagsPath?.split('/').filter(Boolean) || []
  , [currentTagsPath]);
  const navigate = useNavigate();  
  const [sorting, setSorting] = useState<SortingState>([]);
  const debSearch = useDebounce(search)
  const rows = useHiRows(debSearch, selectedTags, tidNum, tidLoc);
  const ttag = useLiveQuery( async()=> 
    (await idb.db.tags.where('type').anyOf(['topTag','tag']).sortBy('dt')).map(t=>t.ref)
  , [], [])
  function loc(tid:number) {setSearch(""); set_tidNum(tid);  navigate('/')}
  const columns =  // createColumnHelper<HiRow>()
  useMemo(() => [createColumnHelper<HiRow>().accessor('txt', {
        cell: ({ row }) => (
          <HighlightedText txt={row.original.txt} sts={row.original.sts??[]}
          ref={row.original.ref} locTid={row.original.locTid} locFn={loc} 
          navTag={(tag)=>navigate('/'+tag)}/>
        ), }),], [debSearch, selectedTags, tidNum]);
  async function addTag(str:string){
    if (selectedTags.includes(str))return
    let t = await idb.db.tags.get({ref:str, type:'tag'})
    if (!t) {
      t={ref:str, type:'tag', txt:str+`: `, sts:[str], dt:new Date()}
      idb.db.tags.add(t)
      t = await idb.db.tags.get({ref:str, type:'tag'})
      ups([t])
    }
    navigate(str)
  }
  async function editTag(item:string, ) {
    if (showEditTag && tag2edit?.ref===item)
      set_showEditTag(false)
    else {
      let t = await idb.db.tags.get({ref:item, type:'tag'})
      if (!t) stts(`tag missing from indexDB`)
      set_tag2edit(t)
      set_showEditTag(true)
    }
  }
  function repTag(item:string, prev:string) {
    if (selectedTags.includes(item))return
    navigate('/'+(item===MSG_CROSS ? selectedTags : selectedTags.concat(item))
      .filter(s=>s!==prev).join('/'))
  }
  // Handler for Ctrl+V (Keyboard Paste)
  function handlePaste(event: ClipboardEvent){
    const pastedText = event.clipboardData?.getData('text/plain');
    if (!pastedText) return stts('cannot read pasted text')
    const ts = markdown2tab(pastedText).map(m=> ({type:'tab',txt:m.txt
      , ref:m.ref, sts:['markdown_pasted', ...m.sts], dt:new Date() })satisfies idb.Tag)
    if (ts.length===0) return stts('no markdown [title](url) in '+pastedText.slice(0,33)+'...')
    idb.db.tags.bulkPut(sideLog('bulkput...',ts)).then(()=> 
      stts(`${ts.length} urls saved.`))
  }
  useEffect(()=> {
    const isNotGitHub = !window.location.origin.endsWith('.github.io');
    if (isNotGitHub && window.location.pathname.startsWith('/xbb/'))
      navigate(`/${currentTagsPath || ''}${window.location.search}`, { replace: true })

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [])
  const table = useReactTable({
    data:rows,
    columns,
    state: {
      sorting,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  return ( <div style={{ height:'100%', display:'flex', flexDirection:'column'  }}>  {/* Table WebkitOverflowScrolling: 'touch',*/}
      <div  style={{ overflowX:'auto', display: 'flex', flexDirection: 'row', flexShrink:0, gap: '10px'}}>
        {showEditTag ? <div style={{flexGrow:1, display:'flex', alignItems:'center'}}>{tag2edit && tag2edit.ref+':'} 
          <input type="text" style={{flexGrow:1, minWidth:'111px', maxWidth:'88vw', fieldSizing:'content', width:'auto'}} // TODO auto expand to vw
          value={search} placeholder='(related tags) tag1 tag2 "tag 3" '
          // onChange={e => setSearch(e.target.value)}
          onKeyDown={e=> {
            if(e.key==='Escape') set_showEditTag(false)
            if(e.key!=='Enter' && tag2edit)
              idb.db.tags.put({...tag2edit,...str2tag(e.currentTarget.value)})
            .then(async pk=> upsRt([await idb.db.tags.get(pk)],sbg, (await idb.tid_last()) ??1 ) )
          }} /> </div>
          :
          <input type="text" style={{flexGrow:1, minWidth:'111px', maxWidth:'88vw', fieldSizing:'content', width:'auto'}}
          value={search} placeholder="Search... (Enter to tag, Down for history)"
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e=> {
            if(e.key!=='Enter') return
            if(rows.length==0) return
            addTag(e.currentTarget.value)
            e.currentTarget.value = ''
          }} />}
        <div style={{display:'flex', flexDirection:'row', gap: '15px'}}>
          {selectedTags.map(selTag =>
            <DragTag current={selTag} key={selTag} options={[MSG_CROSS,...ttag]}
             onSelect={repTag} onLeft={editTag} canReplace={true} drag={"x"}/>
                )} <DragTag current='&#128161;' options={ttag} onSelect={(i, p)=> addTag(i)} />
                <DragTag current='&#x2795;' options={ttag} onSelect={(i, p)=> addTag(i)} />
            </div> 
      </div>
      <div style={{overflowX: 'hidden', }}><table>
      <tbody>{table.getRowModel().rows.map(row => (
        <tr key={row.id}>{row.getVisibleCells().map(cell => (
          <td key={cell.id}> {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </td>
        ))}</tr>
      ))}</tbody></table></div> </div>
  );
}
