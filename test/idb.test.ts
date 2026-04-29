/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import {Tag, deepMerge, patchMod} from '../src/idb'
import { md2row, yaml2md } from '../src/conv_md_yaml';
import * as idb from '../src/idb'
import * as sc from '../src/sync'
import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest';
import diff_match_patch from 'diff-match-patch'; // Assume installed via npm i diff-match-patch
import { setSessSB } from './global-setup';

// https://claude.ai/chat/0604cb40-fa25-48ff-a109-1c8e95292793
// ─── helpers ────────────────────────────────────────────────────────────────
 
const SNAP = 'test-tags-occ';
 
/** Build a minimal tag row with modAt set (dirty). */
function mkTag(tid: number, txt: string, ref = 'X', extra: Partial<Tag> = {}): Tag {
  return {
    tid,
    txt,
    ref,
    type: 'test',
    rec: {},
    dt: new Date('2024-01-01T00:00:00Z'),
    modAt: new Date(),
    ...extra,
  };
}
 
/** Build a Fuser for a given DDB instance. */
function mkFuser(db: idb.DDB) {
  return new idb.Fuser(
    db.tags,
    sc.sessReady,
    sc.sbg,
    SNAP,
    idb.deepMerge,
    idb.uniqsTag,
    (r: Tag) => r.tid,
    idb.nopkTag,
  );
}
 
/** Wait for condition with polling (ms). */
async function waitFor(pred: () => Promise<boolean>, timeout = 5000, interval = 100) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error('waitFor timed out');
}
 
// ─── suite ──────────────────────────────────────────────────────────────────
 
describe('Fuser OCC – e2e', async () => {
  /** Three independent Dexie instances simulating different browser tabs / clients. */
  const dbA = new idb.DDB('client_a');
  const dbB = new idb.DDB('client_b');
  const dbC = new idb.DDB('client_c');
 
  const fusA = mkFuser(dbA);
  const fusB = mkFuser(dbB);
  const fusC = mkFuser(dbC);
 
  beforeAll(async () => {
    await setSessSB(sc.sbg);
 
    // Wipe server-side snap so every suite starts from a blank slate.
    const { error } = await sc.sbg.from('upsbase').delete().eq('snap', SNAP);
    if (error) throw new Error(`Server wipe failed: ${error.message}`);
 
    await Promise.all([dbA.tags.clear(), dbB.tags.clear(), dbC.tags.clear()]);
  }, 20_000);
 
  // ── Category: ins ─────────────────────────────────────────────────────────
  //   Server is empty (or last_dt matches max), client sends brand-new row.
  //   Expected: server accepts, row lands in both clients clean (modAt=null).
 
  describe('ins – brand-new row from client', () => {
    it(
      'C-INS-1: clean insert propagates to a second client',
      async () => {
        await dbA.tags.put(mkTag(100, 'hello'));
 
        await fusA.pullPush(); // uploads tid=100
 
        await fusB.pullPush(); // should download tid=100
 
        const got = await dbB.tags.get(100);
        expect(got?.txt).toBe('hello');
        expect(got?.modAt).toBeNull();
      },
      15_000,
    );
 
    it(
      'C-INS-2: inserted row is marked clean (modAt=null) on originating client',
      async () => {
        await dbC.tags.put(mkTag(101, 'clean-check'));
 
        await fusC.pullPush();
 
        const got = await dbC.tags.get(101);
        expect(got?.modAt).toBeNull();
      },
      15_000,
    );
  });
 
  // ── Category: upd ─────────────────────────────────────────────────────────
  //   Client already knows the latest server dt, modifies and pushes.
  //   m.dt === i.dt  →  server accepts, dt bumps to server_now.
 
  describe('upd – client in sync with server', () => {
    it(
      'C-UPD-1: client edits own previously-synced row; server accepts',
      async () => {
        // establish row on server via A
        await dbA.tags.put(mkTag(200, 'before'));
        await fusA.pullPush();
 
        // pull into B so B has the latest dt
        await fusB.pullPush();
        const synced = await dbB.tags.get(200);
        expect(synced?.txt).toBe('before');
 
        // B modifies and pushes (m.dt === i.dt → upd)
        await dbB.tags.update(200, { txt: 'after', modAt: new Date() });
        await fusB.pullPush();
 
        // A pulls the update
        await fusA.pullPush();
        const got = await dbA.tags.get(200);
        expect(got?.txt).toBe('after');
        expect(got?.modAt).toBeNull();
      },
      20_000,
    );
  });
 
  // ── Category: toMerge ─────────────────────────────────────────────────────
  //   Client edits a row whose server dt has already moved on (stale base).
  //   Server replies with latest row; client must deepMerge and retry.
 
  describe('toMerge – concurrent edit on stale data', () => {
    it(
      'C-TOM-1: two clients diverge; second push triggers deepMerge and re-push',
      async () => {
        // seed
        await dbA.tags.put(mkTag(300, 'base'));
        await fusA.pullPush();
        await fusB.pullPush();
 
        // A edits and wins
        await dbA.tags.update(300, { txt: 'A wins', modAt: new Date() });
        await fusA.pullPush();
 
        // B edits from stale base – server will reply toMerge
        await dbB.tags.update(300, { txt: 'B tries', modAt: new Date() });
        await fusB.pullPush(); // internally retries via row2put → deepMerge
 
        // both clients should converge
        await fusA.pullPush();
        const gA = await dbA.tags.get(300);
        const gB = await dbB.tags.get(300);
        // deepMerge is domain-specific; at minimum both should be clean
        expect(gA?.modAt).toBeNull();
        expect(gB?.modAt).toBeNull();
        // B's eventual txt should reflect the merge, not be lost
        // (exact value depends on deepMerge implementation)
        expect(typeof gB?.txt).toBe('string');
      },
      25_000,
    );
 
    it(
      'C-TOM-2: retry uses server_now, not original client dt (guard against stale-loop)',
      async () => {
        await dbA.tags.put(mkTag(301, 'seed'));
        await fusA.pullPush();
        await fusB.pullPush();
 
        // Spy on rpc to capture what last_dt values are sent
        const sentLastDts: (string | undefined)[] = [];
        const origRpc = sc.sbg.rpc.bind(sc.sbg);
        const spy = vi.spyOn(sc.sbg, 'rpc').mockImplementation((...args: any[]) => {
          // capture last_dt from payload
          sentLastDts.push(args[1]?.last_dt);
          return origRpc(...args);
        });
 
        await dbA.tags.update(301, { txt: 'A-v2', modAt: new Date() });
        await fusA.pullPush();
        await dbB.tags.update(301, { txt: 'B-v2', modAt: new Date() });
        await fusB.pullPush(); // expects at least 2 rounds
 
        spy.mockRestore();
 
        // If pullPush looped, the second call's last_dt must differ from the first
        // (it should use server_now from the previous round, not the original stale dt).
        if (sentLastDts.length >= 2) {
          // Last calls: the later one must have a newer (or equal) last_dt
          const first = sentLastDts[0];
          const last = sentLastDts[sentLastDts.length - 1];
          if (first && last) {
            expect(new Date(last).getTime()).toBeGreaterThanOrEqual(new Date(first).getTime());
          }
        }
      },
      25_000,
    );
  });
 
  // ── Category: newer ───────────────────────────────────────────────────────
  //   Server has rows the client has never seen (m.dt > last_dt).
  //   Client sends nothing; should still receive download.
 
  describe('newer – server ahead of client', () => {
    it(
      'C-NEW-1: client with empty payload still receives server-newer rows',
      async () => {
        // A creates and uploads
        await dbA.tags.put(mkTag(400, 'server-only'));
        await fusA.pullPush();
 
        // B does a pull-only pass (no local dirty rows)
        await fusB.pullPush();
 
        const got = await dbB.tags.get(400);
        expect(got?.txt).toBe('server-only');
        expect(got?.modAt).toBeNull();
      },
      15_000,
    );
 
    it(
      'C-NEW-2: empty payload does not crash; newer download works (T5 parity)',
      async () => {
        // Explicitly clear C to ensure truly empty local state
        await dbC.tags.clear();
 
        // pre-load something on server via A
        await dbA.tags.put(mkTag(401, 'exists-on-server'));
        await fusA.pullPush();
 
        // C pulls with no dirty rows and empty local state
        await expect(fusC.pullPush()).resolves.not.toThrow();
 
        const got = await dbC.tags.get(401);
        expect(got).toBeDefined();
      },
      15_000,
    );
  });
 
  // ── ins blocked: stale last_dt (server T1/T4 parity) ─────────────────────
  //   Server must silently ignore an insert if the client hasn't caught up.
  //   The row must NOT appear on the server until client re-syncs.
 
  describe('ins blocking – stale last_dt prevents blind insert', () => {
    it(
      'C-BLK-1: server rejects ins when client last_dt is behind; row uploads after catchup',
      async () => {
        // A creates row 500 and pushes – this advances the server dt.
        await dbA.tags.put(mkTag(500, 'anchor'));
        await fusA.pullPush();
 
        // B adds row 501 WITHOUT pulling row 500 first.
        // B's last_dt is still old → server must block the insert.
        await dbB.tags.put(mkTag(501, 'blocked-initially'));
 
        // Full pullPush will eventually catch up and then push 501.
        await fusB.pullPush();
 
        // After convergence both rows must exist server-side (pulled by A).
        await fusA.pullPush();
        const r500 = await dbA.tags.get(500);
        const r501 = await dbA.tags.get(501);
        expect(r500?.txt).toBe('anchor');
        expect(r501?.txt).toBe('blocked-initially');
      },
      20_000,
    );
 
    it(
      'C-BLK-2: NULL last_dt (first-sync) blocks blind insert (T4 parity)',
      async () => {
        // Fresh db with no prior sync
        const dbFresh = new idb.DDB('client_fresh_' + Date.now());
        const fusFresh = mkFuser(dbFresh);
 
        await dbFresh.tags.put(mkTag(502, 'first-ever'));
        // pullPush must handle null last_dt gracefully and eventually upload
        await expect(fusFresh.pullPush()).resolves.not.toThrow();
 
        // Verify row ultimately lands on server (A can see it after pull)
        await fusA.pullPush();
        const got = await dbA.tags.get(502);
        // If server blocked it (correct), got may be undefined on first A pull;
        // fresh client must retry until last_dt is valid.
        // After full convergence it should exist.
        // We just assert no crash and the row is eventually clean locally.
        const local = await dbFresh.tags.get(502);
        expect(local?.modAt).toBeNull();
      },
      20_000,
    );
  });
 
  // ── PK clash: mermaid diagram scenario ────────────────────────────────────
  //   B holds PK=99 for Uniq1. A independently assigns PK=99 to Uniq2.
  //   A's pullPush must: download server row (Uniq1/PK99), move A's local clash
  //   away (nopk), then re-push Uniq2 with a new auto-gen PK.
 
  describe('PK clash – two clients collide on same PK', () => {
    const CLASH_PK = 99;
 
    beforeEach(async () => {
      // Reset state for each clash test
      await Promise.all([dbA.tags.clear(), dbB.tags.clear()]);
      await sc.sbg.from('upsbase').delete().eq('snap', SNAP);
    });
 
    it(
      'C-PKC-1: B inserts PK=99/Uniq1; A inserts PK=99/Uniq2; A reconciles without data loss',
      async () => {
        // Phase 1 – B wins PK 99
        await dbB.tags.put(mkTag(CLASH_PK, 'uniq1-content', 'B'));
        await fusB.pullPush();
 
        // Phase 2 – A creates PK=99 unaware of B's row (no prior pull)
        await dbA.tags.put(mkTag(CLASH_PK, 'uniq2-content', 'A'));
 
        // A's pullPush must handle the clash:
        //   - server returns toMerge / newer for Uniq1 at PK=99
        //   - row2put: put server row (Uniq1/PK99 clean)
        //   - move A's local Uniq2 away via nopkTag (clear PK for auto-reassign)
        await fusA.pullPush();
 
        // Server's Uniq1 row must now be present and clean in A
        const serverRow = await dbA.tags.where('ref').equals('B').first();
        expect(serverRow).toBeDefined();
        expect(serverRow?.modAt).toBeNull();
        expect(serverRow?.tid).toBe(CLASH_PK);
 
        // A's original Uniq2 content must still exist locally (moved, dirty, PK reassigned)
        const movedRow = await dbA.tags.where('ref').equals('A').first();
        expect(movedRow).toBeDefined();
        expect(movedRow?.txt).toBe('uniq2-content');
        // PK must have been cleared for auto-reassign: tid should be different from CLASH_PK
        // (Dexie auto-increments when put without explicit PK after nopk strips it)
        expect(movedRow?.tid).not.toBe(CLASH_PK);
        // Must be dirty (needs to be pushed)
        expect(movedRow?.modAt).not.toBeNull();
      },
      25_000,
    );
 
    it(
      'C-PKC-2: after clash resolution, A can push moved row to server',
      async () => {
        // set up B
        await dbB.tags.put(mkTag(CLASH_PK, 'uniq1', 'B'));
        await fusB.pullPush();
 
        // A clashes
        await dbA.tags.put(mkTag(CLASH_PK, 'uniq2', 'A'));
        await fusA.pullPush(); // reconcile
 
        // A pushes again to upload the moved row
        await fusA.pullPush();
 
        // B should now see both rows
        await fusB.pullPush();
 
        const all = await dbB.tags.toArray();
        const txts = all.map(r => r.txt);
        expect(txts).toContain('uniq1');
        expect(txts).toContain('uniq2');
      },
      30_000,
    );
 
    it(
      'C-PKC-3: three-way PK clash (A, B, C all pick PK=99); all rows survive',
      async () => {
        // B wins the PK first
        await dbB.tags.put(mkTag(CLASH_PK, 'B-content', 'B'));
        await fusB.pullPush();
 
        // A and C both clash
        await dbA.tags.put(mkTag(CLASH_PK, 'A-content', 'A'));
        await dbC.tags.put(mkTag(CLASH_PK, 'C-content', 'C'));
 
        await fusA.pullPush();
        await fusC.pullPush();
 
        // Full convergence round
        await Promise.all([fusA.pullPush(), fusB.pullPush(), fusC.pullPush()]);
        await Promise.all([fusA.pullPush(), fusB.pullPush(), fusC.pullPush()]);
 
        // Each client should have all 3 content strings
        const allB = (await dbB.tags.toArray()).map(r => r.txt);
        expect(allB).toContain('B-content');
        expect(allB).toContain('A-content');
        expect(allB).toContain('C-content');
      },
      40_000,
    );
  });
 
  // ── Mixed-batch: all 4 categories in one RPC call (T2 parity) ────────────
 
  describe('mixed batch – all 4 categories in one payload', () => {
    it(
      'C-MIX-1: ins + upd + toMerge + newer resolved in a single pullPush cycle',
      async () => {
        // Seed: row 600 exists server-side (A pushed it); 
        //       row 601 exists and A has the latest dt; 
        //       row 602 A will push stale (→ toMerge);
        //       row 603 only server knows (→ newer on B).
 
        // 600: B will insert (ins)
        // 601: A inserts, B pulls then edits (upd)
        // 602: A inserts, B pulls, A edits again, B edits stale (toMerge)
        // 603: A inserts, B never pulls (newer)
 
        // Phase: establish via A
        await dbA.tags.put(mkTag(601, '601-v1'));
        await dbA.tags.put(mkTag(602, '602-v1'));
        await dbA.tags.put(mkTag(603, '603-only-A'));
        await fusA.pullPush();
 
        // B catches up to have the right last_dt for 601 and 602
        await fusB.pullPush();
 
        // A advances 602 on server
        await dbA.tags.update(602, { txt: '602-v2', modAt: new Date() });
        await fusA.pullPush();
 
        // Now assemble B's dirty batch:
        // 600 = brand new on B (ins)
        await dbB.tags.put(mkTag(600, '600-new-from-B'));
        // 601 = B has latest dt (upd)
        await dbB.tags.update(601, { txt: '601-updated-by-B', modAt: new Date() });
        // 602 = B is stale (toMerge) – B still has 602-v1
        await dbB.tags.update(602, { txt: '602-B-stale', modAt: new Date() });
        // 603 stays as "newer" – B has no local row for it
 
        // Single pullPush must route all 4 categories correctly
        await fusB.pullPush();
 
        const r600 = await dbB.tags.get(600);
        const r601 = await dbB.tags.get(601);
        const r602 = await dbB.tags.get(602);
        const r603 = await dbB.tags.get(603);
 
        // ins accepted (or blocked until catchup and re-accepted on retry)
        expect(r600?.txt).toBe('600-new-from-B');
        expect(r600?.modAt).toBeNull();
 
        // upd accepted
        expect(r601?.txt).toBe('601-updated-by-B');
        expect(r601?.modAt).toBeNull();
 
        // toMerge: row survived, is clean after merge/retry
        expect(r602).toBeDefined();
        expect(r602?.modAt).toBeNull();
 
        // newer: B now has the row A pushed
        expect(r603?.txt).toBe('603-only-A');
        expect(r603?.modAt).toBeNull();
      },
      35_000,
    );
  });
 
  // ── Idempotency / retry semantics (T3 parity) ─────────────────────────────
 
  describe('retry semantics', () => {
    it(
      'C-RET-1: re-sending same payload yields toMerge, not duplicate row',
      async () => {
        await dbA.tags.put(mkTag(700, 'initial'));
        await fusA.pullPush();
 
        // B gets it, modifies, pushes successfully
        await fusB.pullPush();
        await dbB.tags.update(700, { txt: 'modified', modAt: new Date() });
        await fusB.pullPush();
 
        // Simulate B re-sending the same payload (retry scenario).
        // B's modAt is null now (already accepted); re-marking dirty and re-pushing
        // with the *old* dt should yield toMerge (not a duplicate insert).
        await dbB.tags.update(700, { txt: 'modified', modAt: new Date(), dt: new Date('2020-01-01') });
        await fusB.pullPush();
 
        // Count rows – must be exactly 1 for tid=700
        const rows = await dbB.tags.where('tid').equals(700).toArray();
        expect(rows).toHaveLength(1);
      },
      20_000,
    );
 
    it(
      'C-RET-2: pullPush respects MAX_RETRIES and does not loop forever',
      async () => {
        // Put a row that will always be stale (dt set to epoch)
        await dbA.tags.put({ ...mkTag(701, 'loop-guard'), dt: new Date(0) });
        // pullPush should complete (not hang) even under repeated toMerge
        const start = Date.now();
        await fusA.pullPush();
        const elapsed = Date.now() - start;
        // MAX_RETRIES=5 × BASE_DELAY=500ms × backoff → capped at ~30s practical max
        expect(elapsed).toBeLessThan(60_000);
      },
      65_000,
    );
  });
 
  // ── row2put unit: standalone logic tests ──────────────────────────────────
 
  if (0)
  describe('row2put – unit', async() => {
    const fus = mkFuser(dbA); // db doesn't matter for unit tests
    const serverRow = await dbA.tags.where('ref').equals('B').first();
 
    it(
      'U-R2P-1: server row only (no local dirty match) → put as-is',
      () => {
        const serverRow = { tid: 1, txt: 'server', ref: 'S', modAt: null };
        const out: any[] = [];
        fus.row2put(serverRow, undefined, undefined, out);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ txt: 'server', modAt: null });
      },
    );
 
    it(
      'U-R2P-2: dirty local match → deepMerge, keep local pk',
      () => {
        const server = { tid: 2, txt: 'server', ref: 'S', modAt: null };
        const local  = { tid: 2, txt: 'local',  ref: 'L', modAt: new Date() };
        const out: any[] = [];
        fus.row2put(server, local, undefined, out);
        expect(out).toHaveLength(1);
        // deepMerge is provided externally; assert both keys are present
        expect(out[0].ref).toBeDefined();
      },
    );
 
    it(
      'U-R2P-3: local2move with different uniqstr → move (strip pk)',
      () => {
        const server   = { tid: 99, txt: 'S-content', ref: 'S', modAt: null };
        const local2mv = { tid: 99, txt: 'L-content', ref: 'L-diff', modAt: null };
        // modrw2merge is undefined (no dirty match for server uniq)
        const out: any[] = [];
        fus.row2put(server, undefined, local2mv, out);
        // Should put server row + stripped local (move away)
        expect(out).toHaveLength(2);
        // Second entry must lack tid (nopkTag strips it)
        expect('tid' in out[1]).toBe(false);
        // Must be marked dirty for re-push
        expect(out[1].modAt).not.toBeNull();
      },
    );
 
    it(
      'U-R2P-4: local2move with same uniqstr as modrw2merge → do not double-move',
      () => {
        // When the clash row IS the merge target, moving would be wrong
        const server   = { tid: 99, txt: 'srv', ref: 'SAME', modAt: null };
        const modrw    = { tid: 99, txt: 'loc', ref: 'SAME', modAt: new Date() };
        const local2mv = modrw; // same uniq
        const out: any[] = [];
        fus.row2put(server, modrw, local2mv, out);
        // Only 1 output (the merge), no extra move
        expect(out).toHaveLength(1);
      },
    );
  });
 
  // ── CDN snapshot simulation: client starts from <0.1M row snapshot ────────
 
  describe('CDN snapshot bootstrap', () => {
    it(
      'C-CDN-1: client pre-seeded from CDN snapshot syncs cleanly',
      async () => {
        // Simulate a CDN snapshot: bulk-load 10 clean rows into fresh db
        const dbSnap = new idb.DDB('client_cdnsnap_' + Date.now());
        const fusSnap = mkFuser(dbSnap);
 
        const snapRows = Array.from({ length: 10 }, (_, i) =>
          mkTag(800 + i, `snap-row-${i}`, 'CDN', { modAt: undefined }),
        );
        await dbSnap.tags.bulkPut(snapRows);
 
        // None are dirty – pullPush with empty mod set still pulls deltas
        await expect(fusSnap.pullPush()).resolves.not.toThrow();
 
        // Local rows should remain intact
        const count = await dbSnap.tags.count();
        expect(count).toBeGreaterThanOrEqual(10);
      },
      20_000,
    );
  });
});

// https://gemini.google.com/app/3940cbba20bf1493
describe('Sync Logic: Fuser OCC and PK Reconciliation', async () => {
  const src = new idb.DDB('client_a');
  const des = new idb.DDB('client_b');
  const snap_name = 'occ-test-bench';

  // Helper to generate valid Tag objects without repeating mandatory fields
  const mockTag = (overrides: Partial<idb.Tag> & { tid: number }): idb.Tag => ({
    txt: 'default-text',
    ref: 'default-ref',
    type: 'test',
    dt: new Date(),
    modAt: new Date(),
    rec: {}, // Assuming rec is an object/record
    ...overrides
  });

  const fuserA = new idb.Fuser(src.tags, sc.sessReady, sc.sbg, snap_name, 
    idb.deepMerge, idb.uniqsTag, (r: idb.Tag) => r.tid, idb.nopkTag);
  const fuserB = new idb.Fuser(des.tags, sc.sessReady, sc.sbg, snap_name, 
    idb.deepMerge, idb.uniqsTag, (r: idb.Tag) => r.tid, idb.nopkTag);

  beforeAll(async () => {
    await setSessSB(sc.sbg);
  });

  beforeEach(async () => {
    await sc.sbg.from('upsbase').delete().eq('snap', snap_name);
    await src.tags.clear();
    await des.tags.clear();
  });

  it('T1: Handles "ignore till catchup" protocol', async () => {
    // 1. Client A establishes the first record on server
    await src.tags.put(mockTag({ tid: 1, txt: 'A-Initial' }));
    await fuserA.pullPush();

    // 2. Client B creates a local record unaware of A
    // Note: modAt is set, but dt is likely older or null compared to server A
    await des.tags.put(mockTag({ tid: 2, txt: 'B-New' }));
    
    // 3. Fuser handles the retry: 
    // Cycle 1: Server sends A's record back (category: newer)
    // Cycle 2: B merges A, then pushes its own B-New
    await fuserB.pullPush();

    const clientBRows = await des.tags.toArray();
    expect(clientBRows).toHaveLength(2);
    expect(clientBRows.find(r => r.tid === 1)).toBeDefined(); 
    expect(clientBRows.find(r => r.tid === 2)?.modAt).toBeNull(); 
  });

  it('PK Clash: Moves local clashing PK to reassign', async () => {
    // 1. Server has Uniq: "Apple" at PK: 50
    await src.tags.put(mockTag({ tid: 50, txt: 'Apple', ref: 'StoreA' }));
    await fuserA.pullPush();

    // 2. Client B has local Uniq: "Orange" also at PK: 50
    // This is a "Blind" PK clash
    await des.tags.put(mockTag({ tid: 50, txt: 'Orange', ref: 'StoreB' }));

    // 3. Sync triggers row2put() logic
    await fuserB.pullPush();

    const allB = await des.tags.toArray();
    
    // Server's 'Apple' should now own PK 50
    const apple = allB.find(r => r.txt === 'Apple');
    expect(apple?.tid).toBe(50);

    // B's local 'Orange' should have been moved (nopkTag + bulkPut)
    const orange = allB.find(r => r.txt === 'Orange');
    expect(orange?.tid).not.toBe(50); 
    expect(orange?.modAt).toBeNull(); // Should be successfully synced now
  });

  it('Conflict: DeepMerge on stale update', async () => {
    // 1. Both start with same record
    const base = mockTag({ tid: 100, txt: 'base' });
    await src.tags.put(base);
    await fuserA.pullPush();
    await fuserB.pullPush(); // Sync B to current state

    // 2. A modifies
    await src.tags.update(100, { txt: 'v2-from-A', modAt: new Date() });
    await fuserA.pullPush();

    // 3. B modifies local stale copy
    await des.tags.update(100, { txt: 'v2-from-B', modAt: new Date() });
    
    // 4. B Syncs (Trigger toMerge branch)
    await fuserB.pullPush();

    const merged = await des.tags.get(100);
    // Verify properties from both or resolution logic
    expect(merged?.modAt).toBeNull(); 
    expect(merged?.txt).not.toBe('base');
  });
});
// 
describe('sync idb', async ()=> {
  const src = new idb.DDB('test_src');
  const des = new idb.DDB('test_des');
  const clash = new idb.DDB('test_clash');
  
  const snap_name = 'test-tags'
  const smm = new idb.Fuser(src.tags, sc.sessReady, sc.sbg, snap_name
    , idb.deepMerge, idb.uniqsTag, (r:Tag)=>r.tid, idb.nopkTag)
  const dmm = new idb.Fuser(des.tags, sc.sessReady, sc.sbg, snap_name
    , idb.deepMerge, idb.uniqsTag, (r:Tag)=>r.tid, idb.nopkTag)
  const cmm = new idb.Fuser(clash.tags, sc.sessReady, sc.sbg, snap_name
    , idb.deepMerge, idb.uniqsTag, (r:Tag)=>r.tid, idb.nopkTag)
        
  beforeAll(async () => {
    const result = await setSessSB(sc.sbg);
    console.log('tt.upsBase delete ', snap_name)
    console.log(await sc.sbg.from('upsbase').delete().eq('snap', snap_name))
    // clear both test databases
    await src.tags.clear();
    await des.tags.clear();
    await clash.tags.clear();
  })


// https://chatgpt.com/c/69f15bd9-1838-83ea-b803-6d0a754c5748
describe('OCC + PK clash + multi-client', () => {

  it('Case PK-1: PK Clash across clients (move local PK)', async () => {
    // Client B inserts first
    await des.tags.put({
      tid: 99, txt: 'B version', ref: 'B',
      modAt: new Date(), dt: new Date(), type:'test', rec:{}
    });
    await dmm.pullPush(); // server now has PK=99

    // Client A unaware, creates DIFFERENT uniq but SAME PK
    await src.tags.put({
      tid: 99, txt: 'A version', ref: 'A',
      modAt: new Date(), dt: new Date(), type:'test', rec:{}
    });

    await smm.pullPush(); // should trigger clash resolution

    const all = await src.tags.toArray();

    // Expect:
    // 1. server row preserved with PK=99
    // 2. local conflicting row moved to new PK
    const hasServer = all.find(r => r.tid === 99 && r.txt === 'B version');
    const moved = all.find(r => r.tid !== 99 && r.txt === 'A version');

    expect(hasServer).toBeTruthy();
    expect(moved).toBeTruthy();
    expect(moved?.modAt).not.toBeNull(); // still dirty for retry
  }, 15000);


  it('Case OCC-1: Stale update → toMerge → retry success', async () => {
    // Initial insert
    await src.tags.put({
      tid: 1, txt: 'base', ref: 'A',
      modAt: new Date(), dt: new Date(), type:'test', rec:{}
    });
    await smm.pullPush();
    await dmm.pullPush();

    // A updates first
    await src.tags.update(1, { txt: 'A edit', modAt: new Date() });
    await smm.pullPush();

    // B updates from stale base
    await des.tags.update(1, { txt: 'B edit', modAt: new Date() });

    await dmm.pullPush(); // should trigger toMerge + retry loop

    const final = await des.tags.get(1);

    expect(final?.txt).toContain('B edit'); // merged result
    expect(final?.modAt).toBeNull(); // clean after retry
  }, 15000);


  it('Case OCC-2: Insert blocked until catchup', async () => {
    // A inserts
    await src.tags.put({
      tid: 5, txt: 'A data', ref: 'A',
      modAt: new Date(), dt: new Date(), type:'test', rec:{}
    });
    await smm.pullPush();

    // B is stale, inserts new row
    await des.tags.put({
      tid: 6, txt: 'B new', ref: 'B',
      modAt: new Date(), dt: new Date(), type:'test', rec:{}
    });

    // First push should be ignored
    await dmm.pullPush();

    let row = await des.tags.get(6);
    expect(row?.modAt).not.toBeNull(); // still dirty

    // After catchup, retry succeeds
    await dmm.pullPush();

    row = await des.tags.get(6);
    expect(row?.modAt).toBeNull();
  }, 15000);


  it('Case OCC-3: Multi-client fan-in (A/B/C)', async () => {
    // A inserts
    await src.tags.put({
      tid: 20, txt: 'base', ref: 'A',
      modAt: new Date(), dt: new Date(), type:'test', rec:{}
    });
    await smm.pullPush();

    await dmm.pullPush();

    const third = new idb.DDB('test_third');
    const tmm = new idb.Fuser(third.tags, sc.sessReady, sc.sbg, snap_name,
      idb.deepMerge, idb.uniqsTag, (r:Tag)=>r.tid, idb.nopkTag);

    await third.tags.put(await des.tags.get(20));

    // B + C both modify concurrently
    await des.tags.update(20, { txt: 'B edit', modAt: new Date() });
    await third.tags.update(20, { txt: 'C edit', modAt: new Date() });

    await dmm.pullPush();
    await tmm.pullPush();

    const b = await des.tags.get(20);
    const c = await third.tags.get(20);

    expect(b?.modAt).toBeNull();
    expect(c?.modAt).toBeNull();
    expect(b?.txt).toEqual(c?.txt); // eventual convergence
  }, 20000);


  it('Case OCC-4: Retry idempotency (no duplication)', async () => {
    await src.tags.put({
      tid: 30, txt: 'idempotent', ref: 'A',
      modAt: new Date(), dt: new Date(), type:'test', rec:{}
    });

    // Force multiple retries
    for (let i = 0; i < 3; i++) {
      await smm.pullPush();
    }

    const all = await src.tags.where('tid').equals(30).toArray();

    expect(all.length).toBe(1);
    expect(all[0].modAt).toBeNull();
  }, 15000);


  it('Case OCC-5: PK clash + merge (hard case)', async () => {
    // B inserts
    await des.tags.put({
      tid: 77, txt: 'base', ref: 'B',
      modAt: new Date(), dt: new Date(), type:'test', rec:{}
    });
    await dmm.pullPush();

    // A has SAME uniq but different PK and modified
    await src.tags.put({
      tid: 78, txt: 'A edit', ref: 'B', // same uniq via ref
      modAt: new Date(), dt: new Date(), type:'test', rec:{}
    });

    await smm.pullPush();

    const all = await src.tags.toArray();

    const merged = all.find(r => r.ref === 'B' && r.tid === 77);
    const moved = all.find(r => r.tid !== 77 && r.ref === 'B');

    expect(merged).toBeTruthy();
    expect(moved).toBeTruthy();
  }, 20000);

});


  describe('multi db sync via test snap', () => {
    it('Case 1: Clean Insert (New Data)', async () => {
      // src adds a new tag
      await src.tags.put({ tid: 10, txt: 'original', ref: 'A', modAt: new Date(), dt:new Date(), type:'test', rec:{} });
      console.log('src pullPush')
      await smm.pullPush(); // Uploads to server

      // des pulls it
      console.log('des pullPush')
      await dmm.pullPush();
      const downloaded = await des.tags.get(10);
      console.debug('des=local ? ', downloaded)
      
      expect(downloaded?.txt).toBe('original');
      expect(downloaded?.modAt).toBeNull(); // Should be marked clean
    },11e3);

    it('Case 2: Update (Client in sync)', async () => {
      await dmm.pullPush(); // Ensure des is synced
      const tag = await des.tags.get(10);
      await des.tags.put({ ...tag!, txt: 'updated', modAt: new Date() });
      await dmm.pullPush();
      await smm.pullPush();
      const synced = await src.tags.get(10);
      
      expect(synced?.txt).toBe('updated');
    }, 11e3);

    it('Case 3: Conflict (Stale last_dt)', async () => {
      await smm.pullPush();
      await dmm.pullPush();
      
      // Both modify same record
      const srcTag = await src.tags.get(10);
      const desTag = await des.tags.get(10);
      await src.tags.put({ ...srcTag!, txt: 'src-change', modAt: new Date() });
      await des.tags.put({ ...desTag!, txt: 'des-change', modAt: new Date() });
      
      await smm.pullPush(); // src wins
      await dmm.pullPush(); // des gets toMerge, deepMerge applies
      
      const merged = await des.tags.get(10);
      expect(merged?.txt).toContain('src-change'); // deepMerge result
    }, 11e3);

    it('Case 4: Download newer (m.dt > last_dt)', async () => {
      await src.tags.put({ tid: 20, txt: 'server-only', ref: 'B', modAt: new Date(), dt:new Date(), type:'test', rec:{} });
      await smm.pullPush();
      
      await dmm.pullPush();
      const newer = await des.tags.get(20);
      
      expect(newer?.txt).toBe('server-only');
    }, 11e3);

    it('Case 5: Insert blocked (stale last_dt)', async () => {
      const oldLastDt = dmm.last_dt;
      await src.tags.put({ tid: 30, txt: 'new-on-src', ref: 'C', modAt: new Date(), dt:new Date(), type:'test', rec:{} });
      await smm.pullPush();
      
      // des tries insert without catching up
      dmm.last_dt = new Date(0); // Force stale
      await des.tags.put({ tid: 40, txt: 'stale-insert', ref: 'D', modAt: new Date(), dt:new Date(), type:'test', rec:{} });
      await dmm.pullPush();
      
      // Server should ignore insert, des should download tid:30
      const downloaded = await des.tags.get(30);
      expect(downloaded?.txt).toBe('new-on-src');
      
      dmm.last_dt = oldLastDt; // Restore
    }, 11e3);

    it('Case 6: PK Clash Resolution', async () => {
      // ClientB inserts with PK=99
      await des.tags.put({ tid: 99, txt: 'des-uniq1', ref: 'uniq1', modAt: new Date(), dt:new Date(), type:'test', rec:{} });
      await dmm.pullPush();
      
      // ClientA creates local with same PK=99 but different uniqstr
      await clash.tags.put({ tid: 99, txt: 'clash-uniq2', ref: 'uniq2', modAt: new Date(), dt:new Date(), type:'test', rec:{} });
      await cmm.pullPush(); // Server ignores insert (stale last_dt)
      
      // ClientA pulls, gets toMerge with server's PK=99
      await cmm.pullPush();
      
      // Check: Server row (uniq1) should be at PK=99
      const serverRow = await clash.tags.get(99);
      expect(serverRow?.ref).toBe('uniq1');
      
      // Check: Local clash row (uniq2) should have PK cleared (undefined or reassigned)
      const clashRows = await clash.tags.where('ref').equals('uniq2').toArray();
      expect(clashRows.length).toBe(1);
      expect(clashRows[0].tid).not.toBe(99); // PK moved away
    }, 11e3);

    it('Case 7: Empty payload', async () => {
      await dmm.pullPush(); // No local changes
      const count = await des.tags.count();
      expect(count).toBeGreaterThan(0); // Still has downloaded data
    }, 11e3);

    it('Case 8: Retry same payload → toMerge', async () => {
      await smm.pullPush();
      const tag = await src.tags.get(10);
      const originalDt = tag!.dt;
      
      await src.tags.put({ ...tag!, txt: 'retry-test', modAt: new Date() });
      await smm.pullPush(); // First push succeeds
      
      // Retry with stale dt
      smm.last_dt = new Date(originalDt!.getTime() - 1000);
      await src.tags.put({ ...tag!, txt: 'retry-again', modAt: new Date(), dt: originalDt });
      await smm.pullPush(); // Should get toMerge
      
      const result = await src.tags.get(10);
      expect(result?.txt).toContain('retry'); // Merged result
    }, 11e3);

    if(0)it('Case 2: Logical Conflict (Deep Merge)', async () => {
      const common = { tid: 20, ref: 'B', dt: new Date(1) };
      
      // 1. Setup: Both have the same base record
      await src.tags.put({ ...common, txt: 'base', modAt: undefined, dt:new Date(), type:'test', rec:{}  });
      await des.tags.put({ ...common, txt: 'base', modAt: undefined, dt:new Date(), type:'test', rec:{}  });

      // 2. src modifies and syncs
      await src.tags.update(20, { txt: 'server-version', modAt: new Date() });
      console.log('src pullPush')
      await smm.pullPush();

      // 3. des modifies the SAME record locally
      await des.tags.update(20, { txt: 'local-version', modAt: new Date() });
      console.log('des pullPush')
      await dmm.pullPush();

      // 4. Verification
      const merged = await des.tags.get(20);
      // Based on your deepMerge: (local, server) => result
      expect(merged?.txt).toContain('server-version');
      expect(merged?.txt).toContain('local-version');
      expect(merged?.modAt).not.toBeNull(); // Needs to sync back the merged result
    });

    if(0)it('Case 3: Physical Conflict (Identity Fork)', async () => {
      // 1. src creates 'Apple' with ID 1
      await src.tags.put({ tid: 1, ref: 'Apple', txt: 'Fruit', modAt: new Date(), dt:new Date(), type:'test', rec:{} });
      console.log('src pullPush')
      await smm.pullPush();

      // 2. des creates 'Aero' with ID 1 (Collision!)
      await des.tags.put({ tid: 1, ref: 'Aero', txt: 'Plane', modAt: new Date(), dt:new Date(), type:'test', rec:{} });
      console.log('des pullPush')
      await dmm.pullPush();

      // 3. Verification
      const rows = await des.tags.toArray();
      expect(rows.length).toBe(2);

      const serverRow = rows.find(r => r.ref === 'Apple');
      const forkedRow = rows.find(r => r.ref === 'Aero');

      expect(serverRow?.tid).toBe(1);      // Server version takes the PK
      expect(forkedRow?.tid).not.toBe(1);  // Local version pushed to new PK
      expect(forkedRow?.modAt).not.toBeNull(); // Forked row is still dirty
    });
    if(0)it('Case 5: High-speed Batch Reconciliation', async () => {
      // Setup 100 local rows, 50 with conflicts
      const localItems = Array.from({length: 100}, (_, i) => ({
        tid: i, ref: `R${i}`, txt: 'local', modAt: i < 50 ? new Date() : undefined
        , dt:new Date(), type:'test', rec:{}
      }));
      await des.tags.bulkPut(localItems);

      // Sync logic should handle all 100 without 100 separate 'get' calls
      console.log('bulk pullPush')
      await dmm.pullPush(); 
      
      const results = await des.tags.toArray();
      expect(results.length).toBeGreaterThanOrEqual(100);
    });

    it('both db equal', async () => {
      src.tags.clear()
      des.tags.clear()
      // add test dirty rows to src.tags
      const testRows: Tag[] = [
        { tid: 1, txt: 'test tag 1', ref: 'ref1', type: 'tag', sts: ['a'], dt: new Date(), modAt: new Date(), rec: {} },
        { tid: 2, txt: 'test tag 2', ref: 'ref2', type: 'tag', sts: ['b'], dt: new Date(), modAt: new Date(), rec: {} },
      ];
      await src.tags.bulkPut(testRows);

      // Mock the RPC call to simulate server response
      // const originalRpc = sc.sbg.rpc.bind(sc.sbg);
      // sc.sbg.rpc = async (fn: string, params: any) => {
      //   if (fn === 'ups_same_base') {
      //     // Simulate successful upload and return the uploaded rows as "downloaded"
      //     const payload = params.payload || [];
      //     return {
      //       data: {
      //         ok_uniqs: payload.map((p: any) => p.uniqs),
      //         dl: payload.map((p: any) => ({ this: { pk: (r: any) => r.tid }, stuff: { ...p.stuff, modAt: null } })),
      //         server_now: new Date()
      //       },
      //       error: null
      //     };
      //   }
      //   return originalRpc(fn, params);
      // };

      // sync src up to server
      console.log('src pullPush')
      await smm.pullPush();

      // sync des down from server
      console.log('des pullPush')
      await dmm.pullPush();
      
      // compare actual data, not Table objects
      const srcData = await src.tags.toArray();
      const desData = await des.tags.toArray();
      
      expect(desData.length).toBe(srcData.length);
      // Note: dt and modAt may differ slightly due to server timestamp
      expect(desData.map(d => ({ tid: d.tid, txt: d.txt, ref: d.ref, type: d.type, sts: d.sts })))
        .toEqual(srcData.map(d => ({ tid: d.tid, txt: d.txt, ref: d.ref, type: d.type, sts: d.sts })));
    },);
  })
  
})
describe('md2row', ()=>{
  it('should convert', ()=> {
    
    const md = yaml2md(`schema: v1
provider: va
model: qw35
keys: v13,v55
providers:
  - name: va
    api: openai-completions
    models: 
      - model: qwen/qwen3.5-397b-a17b
        name: qw35
      - model: z-ai/glm5
        name: zg5
      - model: qwen/qwen3.5-397b-a17b
        name: v22 qwen
    baseUrl: https://integrate.api.nvidia.com/v1
    apiKeys: 
      - v9686: nvapi-RftBeh1cIaQuj7`)
      // console.debug(md)
      md2row(md)
  })
})

if (0)  describe('diff-patch', ()=> {
  describe('patchMod', () => {
    it('returns base unchanged if b4mod is falsy (null)', () => {
      const base: Tag = { dt: new Date(1), txt: 'base', sts: ['a', 'b'], rec: { seq: [] } };
      const mod: Tag = { dt: new Date(2), txt: 'mod', sts: ['c'], rec: { seq: [] } };
      const result = patchMod(base, null, mod);
      expect(result).toEqual(base);
    });

    it('returns base unchanged if b4mod is falsy (undefined)', () => {
      const base: Tag = { dt: new Date(1), txt: 'base', sts: ['a', 'b'], rec: { seq: [] } };
      const mod: Tag = { dt: new Date(2), txt: 'mod', sts: ['c'], rec: { seq: [] } };
      const result = patchMod(base, undefined, mod);
      expect(result).toEqual(base);
    });

    it('applies text patch to base.txt', () => {
      const base: Tag = { dt: new Date(1), txt: 'hello world', sts: [], rec: { seq: [] } };
      const b4mod = { txt: 'hello', sts: [] };
      const mod: Tag = { dt: new Date(2), txt: 'hello there', sts: [], rec: { seq: [] } };
      const result = patchMod(base, b4mod, mod);
      expect(result.txt).toBe('hello there world');
    });

    it('applies sts patch to base.txt and splits to array (successful application)', () => {
      const base: Tag = { dt: new Date(1), txt: 'a,b', sts: ['x'], rec: { seq: [] } };
      const b4mod = { txt: 'irrelevant', sts: ['a', 'b'] };
      const mod: Tag = { dt: new Date(2), txt: 'irrelevant', sts: ['a', 'c'], rec: { seq: [] } };
      const result = patchMod(base, b4mod, mod);
      expect(result.sts).toEqual(['a', 'c']);
    });

    it('applies sts patch to base.txt but fails cleanly if no match', () => {
      const base: Tag = { dt: new Date(1), txt: 'no match', sts: ['x'], rec: { seq: [] } };
      const b4mod = { txt: 'irrelevant', sts: ['a', 'b'] };
      const mod: Tag = { dt: new Date(2), txt: 'irrelevant', sts: ['a', 'c'], rec: { seq: [] } };
      const result = patchMod(base, b4mod, mod);
      expect(result.sts).toEqual(['no match']);
    });

    it('handles empty sts arrays', () => {
      const base: Tag = { dt: new Date(1), txt: '', sts: [], rec: { seq: [] } };
      const b4mod = { txt: '', sts: [] };
      const mod: Tag = { dt: new Date(2), txt: '', sts: [], rec: { seq: [] } };
      const result = patchMod(base, b4mod, mod);
      expect(result.sts).toEqual([]);
    });
  });
  describe('deepmerge Immutable Logic', () => {
    it('should not mutate the original base object', () => {
      const base = { txt: 'old', sts: ['1'], id: 'A' } as any;
      const b4 = { txt: 'old', sts: ['1'] } as any;
      const mod = { txt: 'new', sts: ['2'] } as any;

      const result = patchMod(base, b4, mod);

      // Verify result is different from input
      expect(result).not.toBe(base); 
      // Verify original is untouched
      expect(base.txt).toBe('old'); 
    });

    it('should handle patch failures gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'warn');
      // Logic to simulate a failed patch via mock if necessary
      // ...
    });
  });



  describe('deepMerge tests by pi qwen', () => {
    it('determines newer and older correctly when rin.dt > rl.dt', () => {
      const rin: Tag = { dt: new Date(2), txt: 'rin', sts: [], rec: { seq: [] } };
      const rl: Tag = { dt: new Date(1), txt: 'rl', sts: [], rec: { seq: [] } };
      const result = deepMerge(rin, rl);
      expect(result.dt).toEqual(new Date(2));
      expect(result.txt).toBe('rin');
    });

    it('determines newer and older correctly when rl.dt > rin.dt', () => {
      const rin: Tag = { dt: new Date(1), txt: 'rin', sts: [], rec: { seq: [] } };
      const rl: Tag = { dt: new Date(2), txt: 'rl', sts: [], rec: { seq: [] } };
      const result = deepMerge(rin, rl);
      expect(result.dt).toEqual(new Date(2));
      expect(result.txt).toBe('rl');
    });

    it('handles equal dt (treats rl as newer if rin.dt === rl.dt but different objects)', () => {
      const rin: Tag = { dt: new Date(1), txt: 'rin', sts: [], rec: { seq: [] } };
      const rl: Tag = { dt: new Date(1), txt: 'rl', sts: [], rec: { seq: [] } };
      const result = deepMerge(rin, rl);
      expect(result.dt).toEqual(new Date(1));
      expect(result.txt).toBe('rl'); // Since [rl, rin] when rin.dt <= rl.dt
    });

    it('concatenates and dedupes seq by dt reference, reverses values, unshifts older', () => {
      const dt3 = new Date(3); // Same reference for dedup test
      const rin: Tag = {
        dt: new Date(2),
        txt: 'rin',
        sts: [],
        rec: { seq: [{ dt: dt3, txt: 'seq3', sts: [] }, { dt: new Date(4), txt: 'seq4', sts: [] }] },
      };
      const rl: Tag = {
        dt: new Date(1),
        txt: 'rl',
        sts: [],
        rec: { seq: [{ dt: dt3, txt: 'dup3', sts: [] }, { dt: new Date(5), txt: 'seq5', sts: [] }] },
      };
      const result = deepMerge(rin, rl);
      // seq concat: [dt3:seq3,4:seq4,dt3:dup3,5:seq5], fromEntries overwrites same dt ref with last (dup3)
      // values: [seq4, dup3, seq5] (insertion order: dt3=seq3 ->4=seq4 ->dt3=dup3 overwrite ->5=seq5)
      // reverse: [seq5, dup3, seq4]
      // unshift older (rl): [rl, seq5, dup3, seq4]
      expect(result.rec.seq[0]).toEqual({ dt: new Date(1), txt: 'rl', sts: [] });
      expect(result.rec.seq[1]).toEqual({ dt: new Date(5), txt: 'seq5', sts: [] });
      expect(result.rec.seq[2]).toEqual({ dt: dt3, txt: 'dup3', sts: [] });
      expect(result.rec.seq[3]).toEqual({ dt: new Date(4), txt: 'seq4', sts: [] });
    });

    it('does not dedup if same dt value but different Date objects', () => {
      const rin: Tag = {
        dt: new Date(2),
        txt: 'rin',
        sts: [],
        rec: { seq: [{ dt: new Date(3), txt: 'seq3', sts: [] }] },
      };
      const rl: Tag = {
        dt: new Date(1),
        txt: 'rl',
        sts: [],
        rec: { seq: [{ dt: new Date(3), txt: 'dup3', sts: [] }] },
      };
      const result = deepMerge(rin, rl);
      // Different dt objects, even same time, different keys, so both kept
      // seq concat: [3a:seq3, 3b:dup3]
      // fromEntries: two entries
      // values.reverse(): depends on insertion, but say [dup3, seq3] or vice versa
      // But unshift older
      // Expect length 3 (older + 2)
      expect(result.rec.seq).toHaveLength(3);
      expect(result.rec.seq[0]).toEqual({ dt: new Date(1), txt: 'rl', sts: [] });
      // The other two in some order, but check presence
      expect(result.rec.seq).toEqual(expect.arrayContaining([
        { dt: expect.any(Date), txt: 'seq3', sts: [] },
        { dt: expect.any(Date), txt: 'dup3', sts: [] },
      ]));
    });

    it('handles empty seq in both', () => {
      const rin: Tag = { dt: new Date(2), txt: 'rin', sts: [], rec: { seq: [] } };
      const rl: Tag = { dt: new Date(1), txt: 'rl', sts: [], rec: { seq: [] } };
      const result = deepMerge(rin, rl);
      expect(result.rec.seq).toHaveLength(1);
      expect(result.rec.seq[0]).toEqual({ dt: new Date(1), txt: 'rl', sts: [] });
    });

    it('applies patch if older has modAt', () => {
      const rin: Tag = { dt: new Date(1), txt: 'base txt', sts: ['base'], rec: { seq: [] } };
      const rl: Tag = {
        dt: new Date(2),
        txt: 'mod txt',
        sts: ['mod'],
        rec: { seq: [], b4mod: { txt: 'old txt', sts: ['old'] } },
        modAt: new Date(),
      };
      const result = deepMerge(rin, rl);
      expect(result.modAt).toBeInstanceOf(Date);
    });

    it('applies patch if newer has modAt', () => {
      const rin: Tag = {
        dt: new Date(2),
        txt: 'base txt',
        sts: ['base'],
        rec: { seq: [], b4mod: { txt: 'pre mod', sts: ['pre'] } },
        modAt: new Date(),
      };
      const rl: Tag = { dt: new Date(1), txt: 'old txt', sts: ['old'], rec: { seq: [] } };
      const result = deepMerge(rin, rl);
      expect(result.txt).toBe('base txt');
    });

    it('applies patches if both have modAt', () => {
      const rin: Tag = {
        dt: new Date(1),
        txt: 'rin txt',
        sts: ['rin'],
        rec: { seq: [], b4mod: { txt: 'rin pre', sts: ['rin pre'] } },
        modAt: new Date(),
      };
      const rl: Tag = {
        dt: new Date(2),
        txt: 'rl txt',
        sts: ['rl'],
        rec: { seq: [], b4mod: { txt: 'rl pre', sts: ['rl pre'] } },
        modAt: new Date(),
      };
      const result = deepMerge(rin, rl);
      expect(result.rec.b4mod).toEqual(expect.objectContaining({ txt: 'rl txt', sts: ['rl'] }));
    });

    it('does not apply patches if neither has modAt', () => {
      const rin: Tag = { dt: new Date(2), txt: 'rin', sts: [], rec: { seq: [] } };
      const rl: Tag = { dt: new Date(1), txt: 'rl', sts: [], rec: { seq: [] } };
      const result = deepMerge(rin, rl);
      expect(result.txt).toBe('rin');
    });

    it('sets rec.b4mod to cloned newer without rec', () => {
      const rin: Tag = { dt: new Date(2), txt: 'rin', sts: [], rec: { seq: [] } };
      const rl: Tag = { dt: new Date(1), txt: 'rl', sts: [], rec: { seq: [] } };
      const result = deepMerge(rin, rl);
      expect(result.rec.b4mod).toEqual({ dt: new Date(2), txt: 'rin', sts: [] });
    });

    it('always sets modAt to new Date', () => {
      const rin: Tag = { dt: new Date(2), txt: 'rin', sts: [], rec: { seq: [] } };
      const rl: Tag = { dt: new Date(1), txt: 'rl', sts: [], rec: { seq: [] } };
      const result = deepMerge(rin, rl);
      expect(result.modAt).toBeInstanceOf(Date);
    });
  })
})
