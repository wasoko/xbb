/**
 * @vitest-environment happy-dom
 */
import { createClient } from '@supabase/supabase-js';
import { it, expect, beforeAll, describe } from 'vitest';
import * as sc from '../src/sync'
import { setupSB } from './global-setup';

const supabase = sc.sbg;


describe('sync idb', ()=> {
  beforeAll(async () => {
    const result = await setupSB();
  })
  
describe('supabase get session', ()=> {
  it('should have a restored session automatically', async () => {
  // const { data: { session } } = await supabase.auth.getSession();
  
  expect(sc.sbg).not.toBeNull();
  // expect(sc.sbg?.).toBe(process.env.ACCESS_TOKEN);
});
})
})