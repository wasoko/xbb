/**
 * @vitest-environment happy-dom
 */
import { createClient } from '@supabase/supabase-js';
import { it, expect, beforeAll, describe } from 'vitest';
import * as sc from '../src/sync'
import { setSessSB } from './global-setup';

const supabase = sc.sbg;


describe('sync idb', ()=> {
  beforeAll(async () => {
    // console.log('sc.sbg: ',sc.sbg)
    const result = await setSessSB(sc.sbg);
  })
  
describe('supabase get session', ()=> {
  it('should have a restored session automatically', async () => {
  // const { data: { session } } = await supabase.auth.getSession();
  
  expect(sc.sbg).not.toBeNull();
  // expect(sc.sbg?.).toBe(process.env.ACCESS_TOKEN);
});
})
})