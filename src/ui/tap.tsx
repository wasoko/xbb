// src/components/BottomIconBar.tsx
import React, { useState, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import * as li from 'lucide-react'
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { sess, signinGoogle, sbg, greet,greeter, fmtSyncCnt, getGreetStat, subscribeGreetStat } from '../greet';
import * as idb from '../sdb';
import * as fc from '../fc';
import { toast } from 'sonner';
import { NotificationDropdown } from './notice';
import { upSnap } from '../greet';
import { Drag } from './drag';
import { useAvailableFilters } from './filterStore';
import { remark2tagged } from './remark-list';
import * as CredUnlock from '../credUnlock';
import { REST_GROUPER_PREFIX } from './restGrouper';
import { MAX_QUERY_TAGS, revertTagUpdates, tagRowsWithQuery, tagRowsWithTags } from './tagApply';
import { tagRowsInteractive, tokenize } from '../srctag';
import { restTagStore, type RestTagHint } from './restGrouper';

export function TapBar() {
  const BTN_SIZE = 33;

  const navigate = useNavigate();
  const location = useLocation();
  
  const isSea = location.pathname === '/';
  const isTabs = location.pathname === '/tabs';
  
  return (
    <aside style={{ display: 'flex', flexDirection: 'column', gap: '10px', position: 'fixed', left: '20px', top: '50%', transform: 'translateY(-50%)', zIndex: 10 }}>
      <button title='Tabs' className={isTabs ? 'selected' : ''} onClick={() => navigate(isTabs ? '/' : '/tabs')}>
        <li.Sheet size={BTN_SIZE} />
      </button>
      {/* <button title="Set" className={location.pathname === '/setup' ? 'selected' : ''} onClick={() => navigate('/setup')}>
        ⚙️
      </button> */}
    </aside>
  );
}

export function FilterBar() {
  const [searchParams, setSearchParams] = useSearchParams();
  const availableFilters = useAvailableFilters();
  
  const activeFilters = searchParams.get('f')?.split(',') || [];

  const updateParams = (nextFilters: string[]) => {
    setSearchParams((prev) => {
      if (nextFilters.length === 0) {
        prev.delete('f');
      } else {
        prev.set('f', nextFilters.join(','));
      }
      return prev;
    });
  };

  const updateFilter = (index: number, newValue: string) => {
    const next = [...activeFilters];
    next[index] = newValue;
    updateParams(next);
  };

  const removeFilter = (index: number) => {
    updateParams(activeFilters.filter((_, i) => i !== index));
  };

  const addFilter = (val:string) => {
    updateParams([...activeFilters, val]);
  };

  return (
    <div className="filter-bar">
      {activeFilters.map((filter, i) => (
        <Drag 
          key={i} 
          current={filter} 
          options={availableFilters} 
          onSelect={(val) => updateFilter(i, val)} 
          onLeft={() => removeFilter(i)}
          canReplace={true}
        />
      ))}
      <Drag 
        current={'+'}
        canReplace={false}
        onSelect={(val)=> addFilter(val)} 
        options={availableFilters}
        // className="relative z-30 w-8 h-8 rounded-full border border-white text-white flex items-center justify-center cursor-pointer"
      >
        {/* <li.Plus size={18} /> */}
      </Drag>
    </div>
  );
}

export function CreateBar() {
  const handle_paste_md = async () => {
    const code = 'paste_md';
    try {
      await greet(idb.db.das);
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        toast.error('clipboard empty', { description: code });
        return;
      }
      const tags = remark2tagged(text, [code], 0);
      const ref = code + fc.fmt_ymddHMS(new Date());
      tags.forEach(t => t.ref = ref);
      await idb.db.das.bulkPut(tags);
      toast.success(`${code} ${tags.length} md block(s)`, { description: code });
      await greet(idb.db.das);
    } catch (err) {
      console.error(code + ':', err);
      toast.error(`err ${code}: ${err}`, { description: code });
    }
  };

  return (
    <div style={{ position: 'fixed', bottom: '55px', right: '20px', zIndex: 22, display: 'flex', justifyContent: 'flex-end', pointerEvents: 'none' }}>
        <div className="user-menu-container">
          <div className="user-avatar" onClick={handle_paste_md}>
            <li.Clipboard size={20} />
          </div>
        </div>
      </div>
  );
}

/** Determinate progress arc over an avatar: `frac` of the circle is drawn. The ring never takes
 *  pointer events, so the avatar keeps its own hit area. */
function SyncRing({ color, frac }: { color: string; frac: number }) {
  const C = 2 * Math.PI * 18;                       // circumference at r=18
  const shown = Math.max(0.02, Math.min(1, frac));
  return (
    <svg viewBox="0 0 40 40" style={{ position: 'absolute', left: 11, top: 11, width: 40, height: 40, pointerEvents: 'none' }}>
      <circle cx="20" cy="20" r="18" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="2.5" />
      <circle cx="20" cy="20" r="18" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={C} strokeDashoffset={C * (1 - shown)} transform="rotate(-90 20 20)" />
    </svg>
  );
}

/** Compact duration for the step list. */
const fmtMs = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`

/** How many suggestions zone B shows. */
const MAX_HINTS = 3;

/**
 * Omnibox-style live search: a transparent outlined box whose dropdown lists `iq` rows
 * whose `ref` (the saved url/filename) or `txt` contains the query. Up/Down move the
 * highlight, Enter opens the highlighted row in the editor, Escape closes the list.
 *
 * Focusing the empty box shows two zones: the tags `srctag` would add to the rows the rest
 * list scored (click applies them), then the store's most used tags (click searches them).
 * Typing replaces both with the live matches.
 */
function SearchOmnibox({ onOpen }: { onOpen: (ref: string) => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [hints, setHints] = useState<RestTagHint[]>([]);
  const [recentTags, setRecentTags] = useState<{ tag: string; count: number }[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /* One query per typing burst. */
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 180);
    return () => clearTimeout(t);
  }, [q]);

  /** Live `iq` matches on `ref` or `txt`; dexie re-runs this on every `db.das` change. */
  const rows = useLiveQuery(
    async () => {
      if (!debounced) return [] as idb.Da[];
      const needle = debounced.toLocaleLowerCase();
      const all = await idb.iq([]);
      return all
        .filter((r) => r.ref.toLocaleLowerCase().includes(needle)
          || r.txt.toLocaleLowerCase().includes(needle))
        .slice(0, 12);
    },
    [debounced],
    [] as idb.Da[],
  ) ?? [];
  const hiIdx = rows.length === 0 ? -1 : Math.min(hi, rows.length - 1);

  /** Query tokens become priority tags; a long query would drown each row's own terms. */
  const queryTags = useMemo(
    () => [...new Set(tokenize(debounced))].slice(0, MAX_QUERY_TAGS),
    [debounced],
  );

  /** Tag the picked rows with the query's tokens, add-only, and offer the revert. */
  const tagPicked = async (picked: idb.Da[]) => {
    setOpen(false);
    try {
      const { rows: n, tags, undo } = await tagRowsWithQuery(picked, debounced);
      if (n === 0) {
        toast.info('nothing to tag', { description: 'no query term to tag with' });
        return;
      }
      toast.success(`tagged ${n} row(s)`, {
        description: tags.map((t) => `#${t}`).join(' '),
        action: { label: 'Revert', onClick: () => { void revertTagUpdates(undo); } },
      });
    } catch (e) {
      toast.error(`tag failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Apply a suggested tag to the recent rows that support it, add-only, with a revert. */
  const applyHint = async (hint: RestTagHint) => {
    setOpen(false);
    try {
      const { rows: n, tags, undo } = await tagRowsWithTags(hint.rows, [hint.tag], { src: 'suggest' });
      if (n === 0) {
        toast.info('nothing to tag', { description: `no recent row fits #${hint.tag}` });
        return;
      }
      toast.success(`tagged ${n} row(s)`, {
        description: tags.map((t) => `#${t}`).join(' '),
        action: { label: 'Revert', onClick: () => { void revertTagUpdates(undo); } },
      });
    } catch (e) {
      toast.error(`tag failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * Zone B from the rest list's own `srctag` pass, which `CardTab` publishes into
   * {@link restTagStore} whatever the grouper is; the newest-row scan below is only
   * the fallback for the tick before that pass first resolves.
   */
  useEffect(() => {
    const push = () => {
      const ranked = restTagStore.rank(MAX_HINTS);
      if (ranked.length > 0) setHints(ranked);
    };
    push();
    return restTagStore.subscribe(push);
  }, []);

  /**
   * Zone A from `availableDas`, and the fallback Zone B when no rest pass exists yet.
   */
  const refreshHints = async () => {
    try {
      const all = await idb.iq([]);
      const crumbs = idb.availableDas(all).slice(0, 5);
      setRecentTags(crumbs.map((c) => ({ tag: c.tag, count: c.count })));
      if (restTagStore.size > 0) return;
      const recent = all.slice(0, 8);
      if (recent.length === 0) {
        setHints([]);
        return;
      }
      const known = crumbs.length > 0;
      const res = await tagRowsInteractive(recent, recent.map((r) => r.tid as number), {
        priorityTags: crumbs.map((c) => c.tag),
        score: { topK: 3, minScore: 0.15 },
      });
      const byTag = new Map<string, RestTagHint>();
      for (const r of res) {
        // `srctag` sorts by its window dimension, so resolve the stored row by tid
        const row = recent.find((x) => x.tid === r.row.tid);
        if (!row) continue;
        for (const s of r.suggestions) {
          // without a known vocabulary, only a strong lexical hit is worth suggesting
          if (known && s.parts.priority === 0) continue;
          if (row.tags?.includes(s.tag)) continue;
          const hit = byTag.get(s.tag);
          if (hit) {
            hit.rows.push(row);
            hit.score = Math.max(hit.score, s.score);
          } else {
            byTag.set(s.tag, { tag: s.tag, rows: [row], score: s.score });
          }
        }
      }
      setHints([...byTag.values()]
        .sort((a, b) => b.rows.length - a.rows.length || b.score - a.score)
        .slice(0, MAX_HINTS));
    } catch (e) {
      console.error('srctag hints failed:', e);
      setHints([]);
    }
  };

  useEffect(() => { setHi(0); }, [debounced]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  const handleOpen = (ref: string) => { onOpen(ref); setOpen(false); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(i + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); const row = rows[hiIdx]; if (row) void tagPicked([row]); }
    else if (e.key === 'Enter') { const row = rows[hiIdx]; if (row) handleOpen(row.ref); }
    else if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); }
  };

  return (
    <div ref={rootRef} className="user-menu-container" style={{ alignSelf: 'center', marginLeft: 11, flex: '0 1 auto', minWidth: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, height: 40, padding: '0 12px',
        width: 198, maxWidth: '100%', minWidth: 0, boxSizing: 'border-box',
        borderRadius: 20, background: 'transparent', border: '1px solid rgba(255,255,255,0.2)',
        backdropFilter: 'blur(10px)', transition: 'all 0.2s',
      }}>
        <li.Search size={16} color="rgba(255,255,255,0.7)" />
        <input
          ref={inputRef}
          type="search"
          value={q}
          aria-label="Search"
          placeholder="Search"
          spellCheck={false}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => { setOpen(true); void refreshHints(); }}
          onKeyDown={onKeyDown}
          style={{ flex: '1 1 auto', minWidth: 0, margin: 0, padding: 0, background: 'transparent', border: 'none', outline: 'none', color: 'white', fontSize: 13 }}
        />
      </div>
      {open && (debounced.length > 0 || hints.length > 0 || recentTags.length > 0) && (
        <div className="user-dropdown" style={{ left: 0, right: 'auto', top: 48, minWidth: '100%', width: 'max(100%, 300px)', maxWidth: 'calc(100vw - 30px)' }}>
          {debounced.length === 0 && hints.length > 0 && (
            <div className="user-dropdown-item" style={{ opacity: 0.5, fontSize: 11 }}>suggested</div>
          )}
          {debounced.length === 0 && hints.map((h) => (
            <button
              key={`sug-${h.tag}`}
              className="user-dropdown-item"
              title={`tags the recent row(s) this fits`}
              onClick={() => void applyHint(h)}
            >
              <span style={{ fontWeight: 600 }}>#{h.tag}</span>
              <span style={{ fontSize: 11, opacity: 0.55 }}> {h.rows.length} row(s) · {h.score.toFixed(2)}</span>
            </button>
          ))}
          {debounced.length === 0 && recentTags.length > 0 && (
            <div className="user-dropdown-item" style={{ opacity: 0.5, fontSize: 11 }}>recent tags</div>
          )}
          {debounced.length === 0 && recentTags.map((t) => (
            <button
              key={`recent-${t.tag}`}
              className="user-dropdown-item"
              title="search this tag"
              onClick={() => { setQ(t.tag); setOpen(true); inputRef.current?.focus(); }}
            >
              <span style={{ opacity: 0.8 }}>#{t.tag}</span>
              <span style={{ fontSize: 11, opacity: 0.5 }}> x{t.count}</span>
            </button>
          ))}
          {queryTags.length > 0 && rows.length > 0 && (
            <button
              className="user-dropdown-item"
              title="Shift+Enter tags only the highlighted row"
              onClick={() => void tagPicked(rows)}
            >
              #{queryTags.join(' #')} → tag {rows.length} result{rows.length === 1 ? '' : 's'}
            </button>
          )}
          {rows.length === 0 && <div className="user-dropdown-item" style={{ opacity: 0.6 }}>no match</div>}
          {rows.map((r, i) => (
            <button
              key={r.tid ?? `${r.ref}@${i}`}
              className="user-dropdown-item"
              onPointerEnter={() => setHi(i)}
              onClick={() => handleOpen(r.ref)}
              style={i === hiIdx ? { background: 'rgba(255,255,255,0.1)' } : undefined}
            >
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.txt}</div>
              <div style={{ fontSize: 11, opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.type} · {r.ref}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function UserBar() {
  const [session, setSession] = useState(sess);
  const [open, setOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const syncStat = useLiveQuery(() => idb.db.das.get(-1));
  /** Global sync activity: `greet()` is a singleton, so the ring is unambiguous. */
  const greetAct = useSyncExternalStore(subscribeGreetStat, getGreetStat);
  const slowest = [...greetAct.steps].sort((a, b) => b.ms - a.ms).slice(0, 3)
  const slowestText = slowest.map(s => `${s.name} ${fmtMs(s.ms)}`).join(', ');
  const greetTitle = greetAct.inflight > 0
    ? `syncing ${greetAct.phase} · ${Math.round(greetAct.frac * 100)}%`
    : greetAct.lastError ? `last sync failed: ${greetAct.lastError}`
    : greetAct.lastOkAt ? `synced ${fc.fmtAgo(greetAct.lastOkAt)}`
    : 'sync';
  const greetDetail = greetAct.inflight > 0 ? greetTitle
    : [greetTitle, greetAct.lastDirtyLeft ? `${greetAct.lastDirtyLeft} local edit(s) pending` : '', slowestText]
      .filter(Boolean).join(' · ');
  const noticeRef = useRef<HTMLDivElement | null>(null); // 1. Create the ref
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pairedDevices, setPairedDevices] = useState<CredUnlock.PairedCredDevice[]>(() => CredUnlock.loadPairedDevices());
  const unlockWatchers = useRef<Map<string, () => void>>(new Map());
  const [plusOpen, setPlusOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const plusRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  /** Close every bar menu except the one whose container is `keep`; null closes all. */
  const closeMenus = (keep: HTMLDivElement | null) => {
    if (plusRef.current !== keep) setPlusOpen(false);
    if (noticeRef.current !== keep) setNoticeOpen(false);
    if (settingsRef.current !== keep) setSettingsOpen(false);
    if (menuRef.current !== keep) setOpen(false);
  };

  /**
   * Toggle one menu on pointerdown so a mouse press and a finger tap behave the
   * same and never depend on a `click` surviving a re-render. The whole
   * container is the hit area, and opening one menu closes the others.
   */
  const toggleMenu = (
    e: React.PointerEvent<HTMLDivElement>,
    self: HTMLDivElement | null,
    isOpen: boolean,
    setSelf: (open: boolean) => void,
  ) => {
    if (e.button > 0) return; // right/middle click
    if ((e.target as Element).closest('.user-dropdown')) return; // menu content keeps its own clicks
    closeMenus(self);
    setSelf(!isOpen);
  };

  /* `+` menu: newest rows by local edit time, newest first. */
  const recentDas = useLiveQuery(
    async () => {
      const rows = await idb.db.das.orderBy('modAt').reverse().limit(24).toArray();
      return rows.filter((r) => idb.isUiTag(r) && !r.tags?.includes(idb.DEL_TAG)).slice(0, 8);
    },
    [],
    [] as idb.Da[],
  );

  /* Grouper scripts come straight from `db.das`, so a new `restGroupers/…` row
   * lands in the settings datalist without a code change. */
  const grouperOpts = useLiveQuery(
    async () => {
      const rows = await idb.db.das.where('type').equals('src').toArray();
      const refs = rows
        .filter((r) => r.ref.startsWith(REST_GROUPER_PREFIX) && !r.tags?.includes(idb.DEL_TAG))
        .map((r) => r.ref);
      return [...new Set(refs)].sort();
    },
    [],
    [] as string[],
  );

  /** Datalist options for one `treeCac` key; the grouper key adds the live script refs. */
  const treeCacOptsFor = (key: string): string[] => {
    const base = idb.treeCacOpts[key] ?? [];
    return key === 'restGrouper' ? [...base, ...grouperOpts] : base;
  };

  const readTabParam = (): string[] => {
    const csv = searchParams.get('tabs');
    return csv ? csv.split(',').map((s) => { try { return decodeURIComponent(s); } catch { return s; } }) : [];
  };

  /** Open `ref` in the editor pane, appending it to the open tabs. */
  const openInEditor = (ref: string) => {
    const tabs = readTabParam();
    const next = tabs.includes(ref) ? tabs : [...tabs, ref];
    const params = new URLSearchParams(searchParams);
    params.set('e', ref);
    params.set('tabs', next.map(encodeURIComponent).join(','));
    setPlusOpen(false);
    navigate(`/tabs?${params.toString()}`);
  };

  /* Draft tab: no row is written until the tab dropdown saves one. */
  const handleNewDraft = () => openInEditor('untitled_' + fc.fmt_ymddHMS(new Date()));

  useEffect(() => {
    sbg.auth.getSession().then(({ data }) => {
      setSession(data.session);
      
    });

    const { data: { subscription } } = sbg.auth.onAuthStateChange((event, currentSession) => {
      setSession(currentSession);
    });

    // // Listen for trigger-toast from bg.ts
    // const handleMessage = (message: any) => {
    //   if (message.type === 'trigger-toast') {
    //     const { title, message: msg, level } = message.payload;
    //     if (level === 'error') toast.error(title, { description: msg });
    //     else if (level === 'warning') toast.warn(title, { description: msg });
    //     else toast.info(title, { description: msg });
    //   }
    // };
    // document.addEventListener(handleMessage);

    const handleClickOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const insideBar = [plusRef, noticeRef, settingsRef, menuRef]
        .some((r) => r.current?.contains(target));
      if (!insideBar) closeMenus(null);
    };

    // 2. Attach global listener
    document.addEventListener("pointerdown", handleClickOutside);
    return () => {
      subscription.unsubscribe();
      // document.removeEventListener(handleMessage);
      document.removeEventListener("pointerdown", handleClickOutside);
    };
  }, []);

  // Phone-side push: watch paired PCs for lock-screen unlock requests.
  useEffect(() => {
    if (!session) return;
    const watchers = unlockWatchers.current;
    for (const dev of CredUnlock.loadPairedDevices()) {
      if (watchers.has(dev.deviceId)) continue;
      watchers.set(dev.deviceId, CredUnlock.listenUnlockPush(dev, {
        onRequest: (ev) => void CredUnlock.promptUnlockNotification(ev, dev),
      }));
    }
    return () => {
      watchers.forEach((close) => close());
      watchers.clear();
    };
  }, [session]);

  const handleSignin = async () => {
    signinGoogle().then(()=> handleSync())
    setOpen(false)
  };

  const handleSignout = async () => {
    sbg.auth.signOut()
    setOpen(false)
  };

  const handleSync = async () => {
    await greet(idb.db.das)
    setOpen(false)
  };

  const handleSnap = async () => {
    const res = await upSnap()
    setOpen(false)
  };

  const refreshPaired = () => setPairedDevices(CredUnlock.loadPairedDevices());

  const handlePair = async () => {
    try {
      const device = await CredUnlock.scanQrToPair();
      refreshPaired();
      unlockWatchers.current.get(device.deviceId)?.();
      const close = await CredUnlock.watchUnlockPrompt(device);
      unlockWatchers.current.set(device.deviceId, close);
      toast.success(`Paired with ${device.deviceName}`);
    } catch (e: any) {
      toast.error(e.message || 'Pair failed');
    }
    setSettingsOpen(false);
  };

  const handleUnlock = async () => {
    try {
      const device = CredUnlock.loadPairedDevices()[0];
      if (!device) throw new Error('No paired PC device');
      const res = await CredUnlock.sendUnlock(device);
      if (res.ok) toast.success(`Unlock sent to ${device.deviceName}`);
      else toast.error(res.message || 'Unlock failed');
    } catch (e: any) {
      toast.error(e.message || 'Unlock failed');
    }
    setSettingsOpen(false);
  };

  const handleUnpair = (deviceId: string) => {
    CredUnlock.removePairedDevice(deviceId);
    unlockWatchers.current.get(deviceId)?.();
    unlockWatchers.current.delete(deviceId);
    refreshPaired();
  };

  return (
    <div className="flex flex-col items-center">
      <div style={{ position: 'fixed', top: '36px', right: '20px', zIndex: 2, display: 'flex', justifyContent: 'flex-end', maxWidth: 'calc(100vw - 40px)', pointerEvents: 'none' }}>
        <SearchOmnibox onOpen={openInEditor} />
        <div
          className="user-menu-container"
          ref={plusRef}
          onPointerDown={(e) => toggleMenu(e, plusRef.current, plusOpen, setPlusOpen)}
        >
          <div className="user-avatar">
            <li.Plus size={20} />
          </div>
          {plusOpen && (
            <div className="user-dropdown">
              <button className="user-dropdown-item" onClick={handleNewDraft}>New</button>
              {recentDas.map((r) => (
                <button
                  key={r.tid}
                  className="user-dropdown-item"
                  title={r.ref}
                  onClick={() => openInEditor(r.ref)}
                >
                  {r.ref} · {fc.fmtAgo(r.modAt ? new Date(r.modAt).getTime() : 0)}
                </button>
              ))}
              {recentDas.length === 0 && <div className="user-dropdown-item" style={{ opacity: .6 }}>no recent</div>}
            </div>
          )}
        </div>
        <div
          className="user-menu-container"
          ref={noticeRef}
          onPointerDown={(e) => toggleMenu(e, noticeRef.current, noticeOpen, setNoticeOpen)}
        >
          <div className="user-avatar">
              <li.Bell size={20} />
          </div>
          {noticeOpen && <div className="user-dropdown"> <NotificationDropdown /> </div>}
        </div>
        <div
          className="user-menu-container"
          ref={settingsRef}
          onPointerDown={(e) => toggleMenu(e, settingsRef.current, settingsOpen, setSettingsOpen)}
        >
          <div className="user-avatar">
            <li.Settings size={20} />
          </div>
          {settingsOpen && (
            <div className="user-dropdown">
              <button className="user-dropdown-item" onClick={fc.handleDisable(handlePair)}>Pair Device</button>

              <button className="user-dropdown-item" onClick={fc.handleDisable(handleUnlock)}>Unlock PC</button>

              <div>Paired PCs</div>
              <div style={{paddingLeft:22}}>
                {pairedDevices.length === 0 && <div style={{opacity:.6}}>none yet</div>}
                {pairedDevices.map((dev) => (
                  <div key={dev.deviceId} style={{display:'flex', alignItems:'center', gap:4}}>
                    <span>{dev.deviceName}</span>
                    <button title="Unpair" onClick={() => handleUnpair(dev.deviceId)}><li.X size={14} /></button>
                  </div>
                ))}
              </div>

              <div>Settings</div>
              <div style={{paddingLeft:22}}> {Object.entries(idb.treeCac).map(([key, value]) => (
              <div key={key} style={{flexDirection:'row',display:'flex'}}>
                <label htmlFor={`input-tree-${key}`}> {key}: </label>
                <input id={`input-tree-${key}`}type="search" list={`opts-tree-${key}`}
                  defaultValue={value as string}
                  onBlur={(e) => { idb.db.tree.put({key, value: idb.treeCac[key] = e.target.value}); }}
                  style={{flexGrow:1, paddingLeft:2}} />
                {treeCacOptsFor(key).length > 0 && (
                  <datalist id={`opts-tree-${key}`}>
                    {treeCacOptsFor(key).map((opt) => (
                      <option key={opt} value={opt} />
                    ))}
                  </datalist>
                )}
              </div> ))} </div>

              <div className="user-dropdown-item"><a href="service-terms.html" target="_blank">Service Terms</a> <a href="privacy-policy.html" target="_blank">Privacy Policy</a></div>
              <div>{greeter.snap.replace('.cbor.pako','')} {fc.BUILD_TIME}</div>
              <div id="stts-lastgreet"/>
              <div style={{opacity:.8}}>{greetDetail}</div>
              {syncStat?.rec && Object.entries(syncStat.rec)
                .sort(([, a], [, b]) => new Date(b.at).getTime() - new Date(a.at).getTime())
                .map(([key, value]) => (
              <div key={key} >{`${Number(value.cnt).toLocaleString()} ${key} at ${fc.fmtAgo(value.at)}`} </div> ))} 
            </div>
          )}
        </div>
        {session ? (
          <div
            className="user-menu-container"
            ref={menuRef}
            onPointerDown={(e) => toggleMenu(e, menuRef.current, open, setOpen)}
          >
            <div className="user-avatar" title={greetDetail}>
              {session?.user?.identities?.[0]?.identity_data?.avatar_url ? (
                <img src={session.user.identities[0].identity_data.avatar_url} 
                className="avatar-img" alt="User" />
              ) : ( <li.User size={20} /> )}
              {greetAct.inflight > 0
                ? <SyncRing color="#3b82f6" frac={greetAct.frac} />
                : greetAct.lastError ? <SyncRing color="#ef4444" frac={1} /> : null}
            </div>
            {open && (
              <div className="user-dropdown">
                <button className="user-dropdown-item" onClick={fc.handleDisable(handleSync)}>Sync</button>

                <button className="user-dropdown-item" onClick={fc.handleDisable(handleSnap)}>Snap new </button>

                <button className="user-dropdown-item" onClick={() => confirm('Sign out?') && handleSignout()}>Sign out</button>
              </div>
            )}
          </div>
        ) : (
          <button className="signin-btn" style={{ alignSelf: 'center', margin: 11 }} onClick={handleSignin}>Signin</button>
        )}
      </div>
    </div>
  );
}