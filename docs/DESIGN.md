## Goal
- $ idio fac discovery
- $$ converge attn
- index cache to dist server
- auto-tag grouped/linked web of tree views

## Structure
- tag table: txt,url,sts[](string tags), dt
- full table snap on s3, uniqs keyed delta in psql, save gated by server time dt.
- download & merge delta before save
- settree table: fullPath-value pairs of settings
- flow: sync AI-tagged url/title md pin-tags across devices
- thanks to: pi(Mario Zechner) dexie three.js chrome supabase webgpu

### Requirement
- Chromium-based browser with WebGPU enabled
  - Chrome 113+ (you may need `chrome://flags/#enable-unsafe-webgpu`)
  - e.g. android 5+ opera 58

## Robust
- bun playwright
- wc -l