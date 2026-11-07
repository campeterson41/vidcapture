const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {parseCombo,label,configCombos,shortcutsFrom,install}=require('../hotkeys.cjs');

const LAUNCHER='/home/u/.local/bin/capture';
function hypr(files){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'capture-hotkeys-'));
  const dir=path.join(root,'.config','hypr');fs.mkdirSync(dir,{recursive:true});
  for(const [name,text] of Object.entries(files))fs.writeFileSync(path.join(dir,name),text);
  return {root,dir};
}

test('combos parse from Lua and conf styles and print for tooltips',()=>{
  assert.deepEqual(parseCombo('SUPER + ALT + R'),{mods:72,key:'R'});
  assert.deepEqual(parseCombo('SUPER ALT','r'),{mods:72,key:'R'});
  assert.equal(label({mods:72,key:'R'}),'Super+Alt+R');
  assert.equal(label({mods:69,key:'PRINT'}),'Super+Ctrl+Shift+Print');
  const found=configCombos('o.bind("SUPER + ALT + R", "x", "y")\nhl.bind(\'CTRL + P\', f)\nbind = SUPER SHIFT, S, exec, shot\nbindd = $mainMod, Q, Close, killactive');
  assert.deepEqual(found.map(c=>label(c)),['Super+Alt+R','Ctrl+P','Super+Shift+S','Super+Q']);
});

test('tooltips read the live binds by description or by command',()=>{
  const binds=[{modmask:72,key:'R',description:'VidCapture start or stop recording',arg:'3'},{modmask:65,key:'P',description:'',arg:'/x/capture --toggle-pause'},{modmask:64,key:'Q',description:'Close',arg:''}];
  assert.deepEqual(shortcutsFrom(binds),{record:'Super+Alt+R',pause:'Super+Shift+P'});
  assert.deepEqual(shortcutsFrom(null),{});
});

test('Omarchy Lua config gets a binds file and one load line, with a backup',()=>{
  const h=hypr({'hyprland.lua':'require("default.hypr.omarchy")\n','bindings.lua':'o.bind("SUPER + RETURN", "Terminal", "ghostty")\n'});
  try{
    const r=install({hyprDir:h.dir,launcher:LAUNCHER,binds:[],now:1});
    assert.equal(r.status,'added');assert.deepEqual(r.added,['Super+Alt+R','Super+Alt+P']);
    const binds=fs.readFileSync(path.join(h.dir,'vidcapture-binds.lua'),'utf8');
    assert.match(binds,/hl\.bind\("SUPER \+ ALT \+ R", hl\.dsp\.exec_cmd\("\/home\/u\/\.local\/bin\/capture --toggle-recording"\)/);
    assert.match(binds,/--toggle-pause/);
    const main=fs.readFileSync(path.join(h.dir,'hyprland.lua'),'utf8');
    assert.equal(main.match(/VidCapture shortcuts/g).length,1);assert.match(main,/pcall\(dofile, ".*vidcapture-binds\.lua"\)/);
    assert.equal(fs.readFileSync(path.join(h.dir,'hyprland.lua.bak-vidcapture-1'),'utf8'),'require("default.hypr.omarchy")\n');
    // A second install keeps everything as it is, even though the live binds now include ours.
    const again=install({hyprDir:h.dir,launcher:LAUNCHER,binds:[{modmask:72,key:'R',description:'VidCapture start or stop recording'}],now:2});
    assert.equal(again.status,'kept');
    assert.equal(fs.readFileSync(path.join(h.dir,'hyprland.lua'),'utf8'),main);
    assert.ok(!fs.existsSync(path.join(h.dir,'hyprland.lua.bak-vidcapture-2')));
  }finally{fs.rmSync(h.root,{recursive:true,force:true});}
});

test('a key already bound by the user or the live session is left alone',()=>{
  const h=hypr({'hyprland.lua':'-- config\n','bindings.lua':'o.bind("SUPER + ALT + R", "Mine", "something")\n'});
  try{
    const r=install({hyprDir:h.dir,launcher:LAUNCHER,binds:[]});
    assert.deepEqual(r.added,['Super+Alt+P']);assert.deepEqual(r.skipped,['Super+Alt+R']);
    assert.doesNotMatch(fs.readFileSync(path.join(h.dir,'vidcapture-binds.lua'),'utf8'),/toggle-recording/);
  }finally{fs.rmSync(h.root,{recursive:true,force:true});}
  const both=hypr({'hyprland.lua':'-- config\n'});
  try{
    const r=install({hyprDir:both.dir,launcher:LAUNCHER,binds:[{modmask:72,key:'r'},{modmask:72,key:'P'}]});
    assert.equal(r.status,'skipped');
    assert.ok(!fs.existsSync(path.join(both.dir,'vidcapture-binds.lua')));
    assert.equal(fs.readFileSync(path.join(both.dir,'hyprland.lua'),'utf8'),'-- config\n');
  }finally{fs.rmSync(both.root,{recursive:true,force:true});}
});

test('Omarchy default bindings count as taken when Hyprland is not running',()=>{
  const h=hypr({'hyprland.lua':'-- config\n'});
  const defaults=fs.mkdtempSync(path.join(os.tmpdir(),'capture-omarchy-'));
  fs.mkdirSync(path.join(defaults,'bindings'));fs.writeFileSync(path.join(defaults,'bindings','x.lua'),'o.bind("SUPER + ALT + P", "Default", "x")\n');
  try{
    const r=install({hyprDir:h.dir,launcher:LAUNCHER,binds:null,defaults:[defaults]});
    assert.deepEqual(r.added,['Super+Alt+R']);
  }finally{fs.rmSync(h.root,{recursive:true,force:true});fs.rmSync(defaults,{recursive:true,force:true});}
});

test('hyprland.conf setups get a sourced conf file; other files are never replaced',()=>{
  const h=hypr({'hyprland.conf':'bind = SUPER, Q, killactive\n'});
  try{
    const r=install({hyprDir:h.dir,launcher:LAUNCHER,binds:[]});
    assert.equal(r.mode,'conf');
    assert.match(fs.readFileSync(path.join(h.dir,'vidcapture-binds.conf'),'utf8'),/^bindd = SUPER ALT, R, VidCapture start or stop recording, exec, \/home\/u\/\.local\/bin\/capture --toggle-recording$/m);
    assert.match(fs.readFileSync(path.join(h.dir,'hyprland.conf'),'utf8'),/^source = .*vidcapture-binds\.conf # VidCapture shortcuts$/m);
  }finally{fs.rmSync(h.root,{recursive:true,force:true});}
  const foreign=hypr({'hyprland.lua':'-- config\n','vidcapture-binds.lua':'-- someone else\n'});
  try{
    assert.equal(install({hyprDir:foreign.dir,launcher:LAUNCHER,binds:[]}).status,'skipped');
    assert.equal(fs.readFileSync(path.join(foreign.dir,'vidcapture-binds.lua'),'utf8'),'-- someone else\n');
  }finally{fs.rmSync(foreign.root,{recursive:true,force:true});}
  const none=hypr({});
  try{assert.equal(install({hyprDir:none.dir,launcher:LAUNCHER,binds:[]}).status,'skipped');}finally{fs.rmSync(none.root,{recursive:true,force:true});}
});
