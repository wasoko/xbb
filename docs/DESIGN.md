
## FIXME asap
- sync test across dummy dbs
- e2e test grid filter/pan 
- title sync /w hash route

## TODO someday
- Merge progress

## Structure
* dexie
  - tag table: txt,url,sts[](string tags), dt
  - full snap on s3, uniqs keyed delta in psql, save gated by server time dt.
  - download & merge delta before save
* filter+search => top-pick +rest => tagged rows
* flow: sync AI-tagged url/title md pin-tags across devices
* thanks to: pi(Mario Zechner) 3.js webgpu dexie supabase

### Requirement
- Chromium-based browser with WebGL 2: the sea draws through three.js, which asks the
  canvas for a `webgl2` context itself and has no WebGL 1 path (`src/ui/SeaView.tsx`)
  - Chrome/Edge 113+, e.g. android 5+ opera 58
- `src/webgpu.ts` exists but nothing imports it; WebGPU is not a requirement

## Robust
- vitest playwright
- wc -l