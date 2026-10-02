// src/components/BottomIconBar.tsx
import React, { useState, useEffect, useRef } from 'react';
import * as li from 'lucide-react'
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { sess, signinGoogle, sbg, greet,greeter, fmtSyncCnt } from '../greet';
import * as idb from '../sdb';
import * as fc from '../fc';
import { toast } from 'sonner';
import { NotificationDropdown } from './notice';
import { upSnap } from '../greet';
import { Drag } from './drag';
import { useAvailableFilters } from './filterStore';
import { remark2tagged } from './remark-list';
import * as CredUnlock from '../credUnlock';

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

export function UserBar() {
  const [session, setSession] = useState(sess);
  const [open, setOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const syncStat = useLiveQuery(() => idb.db.das.get(-1));
  const noticeRef = useRef<HTMLDivElement | null>(null); // 1. Create the ref
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pairedDevices, setPairedDevices] = useState<CredUnlock.PairedCredDevice[]>(() => CredUnlock.loadPairedDevices());
  const unlockWatchers = useRef<Map<string, () => void>>(new Map());


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

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (noticeRef.current && !noticeRef.current.contains(target)) {
        setNoticeOpen(false);
      }
      if (menuRef.current && !menuRef.current.contains(target)) {
        setOpen(false);
      }
    };

    // 2. Attach global listener
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      subscription.unsubscribe();
      // document.removeEventListener(handleMessage);
      document.removeEventListener("mousedown", handleClickOutside);
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
    setOpen(false);
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
    setOpen(false);
  };

  const handleUnpair = (deviceId: string) => {
    CredUnlock.removePairedDevice(deviceId);
    unlockWatchers.current.get(deviceId)?.();
    unlockWatchers.current.delete(deviceId);
    refreshPaired();
  };

  if (!session) {
    return (
      <div style={{ position: 'fixed', top: '11px', right: '20px', zIndex: 2, display: 'flex', justifyContent: 'flex-end', pointerEvents: 'none' }}>
        <button className="signin-btn" onClick={handleSignin}>Signin</button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center">
      <div style={{ position: 'fixed', top: '11px', right: '20px', zIndex: 2, display: 'flex', justifyContent: 'flex-end', pointerEvents: 'none' }}>
        <div className="user-menu-container" ref={noticeRef}>
          <div className="user-avatar" onClick={() => setNoticeOpen(!noticeOpen)}>
              <li.Bell size={20} />
          </div>
          {noticeOpen && <div className="user-dropdown"> <NotificationDropdown /> </div>}
        </div>
        <div className="user-menu-container" ref={menuRef}>
          <div className="user-avatar" onClick={() => setOpen(!open)}>
            {session?.user?.identities?.[0]?.identity_data?.avatar_url ? (
              <img src={session.user.identities[0].identity_data.avatar_url} 
              className="avatar-img" alt="User" />
            ) : ( <li.User size={20} /> )}
          </div>
          {open && (
            <div className="user-dropdown">
              <button className="user-dropdown-item" onClick={fc.handleDisable(handleSync)}>Sync</button>

              <button className="user-dropdown-item" onClick={fc.handleDisable(handleSnap)}>Snap new </button>

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
                {idb.treeCacOpts[key] && (
                  <datalist id={`opts-tree-${key}`}>
                    {idb.treeCacOpts[key].map((opt) => (
                      <option key={opt} value={opt} />
                    ))}
                  </datalist>
                )}
              </div> ))} </div>

              <button className="user-dropdown-item" onClick={() => confirm('Sign out?') && handleSignout()}>Sign out</button>
              <div className="user-dropdown-item"><a href="service-terms.html" target="_blank">Service Terms</a> <a href="privacy-policy.html" target="_blank">Privacy Policy</a></div>
              <div>{greeter.snap.replace('.cbor.pako','')} {fc.BUILD_TIME}</div>
              <div id="stts-lastgreet"/>
              {syncStat?.rec && Object.entries(syncStat.rec)
                .sort(([, a], [, b]) => new Date(b.at).getTime() - new Date(a.at).getTime())
                .map(([key, value]) => (
              <div key={key} >{`${Number(value.cnt).toLocaleString()} ${key} at ${fc.fmtAgo(value.at)}`} </div> ))} 
            </div>
          )}
        </div>
      </div>
    </div>
  );
}