// Initial placement of the recording controls. Stubs electron and hyprctl
// through child_process.execFile; never touches the real screen.
//
// A small fake compositor maps each new floating window where Hyprland does:
// at its window rule's monitor-relative move when the rule has one, otherwise
// centered on its monitor. The controls must appear at their final spot from
// the first frame, never at the center first: a recording of an area that
// covers the center would otherwise capture them for a frame before place()
// moves them (seen as one frame in a test recording).
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const cp=require('node:child_process');

let MONS=[],rules=[],log=[],clientList=[];
const monitorOf=title=>{
  const rule=[...rules].reverse().find(r=>r.includes(title));
  const name=rule&&rule.match(/monitor="([^"]+)"/);
  const mon=MONS.find(m=>name&&m.name===name[1])||MONS[0];
  return {rule,mon};
};
cp.execFile=function(cmd,args,opts,cb){
  if(typeof opts==='function'){cb=opts;opts={};}
  Promise.resolve().then(()=>{
    if(cmd!=='hyprctl')return '';
    if(args[0]==='monitors')return JSON.stringify(MONS);
    if(args[0]==='clients')return JSON.stringify(clientList);
    if(args[0]==='eval'){rules.push(args[1]);log.push('rule');return 'ok';}
    if(args[0]==='dispatch'){
      const m=args[1].match(/window\.move\(\{window="address:(0x[0-9a-f]+)",x=(-?\d+),y=(-?\d+)\}\)/);
      if(m){log.push('move');for(const c of clientList)if(c.address===m[1])c.at=[+m[2],+m[3]];}
      return 'ok';
    }
    return '[]';
  }).then(out=>cb(null,{stdout:out,stderr:''}),e=>cb(e));
};

const logical=m=>({x:m.x,y:m.y,width:Math.floor(m.width/m.scale),height:Math.floor(m.height/m.scale)});
class FakeWin{
  constructor(o){this.o=o;this.destroyed=false;this.handlers={};this.webContents={sent:[],send:(c,d)=>this.webContents.sent.push([c,d]),setWindowOpenHandler(){},on(){},session:{setPermissionRequestHandler(){}}};log.push('window');}
  isDestroyed(){return this.destroyed;}
  destroy(){this.destroyed=true;(this.handlers.closed||[]).forEach(f=>f());}
  on(e,f){(this.handlers[e]||(this.handlers[e]=[])).push(f);}
  once(e,f){this.on(e,f);}
  loadFile(){return Promise.resolve();}
  // Fake compositor: map now, at the rule's move or centered on the monitor.
  showInactive(){
    const {rule,mon}=monitorOf(this.o.title),L=logical(mon),w=this.o.width,h=this.o.height;
    const mv=rule&&rule.match(/move=\{"(-?\d+)","(-?\d+)"\}/);
    const at=mv?[L.x+ +mv[1],L.y+ +mv[2]]:[L.x+Math.round((L.width-w)/2),L.y+Math.round((L.height-h)/2)];
    const c={pid:process.pid,title:this.o.title,mapped:true,floating:true,pinned:true,size:[w,h],at,address:'0x'+(clientList.length+1).toString(16)};
    clientList.push(c);this.firstMapped={x:at[0],y:at[1],width:w,height:h};log.push('map');
    setTimeout(()=>(this.handlers['ready-to-show']||[]).forEach(f=>f()),0);
  }
  show(){this.showInactive();}
}
const electron={BrowserWindow:Object.assign(FakeWin,{fromWebContents:()=>null}),ipcMain:{handle(){}}};
const origLoad=Module._load;
Module._load=function(req,...rest){if(req==='electron')return electron;return origLoad.call(this,req,...rest);};
const {Surfaces}=require('../surfaces.cjs');

const meter={start(){},stop(){},update(){}};
const intersects=(a,b)=>a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height;
const delay=ms=>new Promise(r=>setTimeout(r,ms));

async function openFor(monitors,target,only=[]){
  MONS=monitors;rules=[];log=[];clientList=[];
  const recorder={state:{phase:'recording',target,settings:{camera:'none'},devices:{microphones:[],cameras:[]},shortcuts:{}},
    snapshot(){return structuredClone(this.state);},set(d){Object.assign(this.state,d);}};
  const s=new Surfaces({recorder,showMain(){},hideMain(){},takeMeter:meter});
  s.only=only;s.barIcon=async()=>false;s.syncLevel=()=>{};s.syncStage=()=>{};
  s.update(recorder.state);
  for(let i=0;i<100&&!(s.controls&&s.controls.address);i++)await delay(5);
  assert.ok(s.controls&&s.controls.address,'controls placed');
  const win=s.controls,c=clientList.find(x=>x.address===win.address);
  return {s,win,spot:win.spot,first:win.firstMapped,final:{x:c.at[0],y:c.at[1],width:c.size[0],height:c.size[1]}};
}

const EDP={name:'eDP-1',x:0,y:0,width:1920,height:1080,scale:1.5,transform:0,reserved:[0,0,0,0],activeWorkspace:{id:1},specialWorkspace:{id:0}};

test('controls for a partial area first appear at their spot, outside the recording',async()=>{
  const target={kind:'region',x:12,y:38,width:640,height:360};
  const {spot,first,final}=await openFor([EDP],target,['eDP-1']);
  assert.deepEqual({x:spot.x,y:spot.y,width:spot.width,height:spot.height},{x:182,y:414,width:300,height:44});
  assert.ok(!intersects(first,target),`first mapped at ${first.x},${first.y}, inside the recorded area`);
  assert.deepEqual(first,{x:182,y:414,width:300,height:44});
  assert.deepEqual(final,first,'place() finds them already there');
  assert.ok(log.indexOf('rule')<log.indexOf('window'),'the rule exists before the window');
  assert.ok(!log.includes('move'),'no corrective move was needed');
});

test('the move is relative to the monitor when it is not at the origin',async()=>{
  // Laptop to the left of a larger display (negative x), and one below it (positive y).
  for(const origin of [{x:-1280,y:0},{x:3440,y:360}]){
    const lap={...EDP,...origin};
    const wide={name:'DP-7',x:0,y:0,width:3440,height:1440,scale:1,transform:0,reserved:[0,0,0,0],activeWorkspace:{id:3},specialWorkspace:{id:0}};
    const target={kind:'region',x:origin.x+12,y:origin.y+38,width:640,height:360};
    const {spot,first,final}=await openFor([wide,lap],target,['eDP-1']);
    assert.equal(spot.monitor,'eDP-1');
    assert.match(rules.find(r=>r.includes('VidCapture controls')),new RegExp(`move=\\{"${spot.x-origin.x}","${spot.y-origin.y}"\\}`));
    assert.deepEqual(first,{x:spot.x,y:spot.y,width:300,height:44},`origin ${origin.x},${origin.y}`);
    assert.ok(!intersects(first,target));
    assert.deepEqual(final,first);
  }
});

test('the collapsed corner dot first appears in its corner, not the center',async()=>{
  // An area filling the whole laptop display with no other display free: the
  // controls fold into the recorded corner dot.
  const target={kind:'region',x:0,y:0,width:1280,height:720};
  const {spot,first,final,win}=await openFor([EDP],target,['eDP-1']);
  assert.equal(spot.collapsed,true);assert.equal(spot.recorded,true);
  assert.deepEqual(first,{x:spot.x,y:spot.y,width:28,height:28});
  assert.deepEqual(final,first);
  assert.equal(win.o.title.startsWith('VidCapture controls'),true);
  assert.ok(first.x<=12+1&&first.y+28>=720-12-1,'bottom-left corner of the usable area');
});

test('controls on another display keep their bottom-center spot from the start',async()=>{
  const wide={name:'DP-7',x:1280,y:0,width:3440,height:1440,scale:1,transform:0,reserved:[0,0,0,0],activeWorkspace:{id:3},specialWorkspace:{id:0}};
  const target={kind:'monitor',monitor:'eDP-1'};
  const {spot,first,final}=await openFor([EDP,wide],target);
  assert.equal(spot.monitor,'DP-7');
  assert.deepEqual(first,{x:spot.x,y:spot.y,width:300,height:44});
  assert.deepEqual(final,first);
});
