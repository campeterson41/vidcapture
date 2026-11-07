'use strict';
// Camera profiles: optional tuning for one camera model, kept as JSON data so
// the app itself stays general. A profile matches a camera by USB vendor and
// product ID and can:
//   - send vendor commands through the camera's UVC extension unit
//     (camera-controls.py runs them; nothing is saved to camera flash),
//   - correct lens distortion on the GPU (radial and offset coefficients),
//   - decode MJPEG on the Intel GPU for a low-latency 4K preview,
//   - show a short note in Camera settings.
// Profiles are read from camera-profiles/ beside the app and from the user's
// config folder (~/.config/vidcapture/camera-profiles/). A user profile with
// the same match replaces a bundled one. See camera-profiles/README.md.
const fs=require('node:fs/promises');
const path=require('node:path');

const HEX=/^(?:[0-9a-f]{2})+$/i;
const MATCH=/^usb:[0-9a-f]{4}:[0-9a-f]{4}$/;
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num=v=>typeof v==='number'&&Number.isFinite(v);
const text=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max?v.trim():null;

// Returns a clean profile or throws with the first problem found.
function validateProfile(raw){
  if(!raw||typeof raw!=='object')throw new Error('not an object');
  const name=text(raw.name,80);if(!name)throw new Error('name is required');
  const match=String(raw.match||'').toLowerCase();if(!MATCH.test(match))throw new Error('match must look like usb:046d:085e');
  const out={name,match,note:text(raw.note,240)};
  if(raw.extensionUnit!=null){
    const x=raw.extensionUnit;
    if(!x||typeof x!=='object')throw new Error('extensionUnit must be an object');
    if(!GUID.test(String(x.guid||'')))throw new Error('extensionUnit.guid must be a GUID');
    const size=x.size;if(!Number.isInteger(size)||size<1||size>64)throw new Error('extensionUnit.size must be 1 to 64');
    const sel=v=>Number.isInteger(v)&&v>=1&&v<=255;
    if(!sel(x.setSelector)||!sel(x.getSelector))throw new Error('extensionUnit selectors must be 1 to 255');
    const cmd=v=>typeof v==='string'&&HEX.test(v)&&v.length===size*2;
    if(!cmd(x.status))throw new Error(`extensionUnit.status must be ${size} bytes of hex`);
    if(!Array.isArray(x.ensure)||!x.ensure.length||x.ensure.length>16)throw new Error('extensionUnit.ensure needs 1 to 16 rules');
    const ensure=x.ensure.map((r,i)=>{
      if(!r||!Number.isInteger(r.byte)||r.byte<0||r.byte>=size||!Number.isInteger(r.equals)||r.equals<0||r.equals>255||!cmd(r.send))throw new Error(`extensionUnit.ensure[${i}] needs byte, equals and send`);
      return {byte:r.byte,equals:r.equals,send:r.send.toLowerCase()};
    });
    out.extensionUnit={guid:x.guid.toLowerCase(),size,setSelector:x.setSelector,getSelector:x.getSelector,status:x.status.toLowerCase(),ensure,
      error:text(x.error,160)||'The camera did not accept its profile.'};
  }
  if(raw.lensCorrection!=null){
    const l=raw.lensCorrection;
    if(!l||!Array.isArray(l.radial)||l.radial.length!==3||!l.radial.every(num))throw new Error('lensCorrection.radial needs 3 numbers');
    if(!Array.isArray(l.offset)||l.offset.length!==2||!l.offset.every(num))throw new Error('lensCorrection.offset needs 2 numbers');
    const fitted={};
    for(const [k,v] of Object.entries(l.fittedAt||{}))if(/^[a-z0-9_]{1,40}$/.test(k)&&Number.isInteger(v))fitted[k]=v;
    out.lensCorrection={radial:l.radial.slice(),offset:l.offset.slice(),fittedAt:fitted};
  }
  if(raw.gpuDecode!=null){
    if(raw.gpuDecode!=='intel')throw new Error('gpuDecode supports only "intel"');
    out.gpuDecode='intel';
  }
  return out;
}

async function readDir(dir,warn){
  let names=[];
  try{names=(await fs.readdir(dir)).filter(n=>n.endsWith('.json')).sort();}catch{return [];}
  const out=[];
  for(const n of names){
    try{out.push(validateProfile(JSON.parse(await fs.readFile(path.join(dir,n),'utf8'))));}
    catch(e){warn(`Camera profile ${n} was skipped: ${e.message}`);}
  }
  return out;
}

class CameraProfiles{
  constructor(dirs,{warn=m=>console.warn(m)}={}){this.dirs=dirs;this.warn=warn;this.list=[];}
  // Later folders win, so a user profile replaces a bundled one.
  async load(){
    const byMatch=new Map();
    for(const dir of this.dirs)for(const p of await readDir(dir,this.warn))byMatch.set(p.match,p);
    this.list=[...byMatch.values()];
    return this.list;
  }
  // key comes from cameraKey(): usb:VVVV:PPPP:SERIAL or card:<name>.
  forKey(key){
    const k=String(key||'').toLowerCase();
    return this.list.find(p=>k.startsWith(p.match+':'))||null;
  }
}

// What the interface needs to know; vendor commands stay in the main process.
function publicProfile(p){
  return p?{name:p.name,note:p.note||null,lensCorrection:!!p.lensCorrection,fittedAt:p.lensCorrection?{...p.lensCorrection.fittedAt}:{}}:null;
}

module.exports={CameraProfiles,validateProfile,publicProfile};
