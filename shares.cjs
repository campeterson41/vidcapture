'use strict';
// Remembers which recordings already have a link on vidcapture.stream, so
// sharing the same recording with the same edits never uploads it twice.
// The record lives in the recording's sidecar (<dataDir>/<name>.json) as
// "share", next to edits, titles and the restore pick, and moves with renames.
const fs=require('node:fs/promises');
const path=require('node:path');

const r3=v=>Math.round(Number(v)*1000)/1000;

// 'full' for the whole recording, else the kept sections, rounded the same way
// the editor saves them, so equal edits always produce the same key.
function planKey(keep,duration){
  if(!Array.isArray(keep)||!keep.length)return 'full';
  if(keep.length===1&&Number(keep[0][0])<=0.01&&Number.isFinite(duration)&&Number(keep[0][1])>=duration-0.01)return 'full';
  return JSON.stringify(keep.map(([a,b])=>[r3(a),r3(b)]));
}

function sidecar(dataDir,name){return path.join(dataDir,path.basename(name)+'.json');}

async function readMeta(dataDir,name){try{return JSON.parse(await fs.readFile(sidecar(dataDir,name),'utf8'));}catch{return {};}}

// Read, change, and replace the sidecar in one step so other fields survive.
async function updateMeta(dataDir,name,change){
  const file=sidecar(dataDir,name);
  const meta=await readMeta(dataDir,name);
  change(meta);
  const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp,JSON.stringify(meta),{mode:0o600});await fs.rename(tmp,file);
  return meta;
}

function validRecord(s,origin){
  return !!(s&&typeof s.id==='string'&&/^[a-f0-9-]{36}$/.test(s.id)&&typeof s.url==='string'&&s.url.startsWith(origin+'/v/')&&typeof s.planKey==='string');
}

// What the Library shows: the link, and whether edits changed since it was made.
function shareView(meta,origin){
  const s=meta&&meta.share;
  if(!validRecord(s,origin))return null;
  return {url:s.url,title:s.title||'',sharedAt:s.sharedAt||null,current:planKey(meta.keep,s.duration)===s.planKey};
}

module.exports={planKey,readMeta,updateMeta,shareView,validRecord};
