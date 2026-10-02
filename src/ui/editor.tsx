// src/components/EditorSplitPane.tsx

// src/components/Chat.tsx
import { useState, useEffect, useRef } from 'react';
import { db, DEL_TAG, getLatestByRefType, shelfVer, verKey, verSnap, type Da, treeCacOpts, treeCacCurrent } from '../sdb';
import { greet } from '../greet';
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

interface ArtfactProps {
  openTabs: string[];
  activeTab: string;
  onTabChange: (activeTab: string, openTabs: string[]) => void;
}

function TagMeta({ ref }: { ref: string }) {
  const [meta, setMeta] = useState<{ dtAgo?: string, visitAgo?: string }>({});

  useEffect(() => {
    getLatestByRefType(ref).then(tag => {
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
  const [dropdownTab, setDropdownTab] = useState<string | null>(null);
  const [dropdownX, setDropdownX] = useState(0);
  const [editVal, setEditVal] = useState({ ref: '', type: '', tags: [] as string[] });
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  
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

      for (const tab of openTabs) {
        if (!newContents[tab]) {
          const tag = await getLatestByRefType(tab);
          newContents[tab] = tag?.txt ?? `// ${tab}\n// New content`;
          changed = true;
        }
      }
      if (changed) setContents(newContents);

      // Sync with server and update if changed
      greet(db.das).then(async () => {
        const current = { ...contents };
        let hasUpdates = false;
        for (const tab of openTabs) {
          const tag = await getLatestByRefType(tab);
          if (tag && tag.txt !== current[tab]) {
            current[tab] = tag.txt;
            hasUpdates = true;
          }
        }
        if (hasUpdates) setContents(current);
      });
    };
    loadContents();
  }, [openTabs]);

  const handleContentChange = (value: string) => {
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
    // await greet(db.das);
    const da = await getLatestByRefType(tab);
    if (da) {
      setEditVal({ ref: da.ref, type: da.type, tags: da.tags || [] });
    }
  };

  const saveTagMetadata = async () => {
    if (!dropdownTab) return;

    if (!editVal.ref.trim()) {
      alert('Ref cannot be empty');
      return;
    }

    // greet to sync before modifying
    await greet(db.das);

    const tag = await getLatestByRefType(dropdownTab);
    if (!tag || !tag.tid) return;

    const oldRef = tag.ref;

    if (oldRef !== editVal.ref) {
      // Rename: mark old ref row with [del], insert new row with new ref
      const delTags = [...(tag.tags || []).filter(t => t !== DEL_TAG), DEL_TAG];
      await db.das.update(tag.tid, { tags: delTags, modAt: new Date() });

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
      await db.das.update(tag.tid, {
        type: editVal.type,
        tags: editVal.tags,
        modAt: new Date(),
      });
      await greet(db.das);
    }
    setDropdownTab(null);
  };

  const saveToDb = async () => {
    if (!activeTab) return;
    const content = contents[activeTab];
    if (content === undefined) return;

    await greet(db.das);
    const tag = await getLatestByRefType(activeTab);
    if (tag && tag.tid) {
      const updateData: any = { 
        txt: content,
        modAt: new Date(),
        // shelf the pre-edit version: the exact dt copy deepMerge can later patch against
        rec: shelfVer(tag.rec, verKey(tag.dt, tag.modAt), verSnap(tag)),
      };

      await db.das.update(tag.tid, updateData);
    }
  };
  
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
            onClick={() => onTabChange(tab, openTabs)}            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                handleCloseTab(tab);
              }
            }}          >
            <span 
              className={`tab-name ${activeTab === tab ? 'active-ref' : ''}`}
              onClick={(e) => { 
                if (activeTab === tab) {
                  e.stopPropagation(); 
                  openDropdown(tab, e); 
                }
              }}
            >
              {tab.split('/').pop()}
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
              <TagMeta ref={dropdownTab} />
            </div>
            <div className="dropdown-actions">
              <button onClick={() => setDropdownTab(null)}>Cancel</button>
              <button onClick={saveTagMetadata} className="btn-save">Save</button>
            </div>
          </div>
        </div>
      )}
      
      <div className="code-editor" onBlur={saveToDb}>
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

export function EditorSplitPane({ openTabs, activeTab, sessionId, onTabChange }: EditorSplitPaneProps) {
  return (
    <div className="editor-split-pane">
      <div className="editor-container">
        <LocalErrorBoundary>
        <Artfact
          openTabs={openTabs}
          activeTab={activeTab}
          onTabChange={onTabChange}
        /></LocalErrorBoundary>
      </div>
      <div className="chat-container">
        <LocalErrorBoundary>
        <Chat sessionId={sessionId} /></LocalErrorBoundary>
      </div>
    </div>
  );
}