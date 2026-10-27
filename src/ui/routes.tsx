// src/route.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import * as li from 'lucide-react'
import { createHashRouter, RouterProvider, Outlet, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { NavBar, UserBar } from './tap';
import { SeaView } from './SeaView';
import {VbCard} from './tabs';
import { ErrorBoundaryOutlet, LocalErrorBoundary } from './ErrorBoundaryOutlet';
import { FilterBar } from './FilterBar';
import { restGraphOpen } from './restGraphWindow';
import { Toaster } from 'sonner';
import { stts } from '../fc';
import { startPerfWatch } from '../perfWatch';
import { installSrctagGlobal } from '../srctag';
import { installWebfeedGlobal } from '../srcfeedWeb';
import { installSrcFeedGlobal } from '../srcfeed';
import { ensureBbListMax, ensureBbSrcFeedEntries, ensureGrSrcFeedEntry } from '../srcfeedStore';
import { installBbApiGlobal } from '../bb';
import { installBbProxy } from '../bbProxyInstall';
import { BbLoginDialog } from './BbLoginDialog';
import { registerBodyTwins } from '../runsrc';
import { SRCFEED_BODY_TWINS } from '../srcfeedRows';
import { installSrcFeedTabRunner } from '../srcfeedTab';
import { registerG4Source } from '../sessionSourceG4';

/**
 * The page's own chrome. The rest list's wide view is this same page opened for the
 * graph, so it drops the nav, the user bar and the filter bar rather than showing
 * them beside the list and the graph.
 *
 * The sea is the backdrop the app floats on. The sea's own route is the one that
 * leaves nothing over it, so that route is also the one that hands it the pointer and
 * the one where its readouts belong; the wide view is opened to read a list and a graph
 * together and drops the backdrop the way it drops the bars.
 *
 * @returns The app shell.
 */
function AppShell() {
  const [search] = useSearchParams();
  const { pathname } = useLocation();
  const wide = restGraphOpen(search);
  const overSea = pathname === '/';
  return (
    <div className="app-root">
      {!wide && (
        <LocalErrorBoundary>
          <SeaView foreground={overSea} />
        </LocalErrorBoundary>
      )}
      <div className="content" style={overSea ? { pointerEvents: 'none' } : undefined}>
        <Outlet />
      </div>
      {!wide && (
        <>
          <LocalErrorBoundary>
            <NavBar /> <UserBar />
          </LocalErrorBoundary>
          <LocalErrorBoundary>
            <FilterBar tidLoc={null} />
          </LocalErrorBoundary>
        </>
      )}
    </div>
  );
}

const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: null, },
      { path: 'tabs',element: <VbCard />, errorElement: <ErrorBoundaryOutlet /> },
    ],
  },
]);

    // async function onPasteButtonClick() {
    //   try {       
    //     greet(db.tags) 
    //     const text = await navigator.clipboard.readText(); // 'clipboardRead' in manifest.json v3
    //     remark2tagged(text, ['pasted', ''], 1);
    //   } catch (err) {
    //     console.error("Failed to read clipboard:", err);
    //   }
    // }

    // const handleSelection_showOpenLinks = (event: MouseEvent | TouchEvent) => {
    //   const selection = window.getSelection();
    //   const selectedText = selection?.toString().trim();

    //   if (selectedText && selectedText.length > 0) {
    //     // Logic to extract links from selection
    //     const links = extractLinksFromSelection(selection!);
    //     if (links.length > 0) {
    //       showOpenLinksButton(event, links);
    //     }
    //   }
    // };
    // // document.removeEventListener('mouseup', handleSelection_showOpenLinks);
    // document.addEventListener('mouseup', handleSelection_showOpenLinks);
    // document.addEventListener('touchend', handleSelection_showOpenLinks);

// A `type='src'` row cannot import this bundle: `runsrc` evaluates it from a `data:` URL,
// which has no base for a relative specifier. The global is how a `run_src` row reaches it.
installSrctagGlobal();

// Same reason: `webfeed/extract.js` reads the feed document through this global.
installWebfeedGlobal();

// And `srcdom/*` adapters read their site through this one.
installSrcFeedGlobal();
// `bb-*` rows read Bilibili through this one; the extension page's cookies are the session.
installBbApiGlobal();
// The webapp has no Bilibili cookies, so it reaches `cors_bb` through the proxy.
installBbProxy();

// A registry seeded before the Bilibili entries existed gains them once; a
// tombstoned row is a deletion, not a missing seed.
void ensureBbSrcFeedEntries()
  .then(() => ensureBbListMax())
  .then(() => ensureGrSrcFeedEntry())
  .catch((error: unknown) => {
    console.error('srcfeed: cannot append the seeded entries', error);
  });
// A realm that forbids eval — the extension page — runs a seeded body through this
// compiled counterpart instead; an edited row no longer matches, so it refuses.
registerBodyTwins(SRCFEED_BODY_TWINS);

// Rows whose header says `@requires tab` run in the tab they name, via
// `chrome.userScripts`; in the webapp the runner reports `not-extension` instead.
installSrcFeedTabRunner();

// A source that is never registered is invisible to the session picker.
registerG4Source();

// The hourly resource sample: a crossing lands in the settings status line and, on the
// `-perf` topic, in the notice list.
startPerfWatch((message) => { stts(message, '-perf', 'warning'); });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
    <Toaster position="top-right" richColors />
    <BbLoginDialog />
  </React.StrictMode>
);


// ────────────────────────────────────────────────────────────────────────────
// URL anatomy
// ────────────────────────────────────────────────────────────────────────────
//
//  /tabs?f=filter&e=core%2Frender.ts&tabs=core%2Frender.ts%2Cutils%2Fmath.ts&sid=a1b2c3d4&node=node-1
//  └──┬──┘└──┬──┘└──────────┬──────┘└─────────────────────┬─────────────────┘└────┬────┘└───┬───┘
//     │      │              │                              │                       │        │
//   route  filter     active editor              open tab list (CSV)         session id   node focus
//
// `f=recr` is reserved: as the only filter it lists recr's own rows instead of tag rows,
// and a click on one of them sets `sid`/`node` or opens a tab ref of the form `recr|<ref>`.
//
// How panes append to /tabs:
//   tabs.tsx   → openInEditor(file)  appends  &e=file&tabs=existing,file
//   artfact    → activateTab(file) sets      &e=file              (preserve tabs)
//   chat-pane  → the session picker sets      &sid=nanoid