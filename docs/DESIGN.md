
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
- Chromium-based browser with WebGPU enabled
  - Chrome 113+ (you may need `chrome://flags/#enable-unsafe-webgpu`)
  - e.g. android 5+ opera 58

## Robust
- vitest playwright
- wc -l