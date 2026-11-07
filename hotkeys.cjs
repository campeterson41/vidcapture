'use strict';
// Global shortcuts. Electron's globalShortcut does not work reliably under
// Wayland, so Hyprland itself binds the keys and runs `capture --toggle-recording`
// or `capture --toggle-pause`, which reach the running app through its
// single-instance handoff. install.sh adds the binds only where the keys are
// free; the app reads the live binds back to show them in tooltips.
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');

const MARK='VidCapture shortcuts';
const ACTIONS=[
  {id:'record',flag:'--toggle-recording',keys:'SUPER + ALT + R',description:'VidCapture start or stop recording'},
  {id:'pause',flag:'--toggle-pause',keys:'SUPER + ALT + P',description:'VidCapture pause or resume recording'},
];
const MODS={SUPER:64,WIN:64,MOD4:64,LOGO:64,META:64,ALT:8,MOD1:8,CTRL:4,CONTROL:4,SHIFT:1};
const MOD_NAMES=[[64,'Super'],[4,'Ctrl'],[8,'Alt'],[1,'Shift']];

// "SUPER + ALT + R", "SUPER ALT, R" or "$mainMod SHIFT" style text to {mods,key}.
function parseCombo(text,key){
  let mods=0;const parts=String(text).split(/[\s+]+/).filter(Boolean);
  if(key===undefined)key=parts.pop();
  for(const p of parts){const m=MODS[p.toUpperCase().replace(/^\$MAINMOD$/,'SUPER')];if(m)mods|=m;}
  return {mods,key:String(key||'').trim().toUpperCase()};
}
const comboId=c=>`${c.mods}:${c.key}`;
function label(c){
  const key=c.key.length===1?c.key:c.key.charAt(0)+c.key.slice(1).toLowerCase();
  return [...MOD_NAMES.filter(([bit])=>c.mods&bit).map(([,n])=>n),key].join('+');
}

// Binds from `hyprctl binds -j`, as combos.
function liveCombos(binds){
  return (Array.isArray(binds)?binds:[]).filter(b=>b&&typeof b.key==='string'&&b.key&&!b.submap).map(b=>({mods:Number(b.modmask)||0,key:b.key.toUpperCase(),description:b.description||'',arg:String(b.arg||'')}));
}

// Binds written in config text: Lua (o.bind / hl.bind) and hyprland.conf bind lines.
function configCombos(text){
  const out=[];
  for(const m of String(text).matchAll(/(?:\bo|\bhl)\.bind\(\s*["']([^"']+)["']/g))out.push(parseCombo(m[1]));
  for(const m of String(text).matchAll(/^\s*bind[a-z]*\s*=\s*([^,\n]*),\s*([^,\n]+)/gm))out.push(parseCombo(m[1],m[2]));
  return out;
}

// What the app shows in tooltips: the keys Hyprland currently binds to each action.
function shortcutsFrom(binds){
  const out={};
  for(const b of liveCombos(binds)){
    for(const a of ACTIONS){
      if(out[a.id])continue;
      if(b.description===a.description||new RegExp(`(^|\\s)${a.flag}(\\s|$)`).test(b.arg))out[a.id]=label(b);
    }
  }
  return out;
}

function luaFile(launcher,actions){
  const q=s=>JSON.stringify(s);
  return [`-- ${MARK} (managed by VidCapture install.sh).`,
    '-- Delete this file to remove them; the matching line in hyprland.lua is harmless without it.',
    ...actions.map(a=>`hl.bind(${q(a.keys)}, hl.dsp.exec_cmd(${q(`${launcher} ${a.flag}`)}), { description = ${q(a.description)} })`),''].join('\n');
}
function confFile(launcher,actions){
  return [`# ${MARK} (managed by VidCapture install.sh).`,
    ...actions.map(a=>{const c=parseCombo(a.keys);const mods=MOD_NAMES.filter(([bit])=>c.mods&bit).map(([,n])=>n.toUpperCase()).join(' ');return `bindd = ${mods}, ${c.key}, ${a.description}, exec, ${launcher} ${a.flag}`;}),''].join('\n');
}

function readSafe(file){try{return fs.readFileSync(file,'utf8');}catch{return '';}}
function configTexts(dir,extra=[]){
  const texts=[];
  const walk=(d,depth)=>{
    let entries=[];try{entries=fs.readdirSync(d,{withFileTypes:true});}catch{return;}
    for(const e of entries){
      const p=path.join(d,e.name);
      if(e.isDirectory()&&depth<2)walk(p,depth+1);
      else if(e.isFile()&&/\.(lua|conf)$/.test(e.name))texts.push(readSafe(p));
    }
  };
  walk(dir,0);for(const d of extra)walk(d,0);
  return texts;
}

// Adds the binds to a Hyprland config folder. Returns what it did, for install.sh to print.
// options: {hyprDir, launcher, binds (live hyprctl binds or null), defaults (extra folders to scan), now}
function install({hyprDir,launcher,binds=null,defaults=[],now=Date.now()}){
  const lua=path.join(hyprDir,'hyprland.lua'),conf=path.join(hyprDir,'hyprland.conf');
  const mode=fs.existsSync(lua)?'lua':fs.existsSync(conf)?'conf':null;
  if(!mode)return {status:'skipped',message:'No Hyprland config found, so no shortcuts were added.'};
  const main=mode==='lua'?lua:conf,file=path.join(hyprDir,`vidcapture-binds.${mode}`);
  const loadLine=mode==='lua'?`pcall(dofile, ${JSON.stringify(file)}) -- ${MARK}`:`source = ${file} # ${MARK}`;
  const existing=readSafe(file);
  if(existing&&!existing.includes(MARK))return {status:'skipped',message:`${file} exists and is not VidCapture's. It was left alone.`};
  let created=false,added=[];
  if(!existing){
    const ours=new Set(ACTIONS.map(a=>comboId(parseCombo(a.keys))));
    const taken=new Set([...liveCombos(binds),...configTexts(hyprDir,defaults).flatMap(configCombos)].map(comboId));
    // Our own binds (from an earlier install) do not count as conflicts.
    for(const b of liveCombos(binds))if(ACTIONS.some(a=>b.description===a.description||b.arg.includes(a.flag)))taken.delete(comboId(b));
    added=ACTIONS.filter(a=>!taken.has(comboId(parseCombo(a.keys))));
    if(!added.length)return {status:'skipped',message:'Super+Alt+R and Super+Alt+P are already in use, so no shortcuts were added.',conflicts:[...ours]};
    fs.writeFileSync(file,(mode==='lua'?luaFile:confFile)(launcher,added),{mode:0o644});created=true;
  }
  const text=readSafe(main);
  if(!text.includes(loadLine)){
    fs.copyFileSync(main,`${main}.bak-vidcapture-${now}`);
    fs.appendFileSync(main,`${text.endsWith('\n')||!text?'':'\n'}${loadLine}\n`);
  }
  const skipped=ACTIONS.filter(a=>created&&!added.includes(a));
  return {status:created?'added':'kept',file,mode,added:added.map(a=>label(parseCombo(a.keys))),skipped:skipped.map(a=>label(parseCombo(a.keys)))};
}

// `node hotkeys.cjs install HOME LAUNCHER` from install.sh. Live changes happen
// only for the signed-in user's own config in a running Hyprland session.
if(require.main===module&&process.argv[2]==='install'){
  const [home,launcher]=process.argv.slice(3);
  if(!home||!launcher){console.error('Usage: hotkeys.cjs install HOME LAUNCHER');process.exit(2);}
  if(process.env.CAPTURE_NO_HOTKEYS==='1'){console.log('Shortcuts skipped (CAPTURE_NO_HOTKEYS=1).');process.exit(0);}
  let binds=null;try{binds=JSON.parse(execFileSync('hyprctl',['binds','-j'],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','ignore']}));}catch{}
  const omarchy=process.env.OMARCHY_PATH||'/usr/share/omarchy';
  const result=install({hyprDir:path.join(home,'.config','hypr'),launcher,binds,defaults:[path.join(omarchy,'default','hypr')]});
  if(result.status==='skipped'){console.log(result.message);process.exit(0);}
  if(result.status==='added'){
    console.log(`Added shortcuts: ${result.added.join(', ')}${result.skipped.length?` (already in use: ${result.skipped.join(', ')})`:''}.`);
    const live=home===require('node:os').homedir()&&process.env.HYPRLAND_INSTANCE_SIGNATURE&&process.env.CAPTURE_INSTALL_LIVE!=='0';
    if(live){
      try{
        // A full reload, not an eval of the new file: Hyprland may already have reloaded on its
        // own when the config changed, and evaluating the file again would bind each key twice.
        execFileSync('hyprctl',['reload'],{timeout:5000,stdio:'ignore'});
      }catch{console.log('The shortcuts work after Hyprland next reloads its config.');}
    }
  }else console.log('Shortcuts already installed.');
}

module.exports={ACTIONS,MARK,parseCombo,label,liveCombos,configCombos,shortcutsFrom,install};
