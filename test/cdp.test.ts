import { describe, it, expect, beforeAll } from 'vitest';
import http from 'http';
import https from 'https';

const BASE_URL = 'http://localhost:5173';
const CDP_URL = 'http://localhost:9222';

async function cdpGet(endpoint: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(`${CDP_URL}${endpoint}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

async function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

describe('Grid Coverage via CDP', () => {
  let cdpAvailable = false;

  beforeAll(async () => {
    try {
      await cdpGet('/json/version');
      cdpAvailable = true;
    } catch {
      cdpAvailable = false;
    }
  }, 10000);
  it('CDP connection available', async () => {
    expect(cdpAvailable).toBe(true);
  });

  it('CDP /json endpoint returns targets', async () => {
    const targets = await cdpGet('/json');
    expect(Array.isArray(targets)).toBe(true);
  });

  it('CDP /json/version returns browser info', async () => {
    const version = await cdpGet('/json/version');
    expect(version).toHaveProperty('Browser');
  });
});
