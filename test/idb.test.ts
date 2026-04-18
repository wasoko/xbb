/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import {Tag, deepMerge, patchMod} from '../src/idb'
import { md2row, yaml2md } from '../src/conv_md_yaml';
import * as idb from '../src/idb'
import * as sc from '../src/sync'
import { describe, it, expect, beforeAll } from 'vitest';
import diff_match_patch from 'diff-match-patch'; // Assume installed via npm i diff-match-patch
import { setSessSB } from './global-setup';

describe('sync idb', ()=> {
  beforeAll(async () => {
    const result = await setSessSB(sc.sbg);
  })
  describe('multi db sync via test snap', () => {
    it('both db equal', async () => {
      const src = new idb.DDB('test_src');
      const des = new idb.DDB('test_des');
      
      // clear both test databases
      await src.tags.clear();
      await des.tags.clear();

      const smm = new sc.MergingMan(src.tags, 'test-tags'
        , idb.deepMerge, idb.uniqsTag, (r:Tag)=>r.tid,idb.nopkTag)
      const dmm = new sc.MergingMan(des.tags, 'test-tags'
        , idb.deepMerge, idb.uniqsTag, (r:Tag)=>r.tid,idb.nopkTag)
        
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
      await smm.syncAll();

      // sync des down from server
      await dmm.syncAll();
      
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

  describe('deepMerge', () => {
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
