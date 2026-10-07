# greet() — live RPC sync over CDN snap (xbb)

Adapted from `tabext/docs/sync.md` (bulk snap + RPC pull/push, LanceDB-style
catchupRead → privateMerge → atomicCAS → retry), grounded in:

- `src/greet.ts` — `Greeter.pullPush`, `merge`, `row2put`, `dl_merge`, `bulk2put`
- `src/sdb.ts` — `Da`, `daUniq`, `deepMerge`, `patchMod`, `recMerge`
- `tabext/src/ups_same_base.sql` — authoritative server CAS (schema `tt.upsBase`)

Entity: `Da { tid, txt, ref, type, tags?, dt, modAt, rec }`
- `uniqs` (semantic key) = `type + ref`
- `pk` (local) = `tid` (auto-increment per client — see Risk R3)
- `dt` = server time (only server writes it), `modAt` = local dirty flag
- `rec.ver[dt]` = the server versions this client has held, keyed by their ISO `dt`
- `rec.cr[devAgent_modAt]` = discarded local edits, keyed by the discarding client's
  `devAgent` plus their ISO `modAt`; a row that carries one is tagged `FIXMEchange_rejected`

---

## 1. Data flow overview

```mermaid
flowchart TD
    subgraph Client["Client (Dexie tagDB_0)"]
        A["greet(tab)"]
        P["saveToDb: greetSettled → planPersist<br/>→ daEdit (shelf) | fileDiscardedCr"]
        B["dl_merge: fetch CDN snap<br/>+ bulk2put (diff vs local)"]
        C["greeter.pullPush loop<br/>- read modAt!=null rows<br/>- last_dt = max(dt) locally"]
        D["rpc ups_same_base<br/>{snap, payload, last_dt}"]
        E["merge(dl, modrw):<br/>deepMerge + PK relocate"]
        F["ok → clean modAt=null, dt=server_now<br/>ver[dt]=accepted text"]
        K["server wins → ver[dt]=server text<br/>cr[devAgent_modAt]=discarded local edit"]
    end
    subgraph Server["Supabase tt.upsBase (psql)"]
        G["pg_advisory_xact_lock(snap)<br/>classify each uniq"]
        H["upd / ins → upsert dt=now()"]
        I["toMerge / newer → return in dl"]
    end
    subgraph CDN["S3 bb/{user}"]
        J["da.N.cbor.pako snap"]
    end
    A --> B --> J
    B --> C --> D --> G
    G --> H --> F
    G --> I --> E --> F
    E --> K
    E --> C
    P --> A
```

### 1.1 Which snapshot a client works against

Two `db.tree` values decide it:

| key | writer | meaning |
|:--|:--|:--|
| `snap_name` | `greetOnce` | effective name of the snapshot whose rows are in `db.das`, `up-`-prefixed when an upgrade stage applied; also the `dl_merge` cache key and the RPC partition |
| `snap_pin` | the settings menu | user pin: a CDN filename to keep working against, or `''` to follow the newest listing entry |

`greeter.snap` is always the effective name and `pullPush` sends it as the RPC `snap_name`,
which the server partitions on (`pg_advisory_xact_lock(hashtext(snap_name))`). A pin
therefore selects a working namespace, not just a download.

A pin never moves on its own: `dl_merge` takes the pinned filename instead of
`list[0].name`, so a newer snapshot is listed but not loaded, and `upSnap` does not move
the pin either. Recent filenames are cached in `treeCacOpts['snap_pin']` while the
settings menu is open; that cache only feeds the `snap_pin` datalist and is not persisted.

Switching pins goes through `applySnapPin`, which the settings `snap_pin` field commits:
one greet round first pushes what this client still owes the current partition, then the
rows it could not settle are shown to the user (`outstandingDirty` + `dirtyLabel`) and
the switch waits on that confirmation. `applySnapPin` refuses a filename the listing does
not have, archives `db.das` into `db.bins` under `das-<snap>-<ISO>`, empties `db.das` so
no dirty row can be pushed into the pinned partition, writes `snap_pin`/`snap_name`, and
runs one greet round that loads the pinned file into the emptied table. Cancelling leaves
the pin and both tables untouched. The avatar carries an amber ring while a pin is set and
no round is running.

---

## 2. The essential cases of one uniq

One uniq (`ref`+`type`) resolves in three ways, decided by the row's `rec.ver`. A
version enters it when this client takes delivery of it: its own accepted push, a
`deepMerge` adoption, another client's entry carried inside the row's `rec`, or the base
`sdb.daEdit` shelves from the row an edit is based on.

| case | when | server category | outcome on this client |
|:--|:--|:--|:--|
| 1 accepted | the row's `dt` is still the server's | `ins` / `upd` | clean; `ver[server_now]` = the text the server accepted |
| 2 discarded | the server moved (or the row carries no `dt` of its own) and `ver` holds no copy of the server's version | `toMerge` | server text; `cr[devAgent_modAt]` = the local text; the diff tab offers it back |
| 3 patched | the server moved and `ver` *does* hold its version | `toMerge` | `patchMod` re-applies the local delta onto the server text; the row re-pushes |

**Case 1 — same base.** The everyday path: the edit meets the server where it left it.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant S as ups_same_base
    C->>C: daEdit (txt, modAt, ver[dt0]=the edited-over copy)
    C->>S: rpc {uniqs:U, dt:dt0, stuff}
    S->>S: m.dt(dt0)==i.dt(dt0) → upd (WHERE br.2)
    S-->>C: ok_uniqs=[U], server_now=dt1
    C->>C: modAt=null, dt=dt1, ver[dt1]=accepted text
```

**Case 2 — the essence conflict.** Two clients leave the same base at once; B's push is
stale, and B cannot reproduce the version A's `dl` row carries, so A's text stands and
B's edit moves to `cr`. This is the case the whole `cr` + diff-tab flow exists for.

```mermaid
sequenceDiagram
    autonumber
    participant A as Client A
    participant S as Server ups_same_base
    participant B as Client B

    Note over A,B: both hold uniq U=type+ref, tid=t, dt=dt0, txt=orig
    A->>A: daEdit: txt orig→A, modAt=now, ver[dt0]=orig
    A->>S: rpc {uniqs:U, dt:dt0, stuff:A}, last_dt=dt0
    S->>S: m.dt(dt0)==i.dt(dt0) → upd (accepted, WHERE br.2)
    S-->>A: ok_uniqs=[U], server_now=dt1
    A->>A: modAt=null, dt=dt1, ver[dt1]=A
    B->>B: daEdit: txt orig→B, modAt=now, ver[dt0]=orig
    B->>S: rpc {uniqs:U, dt:dt0, stuff:B}, last_dt=dt0
    S->>S: m.dt(dt1)!=i.dt(dt0) → toMerge
    S-->>B: dl=[{U, dt:dt1, stuff:A}], ok_uniqs=[]
    B->>B: deepMerge(B, A@dt1): gate ver[dt1] → miss
    B->>B: server wins: txt=A, modAt=null, ver[dt1]=A, cr[devAgent_b_modAt]=B
    Note over A,B: converged on A's text. B alone carries cr and shows the conflict
```

`daEdit` shelves the base, but the gate wants the version the *server* now names:
`toMerge` returns a `dt` newer than the base the local row carries, so the copy held is
the one the edit was made from, not the one the server delivers. That is why case 2 is
the norm in the live loop (§7 R1). The greet round that wrote the `cr` entry announces it
(§6), and the diff tab offers each change of the entry against the text the row
carries now, one Apply button per change. Applying writes the row through `daEdit` and
pushes; the entry stays until every change is taken or the tab trashes it
(`docs/difftab.md` §4).

**Case 3 — the gate hits.** The local delta is applied onto the server text, so both
edits survive. It fires on re-delivery of a version this client already holds — chiefly
the CDN snap path, where `bulk2put` merges a snap row of the very version the local edit
was based on (`test/ver.test.ts`), or two live rows of one uniq (R3). An inherited entry
(a `deepMerge` union of another client's `ver`) can supply the held version, but the
re-delivery is what makes its `dt` current again.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant S as Server / CDN snap
    Note over C: row pushed by this client at dt1 · ver[dt1] held
    C->>C: daEdit → txt=B, modAt (row still dt1, base shelved)
    S-->>C: dl row U@dt1, txt=A0 (the version re-delivered)
    C->>C: deepMerge: gate ver[dt1] → hit
    C->>C: patchMod: apply diff(ver[dt1]→B) onto A0
    C->>S: next round rpc {dt:dt1, txt:B'} → upd
```

A region the patch cannot place keeps the server text for that region and is counted in
`rec.patchFail`; the tab shows ⚠ instead of losing it silently. See Risk R1.

**Persist — the buffer is written after the round.** The cases above describe rows. The
editor's buffer is not a row, so its keystrokes reach the table only through `saveToDb`, and
the moment of that write decides the outcome. A write that lands before the round does
pushes keystrokes typed against the older base over the row's current `dt`, which the
server admits as an `upd`: the version it replaces is gone with no `cr` and no warning. The
same write after a round it cannot patch files a `cr` for an edit the user was about to
persist anyway. `saveToDb` therefore waits for the round (`greetSettled`: join the round in
flight, or start one the throttle swallowed when none has finished since the burst began),
reads the row, and merges the keystrokes onto the text the row carries now
(`ui/reapply.planPersist`) before writing.

```mermaid
sequenceDiagram
    autonumber
    participant U as CodeMirror buffer
    participant E as saveToDb
    participant G as greet round
    participant D as Dexie row
    U->>E: pause/blur, base A + keystrokes
    E->>G: greetSettled: join or start the round
    G-->>D: row = server version B, clean
    E->>D: daRead
    E->>E: planPersist(buffer, baseline A, B)
    alt hunks placed
        E->>D: daEdit(B, merged) → shelves ver[B]
        D->>G: push dt=B → upd accepted
    else hunk unplaceable
        E->>D: fileDiscardedCr: B stays, the edit is filed as cr
    else nothing typed
        E->>U: buffer follows B, no write
    end
```

| buffer vs the row now | action | write |
|:--|:--|:--|
| equal | skip | none |
| equal to its baseline: nothing typed | adopt | none; the buffer follows the fetched text |
| keystrokes placed on the fetched text | merged | `daEdit(row, merged)` shelves `ver[row.dt]`, so the push is an `upd` |
| a hunk could not be placed | conflict | `fileDiscardedCr`: the server text stays, the edit is filed as `cr` and announced like any discard |

The unload paths (`pagehide`, `freeze`, `visibilitychange`) still write what the buffer
holds: a page that is going away cannot wait for a round, and a conflict is recoverable
while a lost keystroke is not.

---

## 3. `deepMerge`/`patchMod` — version-gated patch

```mermaid
flowchart LR
    V["rl.rec.ver[rin.dt]<br/>(exact copy of the server version, when held)"] -->|diff-match-patch| BM["local rl.txt = B"]
    BM -->|"patch(base→B)"| M["merged = apply(patch, rin.txt)"]
    A0["server rin.txt (dt=rin.dt)"] --> M
    M -->|"modAt=now (dirty, re-push), server tid/dt"| P["bulkPut → next loop → upd"]
```

`sdb.deepMerge(rl, rin)` (`sdb.ts`):
- takes `ver` and `cr` out of both `rec`s, runs `recMerge(rl.rec, rin.rec, 5)` on the rest,
  then unions both histories by hand (`mergeVer` for `ver`, a plain key union for `cr`,
  local entries winning): `recMerge` lets the server side win same-stamp entries, and a
  `cr` key names the client that discarded the edit, so the union keeps every client's log.
- **if `ver[rin.dt]` exists → `patchMod(rin, ver[rin.dt], rl)`**: `txt = patch_apply(patch_make(copy.txt, rl.txt), rin.txt)`, same for `tags` (joined/split on `\n`). Keeps server `tid`/`ref`/`type`/`dt`, sets `modAt=now` → row re-pushes. A hunk `patch_apply` cannot place keeps the server text for that region and is counted in `rec.patchFail = { at, hunks }`; the tab reports it (⚠) instead of losing the edit silently.
- **else → server wins**: returns `rin` clean (`modAt` unset, no re-push) carrying the
  merged `rec`, adopts the server version into `ver[rin.dt]`, and files the discarded
  local row under its `cr` key (`putCr`), marking the row `FIXMEchange_rejected`. The local
  text survives there for the diff tab; `daStale` (the row carries a `cr` log) and the
  tab's ⚠ both point at it.

`rec.ver[dt]` and `rec.cr[devAgent_modAt]` each hold `row` minus `rec` (history cannot
nest itself), keyed by `sdb.stamp` for `ver` and `sdb.crStamp` for `cr`. Neither history
is pruned.

**Writers.** `pullPush` records each version the server accepts (`ver[server_now]`),
and `deepMerge` records the adopted server version plus any discarded local edit.
`sdb.daEdit(row, txt)` shelves the base: the first edit of a clean row stores the row
under its own `dt`, so the ancestor exists without the writer knowing about it. The editor's
buffer write (`saveToDb`) and the agent store (`IRecrStore.put`/`writeFile`) behave alike;
the tab-dropdown metadata and rename writes leave `txt` alone, so a text read earlier cannot
be pushed over a version the row has since taken. `cr` travels: the RPC payload carries it,
`deepMerge` unions both sides, and a snap merge or a PK relocation carries the log onto
the row that replaces it (`withCr`). `upSnap` drops `rec.ver` from the snapshot
(`withoutVer`) — the CDN carries row state, not history.

**Early round.** The editor starts a round on focus, on the first keystroke of a burst, and
when a tab opens, so the local copy is usually at the server's `dt` before an edit lands.
Keystrokes typed while a round runs are reapplied onto the fetched text by `ui/reapply.ts`
(the same diff-match-patch recipe as `patchMod`, over the live buffer with the text it was
based on as ancestor), at tab open and again at every write (§2 *Persist*). The write itself
goes through `daEdit`, which shelves the base it was made from, and `softGreet()` pushes it
in the background.

---

## 4. Server CAS (`tt.ups_same_base`) — actual SQL semantics

`tabext/src/ups_same_base.sql`, per uniq in the payload (`i`), joined to server
rows (`m`) for `md5(uniqs)` under `snap_name`:

| category | condition (i vs m) | WHERE admitted | server action |
|:--|:--|:--|:--|
| `ins` | `m.uniqs IS NULL` (new uniq) | only if `last_dt == xdt.max_dt` (snap-global max) | INSERT dt=now(), into `ok_uniqs` |
| `upd` | `m.dt == i.dt` | always (WHERE branch 2) | UPDATE dt=now(), into `ok_uniqs` |
| `toMerge` | `m.dt != i.dt` (stale client) | always (branch 2) | into `dl` (server row returned) |
| `newer` | `m.dt > last_dt`, not in payload | branch 3 | into `dl` (server row returned) |

Details from the real SQL (differ from sync.md's per-record pseudo-code):

- `ins` gate compares the **single `last_dt` against the snap-GLOBAL `max(dt)`**
  (`xdt`), not per-uniq. A client whose `last_dt` is behind the snap's newest row
  cannot insert any brand-new uniq until it catches up — `C-INS-2`/`C-BLK-2`
  failures trace here (test rows seeded with old fixed `dt`).
- `upd` is admitted even with a stale global `last_dt` (WHERE branch 2), so the
  first writer to race a `dt` wins and later `upd`s with a matching per-row dt
  also succeed. This is the "last writer with matching dt wins" serialization.
- `pg_advisory_xact_lock(hashtext(snap_name))` serializes writers per snap.
- `ok` uses `ON CONFLICT (snap, md5(uniqs)) DO UPDATE`, so a retried same-base
  push never duplicates (T3 idempotency).

---

## 5. Conflict matrix (client view)

| client (`i`) | server (`m`) | condition | category | client follow-up |
|:--|:--|:--|:--|:--|
| absent | exists | `m.dt > last_dt` | newer | download via `dl`, put clean |
| exists | absent | `last_dt == xdt.max_dt` | ins | accepted → clean |
| exists | exists | `m.dt == i.dt` | upd | accepted → clean |
| exists | exists | `m.dt != i.dt` | toMerge | `deepMerge`: patch when `rec.ver` holds `m.dt`, else server wins, `ver[m.dt]` adopted, local edit → `cr` |

Client retry loop (`pullPush`): `MIN_LOOP=3`, `MAX_RETRIES=1` → max 5 rounds;
breaks when a round returns empty `dl` + empty `ok_uniqs` + no `modrw`. On each
round `last_dt` is recomputed as local `max(dt)` (must advance to the server's
per-row dt for the toMerge'd row, else it keeps getting rejected until the cap).

---

## 6. Observable sync state per tab

`src/ui/tabState.ts` derives one tab's state from its live `db.das` rows plus the last
`greet()` outcome; `src/ui/tabSync.ts` binds it to Dexie (`useLiveQuery`) and to the greet
activity store (`useSyncExternalStore`). Two facts stay apart:

- **row obligation** — `draft` (no live row), `pending` (the winner carries `modAt`),
  `stale` (the winner carries a `cr` log: a local edit was discarded because the version it
  was based on was not held), `diverged` (the dirty-wins row is not the newest-`dt`
  row of the same `ref`+`type`, i.e. relocation left a second live row), `failed` (the last
  greet round failed while this row is dirty), else `clean`.
- **buffer** — `bufferUnsaved` when the editor's text differs from the row it displays.
- **`warn`** — a non-fatal alarm on an otherwise fine row: hunks `patchMod` could not place
  (`rec.patchFail`). It tints the tab and adds ⚠ without changing the row state.
- **`conflicts`** — the number of discarded local edits the shown row still carries
  (`rec.cr`). It tints the tab amber, adds ⚠, renders the count next to the label, and the
  row is tagged `FIXMEchange_rejected` so the tag UI can list it for cleanup.

```mermaid
flowchart LR
  D["dirty rows (modAt index)"] --> W["daWin"]
  B["live rows ([ref+type])"] --> W
  B --> M["daNewest"]
  W -- "winner != newest" --> DIV["diverged"]
  W -- "rec.cr log" --> ST["stale"]
  W -- "modAt set" --> P["pending"]
  W -- "patchFail hunks" --> WARN["warn"]
  W -- "rec.cr entries" --> CONF["conflicts n"]
  M --> CMP{"buffer == winner.txt"}
  CMP -- no --> T["bufferUnsaved"]
  CMP -- yes --> C["clean"]
  G["greetStat"] --> RING["avatar ring + steps"]
  G --> F["failed"]
```

| fact | source |
|:--|:--|
| winner of `ref`+`type` | `sdb.daWin` — a local edit shadows the clean copy; shared with `IRecrStore` |
| the row the editor shows | the same winner (`daRead`), so badge and body agree |
| live rows of a tab | `sdb.daRows` — `modAt` index plus `[ref+type]` for `md`/`src` |
| tombstoned key | `daLatest` (newest effective stamp): a `[del]` winner means the ref is gone |
| staged progress | `greetStat` checkpoints `list → dl snap → snap merge → rpc rN → accepted → round done → push done` |
| work in flight | `greetStat.inflight`, counted inside `greet` past the `greetTill` gate |
| discarded local edits | `shown.rec.cr`, written by `deepMerge` when the server wins and announced by the greet round |

`greet()` is a throttled singleton, so `inflight` is 0 or 1 and the avatar ring is
unambiguous; a throttled call returns `{}` without work and never counts. `Greeter.onError`
reports a failed RPC round or a stalled loop, and `Greeter.onStep` reports each checkpoint;
a 100 ms ticker creeps `frac` up to `0.08` past the last checkpoint so the ring keeps moving
during a network step.

Presentation: `diverged`/`stale`/`failed` and a `warn` tint the tab and add ⚠, `pending`
tints the label, an unsaved buffer italicizes it, and the detail line is the tab `title`,
the `.tab-dropdown-portal` meta row, and the avatar tooltip (which lists the slowest steps).
Only the active tab is marked.

**Discarded edits.** A round that dropped a local edit announces it from the merge site
(`sdb.drainCr`, drained into `getConflicts`/`subscribeConflicts`), and the editor opens the
diff tab for a row it already has open, at most one per batch — a snap merge must not open a
tab per row. The tab menu lists the row's `ver` and `cr` stamps, each with its line delta
and a `del` button that trashes the entry; picking a stamp opens the same diff tab.
`docs/difftab.md` owns the diff tab's own rules.

**Flush.** The buffer is written when focus leaves the editor, when a pointer goes down
outside `.code-editor` (capture), when the page is hidden, on window
`blur`/`pagehide`/`freeze`, and after ~2 s of typing pause. Each of those writes waits for
the round and merges the buffer with the fetched text (§2 *Persist*), except `pagehide`,
`freeze`, and `visibilitychange`, which write what the buffer holds. A write that would not
change the row is skipped.

---

## 7. Known risks / divergences (from code + current test.log)

- **R1 – the patch gate needs the server's own version.** `ver[rin.dt]` is present only
  when this client held that exact version — one it pushed itself, one adopted by an
  earlier merge, one carried in through another client's `ver` union, or (since `daEdit`
  shelves what an edit is based on) the base a local edit started from. That last shelf is
  what makes a row this client only *downloaded* patchable once it has been edited, on
  re-delivery of that same version. A `toMerge` still carries a `dt` the local row does
  not name, so the miss branches on which side moved: `server-ahead` (another client
  advanced past this client's last greet/snap base — the ordinary live-loop case), or
  `server-behind` / `server-no-dt` / `no-base-dt` for a server row at or behind the local
  base with nothing held for it. Each miss is logged once per edit (`sdb.drainCr` carries
  the reason). The server copy wins and the local edit moves to `cr`, where the diff tab
  offers it back. Overlapping edits inside a patched row keep the server text for the
  hunks that do not apply (`rec.patchFail`). The log has two producers: `deepMerge` when
  this gate misses, and `fileDiscardedCr`, the editor's write when its buffer merge could
  not place a hunk on the text the row carries (`patch-unplaced`, §2 *Persist*).
- **R2 – `ins` gate is snap-global, not per-uniq.** A client behind the snap max
  is blocked from all new inserts until catchup; CDN-snap-seeded clients whose
  server has newer live rows loop to cap with dirty rows left (matches sync.md
  "suspected issue 2"). This is why `test/greet.test.ts` clears its own snap.
- **R3 – cross-client `tid` divergence (PK clash).** Tests pin the same `tid`
  (`mkTag(300,…)`) on both clients; in reality `tid` is per-client auto-increment,
  so the server row's `stuff.tid` differs from a downloader's local tid.
  `merge()` looks up displaced rows by `pk(serverStuff)`; a mismatched tid means
  the stale dirty local row is neither moved nor removed → **duplicate uniq rows
  locally** (sync.md §5 `ref(uniqs)` dup). No test covers naturally-different
  tids for the same uniq.
- **R4 – `last_dt` is global max(dt).** A toMerge'd row whose dt is older than
  another local row's dt can be rejected repeatedly; the loop caps at 5 rounds
  and leaves it dirty (recovered on next `greet()`).
- **`stale` covers the whole log, not the latest discard.** `daStale` is true while the row
  carries any `cr` entry, including one another client discarded, so the tab cannot tell a
  fresh discard from an old one; the announce list (§6) carries the reason instead.
- **Retiring a `cr` entry needs a push.** The log travels in the RPC payload and merges
  by key, so dropping a key locally is not enough: the next round that meets that server row
  merges it back. Discarding marks the row dirty (`sdb.dropHistEntry`), so the reduced log
  is pushed like any other row; a round the server rejects (R1, R4), or a peer still pushing
  its older copy of the row, leaves the entry to return. The `FIXMEchange_rejected` tag is
  derived from the same log, so it follows it.
- **`cr` growth.** Neither `ver` nor `cr` is pruned, and a `cr` entry holds a full row
  snapshot. `modrwCheck`'s `rec` size log is the only signal; a cap belongs in `treeCac`.
- **Minor:** `toBackup` grows unbounded across `pullPush`; `merge()` calls `meta()`
  = `metaSet` (tid=-1 stat row), not a dl merge as its comment claims; test
  fixtures still use legacy `sts` field while `patchMod` reads `tags`; the stat row
  (tid -1) gains one `rec.ver` entry per round.

## 8. References

- `tabext/docs/sync.md` — parent OCC design (catchupRead/privateMerge/atomicCAS/retry)
- `tabext/src/ups_same_base.sql` — server RPC + T1–T5 assertions
- `docs/difftab.md` — the diff tab, its `diff|…` tab ref, and the apply rules
- `test/ver.test.ts` — `ver`/`cr` helpers, `deepMerge` gate, `patchMod` (no server)
- `test/persist-merge.test.ts` — the buffer write: the shelf it leaves, and the filed `cr` (no server)
- `test/diff.test.ts` — hunk and change splitting, ANSI runs, line deltas, apply
- `test/greet.test.ts` — live two-client edit, stale-push conflict, rename
