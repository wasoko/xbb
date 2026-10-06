// src/route.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import * as li from 'lucide-react'
import { createHashRouter, RouterProvider, Outlet, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import {  TapBar, UserBar, CreateBar} from './tap';
import {VbCard} from './tabs';
import { ErrorBoundaryOutlet, LocalErrorBoundary } from './ErrorBoundaryOutlet';
import { FilterBar } from './FilterBar';
import { Toaster } from 'sonner';
import { installSrctagGlobal } from '../srctag';

const router = createHashRouter([
  {
    path: '/',
    element: 
      <div className="app-root">
        <div className="content">
        <Outlet />
        </div> <LocalErrorBoundary>
        <CreateBar /> <UserBar />  </LocalErrorBoundary> <LocalErrorBoundary>
        <FilterBar 
          tidLoc={null}
        /> </LocalErrorBoundary> <LocalErrorBoundary>
        <TapBar />  </LocalErrorBoundary>        
      </div>,
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
    <Toaster position="top-right" richColors />
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