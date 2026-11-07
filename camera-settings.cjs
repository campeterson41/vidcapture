'use strict';
// Standard UVC camera controls (exposure, white balance, focus, zoom and so on)
// for any webcam, read and written through v4l2-ctl. Values live on the camera
// only while it is powered, so the chosen values are saved per physical camera
// (USB vendor, product and serial) and applied again whenever the camera opens.
// The file is plain JSON in the user config folder (~/.config/vidcapture/
// camera-settings.json): { "usb:VVVV:PPPP:SERIAL": { "controls": { name: value } } },
// or "card:<device name>" when no USB IDs can be read.
// Nothing here writes camera firmware or persistent camera memory.
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);

// Friendly names and sections. Controls not listed here still appear under Other.
const KNOWN={
  auto_exposure:{label:'Exposure',section:'exposure',order:1},
  exposure_time_absolute:{label:'Shutter',section:'exposure',order:2},
  gain:{label:'Gain',section:'exposure',order:3},
  backlight_compensation:{label:'Backlight compensation',section:'exposure',order:4},
  exposure_dynamic_framerate:{label:'Slower in low light',section:'exposure',order:5},
  white_balance_automatic:{label:'Auto white balance',section:'color',order:1},
  white_balance_temperature:{label:'Color temperature',section:'color',order:2,unit:'K'},
  brightness:{label:'Brightness',section:'color',order:3},
  contrast:{label:'Contrast',section:'color',order:4},
  saturation:{label:'Saturation',section:'color',order:5},
  hue:{label:'Hue',section:'color',order:6},
  gamma:{label:'Gamma',section:'color',order:7},
  sharpness:{label:'Sharpness',section:'color',order:8},
  focus_automatic_continuous:{label:'Autofocus',section:'framing',order:1},
  focus_absolute:{label:'Focus',section:'framing',order:2},
  zoom_absolute:{label:'Zoom',section:'framing',order:3},
  pan_absolute:{label:'Pan',section:'framing',order:4},
  tilt_absolute:{label:'Tilt',section:'framing',order:5},
  power_line_frequency:{label:'Anti-flicker',section:'other',order:1},
};
const MENU_LABELS={
  auto_exposure:{0:'Auto',1:'Manual',2:'Shutter priority',3:'Auto'},
  power_line_frequency:{0:'Off',1:'50 Hz',2:'60 Hz',3:'Auto'},
};
// Auto modes go first so the manual values that depend on them are accepted.
const APPLY_FIRST=['auto_exposure','white_balance_automatic','focus_automatic_continuous','exposure_dynamic_framerate'];

function pretty(name){const s=name.replace(/_/g,' ');return s.charAt(0).toUpperCase()+s.slice(1);}

// Parses `v4l2-ctl --list-ctrls-menus`. Only int, bool and menu controls are offered.
function parseControls(text){
  const out=[];let current=null;
  for(const line of String(text).split('\n')){
    const c=line.match(/^\s*([a-z0-9_]+)\s+0x[0-9a-f]+\s+\((int|bool|menu|intmenu)\)\s*:\s*(.*)$/);
    if(c){
      const [,name,type,rest]=c;const field=k=>{const m=rest.match(new RegExp(`\\b${k}=(-?\\d+)`));return m?Number(m[1]):undefined;};
      const flags=(rest.match(/flags=([a-z, -]+)/)?.[1]||'').split(',').map(s=>s.trim());
      if(flags.includes('read-only')||flags.includes('write-only')||flags.includes('disabled')){current=null;continue;}
      const meta=KNOWN[name]||{label:pretty(name),section:'other',order:50};
      current={name,type:type==='intmenu'?'menu':type,label:meta.label,section:meta.section,order:meta.order,unit:meta.unit||null,
        min:type==='bool'?0:field('min'),max:type==='bool'?1:field('max'),step:field('step')||1,default:field('default'),value:field('value'),
        inactive:flags.includes('inactive'),options:type==='menu'||type==='intmenu'?[]:null};
      if(!Number.isFinite(current.value)){current=null;continue;}
      out.push(current);continue;
    }
    const m=line.match(/^\s+(\d+):\s*(.+)$/);
    if(m&&current&&current.options){
      const v=Number(m[1]);current.options.push({value:v,label:MENU_LABELS[current.name]?.[v]||m[2].trim()});
    }
  }
  const rank={exposure:0,color:1,framing:2,other:3};
  return out.sort((a,b)=>rank[a.section]-rank[b.section]||a.order-b.order||a.name.localeCompare(b.name));
}

function validValue(control,value){
  const v=Number(value);
  if(!Number.isInteger(v))return null;
  if(control.type==='bool')return v===0||v===1?v:null;
  if(control.type==='menu')return control.options.some(o=>o.value===v)?v:null;
  if(v<control.min||v>control.max)return null;
  return control.min+Math.round((v-control.min)/control.step)*control.step;
}

function validDevice(device){if(!/^\/dev\/video\d+$/.test(String(device)))throw new Error('Choose a camera first.');return device;}

// A stable key for the physical camera, so settings follow it across ports and reboots.
async function cameraKey(device,exec=run){
  validDevice(device);
  try{
    const node=await fs.realpath(path.join('/sys/class/video4linux',path.basename(device),'device'));
    let dir=node;
    for(let i=0;i<6&&dir!=='/';i++,dir=path.dirname(dir)){
      const read=f=>fs.readFile(path.join(dir,f),'utf8').then(s=>s.trim()).catch(()=>'');
      const vendor=await read('idVendor');
      if(vendor){const product=await read('idProduct'),serial=await read('serial');return `usb:${vendor}:${product}:${serial||'-'}`;}
    }
  }catch{}
  const {stdout}=await exec('v4l2-ctl',['-d',device,'--info'],{timeout:3000});
  return 'card:'+(stdout.match(/Card type\s*:\s*(.+)/)?.[1]?.trim()||path.basename(device));
}

class CameraSettings{
  constructor(dataDir,options={}){this.file=path.join(dataDir,'camera-settings.json');this.v4l2=options.v4l2||'v4l2-ctl';this.exec=options.exec||run;this.queue=Promise.resolve();}
  async readAll(){try{const d=JSON.parse(await fs.readFile(this.file,'utf8'));return d&&typeof d==='object'?d:{};}catch{return {};}}
  async writeAll(all){await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});const tmp=`${this.file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(all,null,1),{mode:0o600});await fs.rename(tmp,this.file);}
  // One change at a time, so quick slider moves never interleave saves.
  serial(work){const next=this.queue.then(work,work);this.queue=next.catch(()=>{});return next;}
  async controls(device){
    const {stdout}=await this.exec(this.v4l2,['-d',validDevice(device),'--list-ctrls-menus'],{timeout:4000});
    return parseControls(stdout);
  }
  async list(device){
    const [controls,key]=await Promise.all([this.controls(device),cameraKey(device,this.exec)]);
    const saved=(await this.readAll())[key]?.controls||{};
    return {key,controls,saved:Object.keys(saved)};
  }
  async setOne(device,controls,name,value){
    const control=controls.find(c=>c.name===name);if(!control)throw new Error('This camera does not have that setting.');
    const v=validValue(control,value);if(v===null)throw new Error(`${control.label} is out of range.`);
    await this.exec(this.v4l2,['-d',device,'-c',`${name}=${v}`],{timeout:4000});
    return v;
  }
  // Changes one control now and remembers it for this camera.
  set(device,name,value){
    return this.serial(async()=>{
      const controls=await this.controls(device),key=await cameraKey(device,this.exec);
      const v=await this.setOne(device,controls,name,value);
      const all=await this.readAll();const entry=all[key]||(all[key]={controls:{}});entry.controls[name]=v;entry.updatedAt=new Date().toISOString();
      await this.writeAll(all);
      return this.list(device);
    });
  }
  // Puts every control back to the camera's own default and forgets saved values.
  reset(device){
    return this.serial(async()=>{
      const controls=await this.controls(device),key=await cameraKey(device,this.exec);
      const first=controls.filter(c=>APPLY_FIRST.includes(c.name)),rest=controls.filter(c=>!APPLY_FIRST.includes(c.name));
      for(const c of [...rest,...first])if(Number.isFinite(c.default)&&c.value!==c.default)await this.setOne(device,controls,c.name,c.default).catch(()=>{});
      const all=await this.readAll();delete all[key];await this.writeAll(all);
      return this.list(device);
    });
  }
  // Applies saved values when the camera opens. Unknown or out-of-range values are skipped.
  apply(device){
    return this.serial(async()=>{
      const key=await cameraKey(device,this.exec),saved=(await this.readAll())[key]?.controls;
      if(!saved||!Object.keys(saved).length)return {applied:0};
      let controls=await this.controls(device),applied=0;
      const names=Object.keys(saved);
      for(const name of names.filter(n=>APPLY_FIRST.includes(n))){try{await this.setOne(device,controls,name,saved[name]);applied++;}catch{}}
      if(applied)controls=await this.controls(device);
      for(const name of names.filter(n=>!APPLY_FIRST.includes(n))){
        // A manual value is ignored by the camera while its auto mode is on.
        if(controls.find(c=>c.name===name)?.inactive)continue;
        try{await this.setOne(device,controls,name,saved[name]);applied++;}catch{}
      }
      return {applied};
    });
  }
}

module.exports={CameraSettings,parseControls,validValue,cameraKey,KNOWN};
