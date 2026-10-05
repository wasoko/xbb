// src/components/EditorSplitPane.tsx

// src/components/Chat.tsx
import { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { db, DEL_TAG, daEdit, daRead, stampTime, type Da, type VerHist, treeCacOpts, treeCacCurrent } from '../sdb';
import { consumeConflict, getConflicts, greet, softGreet, subscribeConflicts } from '../greet';
import * as fc from '../fc';
import {
  buildPromptFromNode, getStore, loadBranchingSession, parseSecrets, rcr, recrBus, SECRET_REF,
  type ChatMessage,
} from '../recr';

/** Text edit pane
 * 
 */
// src/components/Artfact.tsx
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { LocalErrorBoundary } from './ErrorBoundaryOutlet';
import { useTabSyncState } from './tabSync';
import { tabVisual, type TabSyncState } from './tabState';
import { reapplyBuffer } from './reapply';
import { DiffTab } from './diffTab';

interface ArtfactProps {
  openTabs: string[];
  activeTab: string;
  onTabChange: (activeTab: string, openTabs: string[]) => void;
}

/** Diff tabs are not rows: the tab ref carries the row ref, the history, and its stamp. */
const DIFF_PREFIX = 'diff|'
interface DiffTarget { ref: string; source: 'ver' | 'cr'; stamp: string }
/** Parse a `diff|<source>|<stamp>|<ref>` tab ref.
 * @param tab tab ref from the tab bar
 * @returns the target, or undefined when the ref names a row */
function parseDiffRef(tab: string): DiffTarget | undefined {
  if (!tab.startsWith(DIFF_PREFIX)) return undefined
  const [source, stamp, ...rest] = tab.slice(DIFF_PREFIX.length).split('|')
  if ((source !== 'ver' && source !== 'cr') || !stamp || rest.length === 0) return undefined
  return { ref: rest.join('|'), source, stamp }
}
/** The tab ref for one diff target; `encodeTabs` URL-encodes the separators. */
const diffTabRef = (t: DiffTarget) => `${DIFF_PREFIX}${t.source}|${t.stamp}|${t.ref}`
/** Tab label: a diff tab names its version, a draft reads untitled, a row shows its basename. */
function tabLabel(tab: string, draft: boolean | undefined): string {
  const d = parseDiffRef(tab)
  if (d) return `⇄ ${d.source} ${fc.fmtAgo(stampTime(d.stamp))} ${d.ref.split('/').pop()}`
  return draft ? 'untitled' : tab.split('/').pop() ?? tab
}

/** The `ver`/`cr` history of the dropdown's row: one button per version, opening the diff tab. */
function Versions({ source, rec, onPick }: {
  source: 'ver' | 'cr';
  rec: Record<string, unknown>;
  onPick: (stamp: string) => void;
}) {
  const hist = (rec[source] ?? {}) as VerHist;
  const stamps = Object.keys(hist);
  if (stamps.length === 0) return null;
  return (
    <div className="dropdown-field" style={{ display: 'block', fontSize: 11 }}>
      <div style={{ opacity: 0.75 }}>{source} ({stamps.length})</div>
      {stamps.map(stamp => (
        <button
          key={stamp}
          onClick={() => onPick(stamp)}
          title={`diff the row against this ${source === 'cr' ? 'discarded edit' : 'server version'}`}
          style={{ display: 'block', width: '100%', textAlign: 'left', fontSize: 11
            , padding: '2px 4px', cursor: 'pointer', opacity: 0.9 }}
        >
          {new Date(stampTime(stamp)).toLocaleString()} · {(hist[stamp].txt ?? '').slice(0, 40)}
        </button>
      ))}
    </div>
  );
}

function TagMeta({ ref, sync }: { ref: string, sync?: TabSyncState }) {
  const [meta, setMeta] = useState<{ dtAgo?: string, visitAgo?: string }>({});

  useEffect(() => {
    daRead(ref).then(tag => {
      if (!tag) return;
      const visitTime = (tag.rec as any)?.visitTime ?? 0;
      
      // Handle both numeric timestamp and record of timestamps
      let maxVisit = 0;
      if (typeof visitTime === 'number') {
        maxVisit = visitTime;
      } else if (visitTime && typeof visitTime === 'object') {
        const keys = Object.keys(visitTime).map(Number).filter(k => !isNaN(k));
        maxVisit = keys.length > 0 ? Math.max(...keys) : 0;
      }
      
      setMeta({
        dtAgo: tag.dt ? fc.fmtAgo(new Date(tag.dt).getTime()) : 'n/a',
        visitAgo: maxVisit > 0 ? fc.fmtAgo(maxVisit) : 'n/a'
      });
    });
  }, [ref]);

  return (
    <div className="meta-grid">
      <div className="meta-item"><span>Synced:</span> <span>{meta.dtAgo}</span></div>
      <div className="meta-item"><span>Visit:</span> <span>{meta.visitAgo}</span></div>
      {sync && (
        <div className="meta-item" style={{ display: 'block', whiteSpace: 'normal' }}>
          <span>{sync.row}:</span> <span>{sync.detail}</span>
        </div>
      )}
    </div>
  );
}

function ProviderSelector() {
  const [isOpen, setIsOpen] = useState(false);
  const [current, setCurrent] = useState(treeCacCurrent['provider-model'] || 'Default');
  
  useEffect(() => {
    setCurrent(treeCacCurrent['provider-model'] || 'Default');
  }, []);

  const options = treeCacOpts['provider-model'] || ['Default'];

  const selectOption = (opt: string) => {
    treeCacCurrent['provider-model'] = opt;
    setCurrent(opt);
    setIsOpen(false);
  };

  return (
    <div 
      className="provider-selector"
      onClick={() => setIsOpen(!isOpen)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setIsOpen(!isOpen);
        }
      }}
    >
      <span className="provider-label">{current}</span>
      {isOpen && (
        <div className="provider-dropdown">
          {options.map(opt => (
            <div 
              key={opt} 
              className={`provider-option ${opt === current ? 'selected' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                selectOption(opt);
              }}
            >
              {opt}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Artfact({ openTabs, activeTab, onTabChange }: ArtfactProps) {
  const [contents, setContents] = useState<Record<string, string>>({});
  /** Tabs with no durable row yet: the label reads "untitled" until the tab dropdown saves one. */
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  const [dropdownTab, setDropdownTab] = useState<string | null>(null);
  const [dropdownX, setDropdownX] = useState(0);
  const [editVal, setEditVal] = useState({ ref: '', type: '', tags: [] as string[] });
  /** `rec` of the dropdown's row, whose `ver`/`cr` histories the dropdown lists. */
  const [dropdownRec, setDropdownRec] = useState<Record<string, unknown>>({});
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  /** Set when the active tab is a diff tab, which has no row and no code editor. */
  const diffTarget = parseDiffRef(activeTab);
  /** Sync state of the active tab; other tabs stay unmarked. A diff tab has no row to mark. */
  const syncState = useTabSyncState(diffTarget ? '' : activeTab, contents[activeTab]);
  const activeVisual: ReturnType<typeof tabVisual> = diffTarget ? { glyph: '' } : tabVisual(syncState);
  
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownTab(null);
      }
    };

    if (dropdownTab) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dropdownTab]);

  // Initialize content for tabs
  useEffect(() => {
    const loadContents = async () => {
      const newContents = { ...contents };
      let changed = false;

      const draftNext: Record<string, boolean> = {};
      for (const tab of openTabs) {
        if (parseDiffRef(tab)) continue; // a diff tab has no row of its own
        if (!newContents[tab]) {
          const row = await daRead(tab);
          newContents[tab] = row?.txt ?? `// ${tab}\n// New content`;
          draftNext[tab] = !row;
          changed = true;
        }
      }
      if (changed) {
        setContents(newContents);
        setDrafts(prev => ({ ...prev, ...draftNext }));
      }

      // text each buffer was loaded from: the ancestor a reapply diffs the local text against
      const baselines = { ...newContents };

      // an early round, so a conflict meets a shelved ancestor instead of a stale copy
      await greet(db.das);
      const fetched: Record<string, string> = {};
      for (const tab of openTabs) {
        if (parseDiffRef(tab)) continue;
        const row = await daRead(tab);
        if (row) fetched[tab] = row.txt;
      }
      if (Object.keys(fetched).length === 0) return;
      setContents(prev => {
        const next = { ...prev };
        for (const [ref, txt] of Object.entries(fetched)) {
          const live = prev[ref];
          if (live === undefined) continue;
          // keystrokes typed while the round ran are reapplied onto the fetched text
          next[ref] = reapplyBuffer(live, baselines[ref] ?? txt, txt).txt;
        }
        return next;
      });
    };
    loadContents();
  }, [openTabs]);

  const softGreetAt = useRef(0);
  const handleContentChange = (value: string) => {
    // an early round while the user types: cheap, throttled, and it keeps an ancestor shelved
    if (Date.now() - softGreetAt.current > 5000) {
      softGreetAt.current = Date.now();
      softGreet();
    }
    setContents(prev => ({
      ...prev,
      [activeTab]: value
    }));
  };

  const openDropdown = async (tab: string, e: React.MouseEvent) => {
    if (dropdownTab === tab) {
      setDropdownTab(null);
      return;
    }
    
    // Show popup immediately to remove lag
    setDropdownTab(tab);
    setDropdownX(e.pageX);

    // greet first to get latest server/peer updates before reading
    const da = await daRead(tab);
    setEditVal(da
      ? { ref: da.ref, type: da.type, tags: da.tags || [] }
      : { ref: tab, type: 'md', tags: [] });
    setDropdownRec(da?.rec ?? {});
    softGreet();
  };

  /** Open (or focus) the diff tab for one row version, and retire its conflict notice. */
  const popDiff = (t: DiffTarget) => {
    const tab = diffTabRef(t);
    consumeConflict({ ref: t.ref, stamp: t.stamp });
    onTabChange(tab, openTabs.includes(tab) ? openTabs : [...openTabs, tab]);
  };

  // A discarded edit a greet round announced opens its diff, so the loss is visible at once.
  // Only rows already open, one per batch: a snap merge must not open a tab per row.
  const conflicts = useSyncExternalStore(subscribeConflicts, getConflicts);
  const poppedConflicts = useRef(new Set<string>());
  useEffect(() => {
    const fresh = conflicts.find(c => openTabs.includes(c.ref)
      && !poppedConflicts.current.has(`${c.ref}@${c.stamp}`));
    if (!fresh) return;
    poppedConflicts.current.add(`${fresh.ref}@${fresh.stamp}`);
    popDiff({ ref: fresh.ref, source: 'cr', stamp: fresh.stamp });
  }, [conflicts, openTabs]);

  const saveTagMetadata = async () => {
    if (!dropdownTab) return;

    if (!editVal.ref.trim()) {
      alert('Ref cannot be empty');
      return;
    }

    // greet to sync before modifying
    await greet(db.das);

    const tag = await daRead(dropdownTab);

    // Unsaved draft: the tab dropdown is its save action.
    if (!tag?.tid) {
      const draftRef = dropdownTab;
      await db.das.put({
        ref: editVal.ref,
        type: editVal.type,
        tags: editVal.tags,
        txt: contents[draftRef] ?? '',
        rec: {},
        modAt: new Date(),
      } as Da);
      await greet(db.das);

      const newTabs = openTabs.map(t => t === draftRef ? editVal.ref : t);
      const newActive = activeTab === draftRef ? editVal.ref : activeTab;
      onTabChange(newActive, newTabs);

      setDrafts(prev => {
        const next = { ...prev };
        delete next[draftRef];
        next[editVal.ref] = false;
        return next;
      });

      setDropdownTab(null);
      return;
    }

    const oldRef = tag.ref;

    if (oldRef !== editVal.ref) {
      // Rename: mark old ref row with [del], insert new row with new ref
      const delTags = [...(tag.tags || []).filter(t => t !== DEL_TAG), DEL_TAG];
      await db.das.update(tag.tid, { ...daEdit(tag, tag.txt), tags: delTags });

      // Insert new row with new ref, carrying over content
      const { tid, dt, rec, ...rest } = tag;
      await db.das.put({
        ...rest,
        ref: editVal.ref,
        type: editVal.type,
        tags: editVal.tags,
        modAt: new Date(),
      } as Da);

      // Push greet after mutation
      await greet(db.das);

      // Update tabs state
      const newTabs = openTabs.map(t => t === oldRef ? editVal.ref : t);
      const newActive = activeTab === oldRef ? editVal.ref : activeTab;
      onTabChange(newActive, newTabs);

      const url = new URL(window.location.href);
      url.searchParams.set('e', editVal.ref);
      window.history.pushState({}, '', url);
    } else {
      // Same ref — just update metadata
      await db.das.update(tag.tid, { ...daEdit(tag, tag.txt)
        , type: editVal.type, tags: editVal.tags });
      await greet(db.das);
    }
    setDropdownTab(null);
  };

  const saveToDb = async () => {
    if (!activeTab || parseDiffRef(activeTab)) return; // a diff tab has no buffer to save
    const content = contents[activeTab];
    if (content === undefined) return;

    // the row the app resolves, not the newest dt: writing onto a different row of the same ref
    // is what splits one key into two
    const row = await daRead(activeTab);
    if (!row?.tid) return;             // a draft is created by the tab dropdown save
    if (row.txt === content) return;   // nothing typed since the last write

    // replace the text and mark the row dirty; the sync side records the versions
    await db.das.update(row.tid, daEdit(row, content));
    softGreet();                       // push in the background; the edit stays usable
  };
  const saveRef = useRef(saveToDb);
  saveRef.current = saveToDb;

  /** Persist the buffer when focus leaves the editor, the pointer goes elsewhere, the page is
   *  hidden or unloaded, or typing pauses: the row write is what makes the edit durable. */
  useEffect(() => {
    const flush = () => { void saveRef.current(); };
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.('.code-editor')) flush();
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    // Page Lifecycle 'freeze' is absent from the DOM typings; EventTarget takes the name as a string
    const lifecycle: EventTarget = document;
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', flush);
    window.addEventListener('pagehide', flush);
    lifecycle.addEventListener('freeze', flush);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', flush);
      window.removeEventListener('pagehide', flush);
      lifecycle.removeEventListener('freeze', flush);
    };
  }, []);

  // a pause in typing is enough to make the edit durable
  useEffect(() => {
    const id = setTimeout(() => { void saveRef.current(); }, 2000);
    return () => clearTimeout(id);
  }, [contents[activeTab], activeTab]);
  
  const handleCloseTab = (tabToClose: string) => {
    const newTabs = openTabs.filter(t => t !== tabToClose);
    let newActive = activeTab;
    if (activeTab === tabToClose && newTabs.length > 0) {
      newActive = newTabs[0];
    } else if (newTabs.length === 0) {
      newActive = '';
    }
    onTabChange(newActive, newTabs);
  };
  
  const handleAddTab = () => {
    const newFileName = prompt('Enter file path (e.g., src/newfile.tsx):');
    if (newFileName && !openTabs.includes(newFileName)) {
      const newTabs = [...openTabs, newFileName];
      onTabChange(activeTab || newFileName, newTabs);
    }
  };
  
  if (openTabs.length === 0) {
    return (
      <div className="Artfact-empty">
        <p>No files open</p>
        <button onClick={handleAddTab} className="add-tab-btn">+ Open File</button>
      </div>
    );
  }
  
  return (
    <div className="Artfact-container">
      <div className="tab-bar" style={{ position: 'relative' }}>
        {openTabs.map(tab => (
          <div
            key={tab}
            className={`tab ${activeTab === tab ? 'active' : ''}`}
            style={activeTab === tab ? activeVisual.tabStyle : undefined}
            title={activeTab === tab ? activeVisual.title : undefined}
            onClick={() => onTabChange(tab, openTabs)}            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                handleCloseTab(tab);
              }
            }}          >
            <span 
              className={`tab-name ${activeTab === tab ? 'active-ref' : ''}`}
              style={activeTab === tab
                ? { ...(drafts[tab] ? { color: '#888' } : {}), ...activeVisual.labelStyle }
                : drafts[tab] ? { color: '#888' } : undefined}
              onClick={(e) => { 
                if (activeTab === tab && !parseDiffRef(tab)) {
                  e.stopPropagation(); 
                  openDropdown(tab, e); 
                }
              }}
            >
              {activeTab === tab && activeVisual.glyph ? activeVisual.glyph + ' ' : ''}
              {tabLabel(tab, drafts[tab])}
              {activeTab === tab && activeVisual.badge && (
                <span style={{ marginLeft: 4, fontSize: 10, padding: '0 3px', borderRadius: 6
                  , background: 'rgba(245, 158, 11, 0.35)' }}>{activeVisual.badge}</span>
              )}
            </span>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                handleCloseTab(tab);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button onClick={handleAddTab} className="new-tab-btn">+</button>
      </div>
      
      {dropdownTab && (
        <div 
          ref={dropdownRef}
          className="tab-dropdown-portal" 
          style={{ left: `${dropdownX}px` }}
        >
          <div className="tab-dropdown-content">
            <div className="dropdown-field">
              <input 
                value={editVal.ref} 
                onChange={e => setEditVal(p => ({...p, ref: e.target.value}))} 
                style={{flexGrow:1}}
              />
            </div>
            <div className="dropdown-field" style={{flexDirection:'row', alignItems:'center', gap:'8px'}}>
              <select 
                value={editVal.type} 
                onChange={e => setEditVal(p => ({...p, type: e.target.value}))}
                style={{width:'60px'}}
              >
                <option value="src">src</option>
                <option value="md">md</option>
              </select>
              <div style={{display:'flex', gap:'4px', flexWrap:'nowrap', overflowX:'auto', alignItems:'center'}}>
                {editVal.tags.map((s, i) => (
                  <input 
                    key={i} 
                    value={s} 
                    style={{width:'50px'}}
                    onChange={e => {
                      const next = [...editVal.tags];
                      next[i] = e.target.value;
                      setEditVal(p => ({...p, tags: next}));
                    }} 
                  />
                ))}
                <button 
                  onClick={() => setEditVal(p => ({...p, tags: [...p.tags, '']}))}
                  style={{fontSize:'10px', padding:'0 4px', cursor:'pointer'}}
                >+</button>
                {editVal.tags.length > 0 && (
                  <button 
                    onClick={() => setEditVal(p => ({...p, tags: p.tags.slice(0, -1)}))}
                    style={{fontSize:'10px', padding:'0 4px', cursor:'pointer'}}
                  >×</button>
                )}
              </div>
            </div>
            <div className="dropdown-meta">
              <TagMeta ref={dropdownTab} sync={syncState} />
            </div>
            <Versions source="ver" rec={dropdownRec}
              onPick={stamp => { setDropdownTab(null)
                ; popDiff({ ref: dropdownTab!, source: 'ver', stamp }) }} />
            <Versions source="cr" rec={dropdownRec}
              onPick={stamp => { setDropdownTab(null)
                ; popDiff({ ref: dropdownTab!, source: 'cr', stamp }) }} />
            <div className="dropdown-actions">
              <button onClick={() => setDropdownTab(null)}>Cancel</button>
              <button onClick={saveTagMetadata} className="btn-save">Save</button>
            </div>
          </div>
        </div>
      )}
      
      {diffTarget ? (
        <DiffTab
          refName={diffTarget.ref}
          source={diffTarget.source}
          stamp={diffTarget.stamp}
          onApplied={(ref, txt) => setContents(prev => ({ ...prev, [ref]: txt }))}
        />
      ) : (
        <div className="code-editor" onBlur={saveToDb} onFocus={() => softGreet()}>
          <CodeMirror
            value={contents[activeTab] || ''}
            onChange={handleContentChange}
            extensions={
              (() => {
                if (!activeTab) return [];
                if (activeTab.endsWith('.md')) return [markdown()];
                if (/\.(ts|tsx|js|jsx)$/.test(activeTab)) return [javascript({ jsx: true })];
                return [];
              })()
            }
            theme={oneDark}
            height="100%"
            basicSetup={{
              lineNumbers: true,
              highlightActiveLineGutter: true,
              foldGutter: true,
              dropCursor: true,
              allowMultipleSelections: true,
              indentOnInput: true,
            }}
          />
        </div>
      )}
    </div>
  );
}


/** Chat pane, driven by the recr agentic loop.
 */
interface ChatProps {
  sessionId: string;
}

/** One rendered line of the transcript. */
interface Bubble {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'error';
  content: string;
  timestamp: number;
}

/** Messages from a stored branch, in the order the model saw them. */
function toBubbles(messages: ChatMessage[]): Bubble[] {
  const out: Bubble[] = [];
  messages.forEach((m, i) => {
    const id = `${m.role}-${i}`;
    if (m.role === 'user' || m.role === 'system') return;
    if (m.role === 'assistant') {
      if (m.content) out.push({ id, role: 'assistant', content: m.content, timestamp: Date.now() });
      return;
    }
    out.push({ id, role: 'tool', content: m.content.slice(0, 400), timestamp: Date.now() });
  });
  return out;
}

export function Chat({ sessionId }: ChatProps) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('ready');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const seq = useRef(0);
  /** Bubble keys must stay unique: a tool round can land in the same millisecond. */
  const nextId = (prefix: string) => `${prefix}-${++seq.current}`;

  // Model identity for the header; a missing secret.md is what stops a send
  useEffect(() => {
    let live = true;
    parseSecrets(getStore())
      .then(c => { if (live) setStatus(`${c.providerName ?? 'provider'} · ${c.model}`); })
      .catch((e: unknown) => {
        if (live) setStatus(`no ${SECRET_REF}: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => { live = false; };
  }, [sessionId]);

  // Rehydrate the branch from the store: `sess/{id}/node/*` rows, not localStorage
  useEffect(() => {
    let live = true;
    setBubbles([]);
    setStreaming('');
    (async () => {
      const store = getStore();
      const session = await loadBranchingSession(store, sessionId);
      const messages = session.currentHeadId
        ? await buildPromptFromNode(session.currentHeadId, session, store, '', [])
        : [];
      if (live) setBubbles(toBubbles(messages));
    })();
    return () => { live = false; };
  }, [sessionId]);

  // Live tool activity for this session. Errors are not taken from here: `rcr`
  // rethrows to the caller below, so a bus error would double-report the same failure.
  useEffect(() => recrBus.on(msg => {
    if (msg.sessionId !== sessionId) return;
    if (msg.kind === 'recr-tool-call') setStatus(`calling ${msg.toolName}…`);
    else if (msg.kind === 'recr-tool-result') setBubbles(prev => [...prev, {
      id: nextId('tool'), role: 'tool', content: msg.result, timestamp: Date.now(),
    }]);
  }), [sessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [bubbles, streaming]);

  const sendMessage = async () => {
    const prompt = input.trim();
    if (!prompt || busy) return;

    setInput('');
    setBusy(true);
    setStreaming('');
    setBubbles(prev => [...prev, {
      id: nextId('user'), role: 'user', content: prompt, timestamp: Date.now(),
    }]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const result = await rcr({
        prompt,
        sessionId,
        abortSignal: ctrl.signal,
        onProgress: text => setStreaming(prev => prev + text),
      });
      const reply = result.finalNode.assistantResponse?.content;
      setBubbles(prev => [...prev, {
        id: `assistant-${result.finalNode.id}`,
        role: 'assistant',
        content: reply ?? '(no text)',
        timestamp: Date.now(),
      }]);
      setStatus('ready');
    } catch (e) {
      // A stop is not a failure: the user asked for it
      const stopped = e instanceof DOMException && e.name === 'AbortError';
      if (!stopped) {
        setBubbles(prev => [...prev, {
          id: nextId('error'), role: 'error',
          content: e instanceof Error ? e.message : String(e), timestamp: Date.now(),
        }]);
      }
      setStatus(stopped ? 'stopped' : 'failed');
    } finally {
      setStreaming('');
      setBusy(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  return (
    <div className="chat-container">
      <div className="chat-header">
        <h3>Agent {sessionId}</h3>
        <div className="message-time">{status}</div>
      </div>

      <div className="chat-messages">
        {bubbles.map(b => (
          <div key={b.id} className={`message ${b.role === 'error' ? 'assistant' : b.role}`}>
            <div className="message-avatar">
              {b.role === 'user' ? '👤' : b.role === 'tool' ? '🔧' : b.role === 'error' ? '⚠️' : '🤖'}
            </div>
            <div className="message-content">
              <div className="message-text" style={b.role === 'tool'
                ? { fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap' }
                : { whiteSpace: 'pre-wrap' }}>{b.content}</div>
              <div className="message-time">{new Date(b.timestamp).toLocaleTimeString()}</div>
            </div>
          </div>
        ))}
        {streaming && (
          <div className="message assistant">
            <div className="message-avatar">🤖</div>
            <div className="message-content">
              <div className="message-text" style={{ whiteSpace: 'pre-wrap' }}>{streaming}</div>
            </div>
          </div>
        )}
        {busy && !streaming && (
          <div className="message assistant">
            <div className="message-avatar">🤖</div>
            <div className="message-content">
              <div className="typing-indicator">{status}</div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
          placeholder="Ask about your code..."
          className="chat-input"
          disabled={busy}
        />
        <ProviderSelector />
        <button onClick={busy ? stop : sendMessage} className="send-btn">
          {busy ? 'Stop' : 'Send'}
        </button>
      </div>
    </div>
  );
}

interface EditorSplitPaneProps {
  openTabs: string[];
  activeTab: string;
  sessionId: string;
  onTabChange: (activeTab: string, openTabs: string[]) => void;
}

/**
 * Editor pane over the chat pane, with a draggable divider and the editor
 * dropped entirely (chat at full height) while no tab is open.
 */
export function EditorSplitPane({ openTabs, activeTab, sessionId, onTabChange }: EditorSplitPaneProps) {
  const [editorPct, setEditorPct] = useState(66);
  const [dragging, setDragging] = useState(false);
  const paneRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const box = paneRef.current?.getBoundingClientRect();
      if (!box || box.height === 0) return;
      const pct = ((e.clientY - box.top) / box.height) * 100;
      setEditorPct(Math.min(85, Math.max(20, pct)));
    };
    const stop = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stop);
    };
  }, [dragging]);

  const hasTabs = openTabs.length > 0;

  return (
    <div className="editor-split-pane" ref={paneRef}>
      {hasTabs && (
        <>
          <div className="editor-container" style={{ flex: `0 0 ${editorPct}%` }}>
            <LocalErrorBoundary>
            <Artfact
              openTabs={openTabs}
              activeTab={activeTab}
              onTabChange={onTabChange}
            /></LocalErrorBoundary>
          </div>
          <div
            className="resize-handle"
            style={{ flex: '0 0 auto', width: '100%', height: 6, cursor: 'row-resize' }}
            onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
          />
        </>
      )}
      <div className="chat-container">
        <LocalErrorBoundary>
        <Chat sessionId={sessionId} /></LocalErrorBoundary>
      </div>
    </div>
  );
}