// On-screen surfaces: the launcher bar, the picker overlays, and the floating
// recording controls. Each is a small Electron window placed with Hyprland.
const {BrowserWindow,ipcMain}=require('electron');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const geometry=require('./ui/geometry.js');
const run=promisify(execFile);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const LIVE=new Set(['recording','paused']);
const BUSY=new Set(['selecting','starting','recording','paused','stopping']);
const BAR={width:392,height:52};
const PILL={width:212,height:44};
const DOT={width:28,height:28};
const TITLES={bar:'VidCapture bar',controls:'VidCapture controls',picker:id=>`VidCapture picker ${id}`};
const lua=s=>JSON.stringify(String(s));

async function hypr(args,timeout=3000){return (await run('hyprctl',args,{timeout})).stdout;}
async function dispatch(command){return hypr(['dispatch',command]);}
async function clients(){return JSON.parse(await hypr(['clients','-j']));}
async function monitors(){return JSON.parse(await hypr(['monitors','-j'])).filter(m=>!m.disabled).map(geometry.logicalMonitor);}

class Surfaces{
  constructor({recorder,showMain,hideMain,mainVisible,preload}){
    this.recorder=recorder;this.showMain=showMain;this.hideMain=hideMain;this.mainVisible=mainVisible||(()=>false);this.preload=preload||path.join(__dirname,'surfaces-preload.cjs');
    this.bar=null;this.overlays=new Map();this.controls=null;this.picker=null;this.controlsBusy=null;
    // Optional test limit, for example CAPTURE_PICKER_MONITORS=eDP-1.
    this.only=(process.env.CAPTURE_PICKER_MONITORS||'').split(',').map(s=>s.trim()).filter(Boolean);
    this.registerIpc();
  }

  async rule(name,title,extra){
    const base=`float=true,pin=true,no_anim=true,no_blur=true,no_shadow=true,no_dim=true,decorate=false,border_size=0,rounding=0,opacity="1.0 override 1.0 override",tag="-default-opacity"`;
    await hypr(['eval',`hl.window_rule({name=${lua(name)},match={class="^capture$",title=${lua('^'+title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')}},${base}${extra?','+extra:''}})`]);
  }

  // Finds our window by process and title, then floats, pins, sizes and moves it.
  async place(win,title,rect){
    for(let i=0;i<60;i++){
      if(win.isDestroyed())return null;
      const c=(await clients()).find(c=>c.pid===process.pid&&c.title===title&&c.mapped);
      if(c){
        const w=`address:${c.address}`;
        if(!c.floating)await dispatch(`hl.dsp.window.float({window="${w}",action="set"})`);
        if(!c.pinned)await dispatch(`hl.dsp.window.pin({window="${w}",action="set"})`);
        if(c.size[0]!==rect.width||c.size[1]!==rect.height)await dispatch(`hl.dsp.window.resize({window="${w}",x=${rect.width},y=${rect.height}})`);
        if(c.at[0]!==rect.x||c.at[1]!==rect.y)await dispatch(`hl.dsp.window.move({window="${w}",x=${rect.x},y=${rect.y}})`);
        return c.address;
      }
      await delay(50);
    }
    return null;
  }

  async moveTo(address,rect){
    const w=`address:${address}`;
    await dispatch(`hl.dsp.window.resize({window="${w}",x=${rect.width},y=${rect.height}})`);
    await dispatch(`hl.dsp.window.move({window="${w}",x=${rect.x},y=${rect.y}})`);
  }

  window(kind,title,rect,page,query={}){
    const win=new BrowserWindow({width:rect.width,height:rect.height,title,frame:false,transparent:true,backgroundColor:'#00000000',resizable:kind==='controls',minWidth:16,minHeight:16,skipTaskbar:true,show:false,alwaysOnTop:true,
      webPreferences:{preload:this.preload,contextIsolation:true,nodeIntegration:false,sandbox:true}});
    win.surfaceKind=kind;
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',e=>e.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc,_p,cb)=>cb(false));
    // Keep the page title fixed so Hyprland rules keep matching.
    win.on('page-title-updated',e=>e.preventDefault());
    win.loadFile(path.join(__dirname,'ui',page),{query}).then(()=>{if(win.isDestroyed())return;if(kind==='controls')win.showInactive();else win.show();}).catch(()=>{});
    return win;
  }

  async laptop(){
    const ms=await monitors();
    return {ms,home:ms.find(m=>m.internal)||ms[0]};
  }

  async focusAddress(address){
    if(!address||!/^0x[0-9a-f]+$/i.test(address))return;
    try{if((await clients()).some(c=>c.address===address&&c.mapped&&!c.hidden))await dispatch(`hl.dsp.focus({window="address:${address}"})`);}catch{}
  }

  busy(){return BUSY.has(this.recorder.state.phase)||this.recorder.state.job?.running;}

  /* Launcher bar */

  async openBar({origin='bar'}={}){
    if(this.busy()){this.showMain();return;}
    await this.closePicker();
    if(this.bar&&!this.bar.isDestroyed()){await this.focusAddress(this.bar.address);return;}
    if(origin==='main'){this.restoreMain=true;this.hideMain();}
    this.barOrigin=origin;
    if(!this.previousFocus)this.previousFocus=await this.activeAddress();
    const {home}=await this.laptop();
    const rect=geometry.barPlacement(home,BAR);
    await this.rule('vidcapture-bar',TITLES.bar,`monitor=${lua(home.id)},size={${BAR.width},${BAR.height}}`);
    const bar=this.window('bar',TITLES.bar,rect,'bar.html');this.bar=bar;
    bar.on('closed',()=>{if(this.bar===bar)this.bar=null;});
    bar.once('ready-to-show',async()=>{bar.address=await this.place(bar,TITLES.bar,rect);await this.focusAddress(bar.address);});
  }

  closeBar(){const b=this.bar;this.bar=null;if(b&&!b.isDestroyed())b.destroy();}

  async dismissBar(){
    const origin=this.barOrigin;this.closeBar();
    if(origin==='main'||this.restoreMain)this.showMain();else{await this.focusAddress(this.previousFocus);}
    this.previousFocus=null;this.restoreMain=false;
  }

  async activeAddress(){
    try{const a=JSON.parse(await hypr(['activewindow','-j']));return a?.address&&!/^capture(?:-|$)/.test(a.class||'')?a.address:null;}catch{return null;}
  }

  /* Picker overlays */

  async openPicker(mode,{intent='record',origin='bar'}={}){
    if(!['window','area','display'].includes(mode))throw new Error('Unknown picker mode.');
    if(this.busy())throw new Error('Stop and save this recording first.');
    if(this.picker){this.setMode(mode);return;}
    if(!this.previousFocus)this.previousFocus=await this.activeAddress();
    if(origin!=='bar')this.barOrigin=origin;
    // The main window would sit under the dimmed overlay; bring it back on cancel.
    if(origin==='main'||this.mainVisible())this.restoreMain=true;
    this.closeBar();this.hideMain();
    const [ms,list]=await Promise.all([monitors(),clients()]);
    const home=ms.find(m=>m.internal)||ms[0];
    const shown=ms.filter(m=>!this.only.length||this.only.includes(m.id));
    if(!shown.length)throw new Error('No display is available for picking.');
    const picker={mode,intent,origin:this.barOrigin||origin,monitors:ms,windows:geometry.visibleWindows(list,ms),toolbar:(shown.find(m=>m.id===home.id)||shown[0]).id,selection:null};
    this.picker=picker;
    let cursor=null;try{cursor=JSON.parse(await hypr(['cursorpos','-j']));}catch{}
    const placements=[];
    for(const m of shown){
      const title=TITLES.picker(m.id),rect={x:m.x,y:m.y,width:m.width,height:m.height};
      await this.rule(`vidcapture-picker-${m.id}`,title,`monitor=${lua(m.id)},size={${m.width},${m.height}}`);
      const win=this.window('picker',title,rect,'picker.html',{monitor:m.id});win.monitorId=m.id;
      this.overlays.set(m.id,win);
      win.on('closed',()=>{if(this.overlays.get(m.id)===win)this.overlays.delete(m.id);});
      placements.push(new Promise(resolve=>win.once('ready-to-show',async()=>{win.address=await this.place(win,title,rect);resolve(win);})));
    }
    const placed=await Promise.all(placements);
    if(this.picker!==picker)return;
    const under=cursor&&geometry.monitorAt(shown,cursor.x,cursor.y);
    const focus=placed.find(w=>w.monitorId===(under?.id||picker.toolbar))||placed[0];
    await this.focusAddress(focus?.address);
  }

  pickerData(win){
    const p=this.picker;if(!p)return null;
    const monitor=p.monitors.find(m=>m.id===win.monitorId);
    return {mode:p.mode,intent:p.intent,monitor,monitors:p.monitors,windows:p.windows,toolbar:p.toolbar===win.monitorId,selection:p.selection};
  }

  broadcast(channel,data){for(const w of this.overlays.values())if(!w.isDestroyed())w.webContents.send(channel,data);}

  setMode(mode){
    if(!this.picker||!['window','area','display'].includes(mode))return;
    this.picker.mode=mode;this.picker.selection=null;
    this.broadcast('vc:mode',mode);this.broadcast('vc:selection',null);
  }

  // Selections from the page are checked against the snapshot taken when the
  // picker opened, so a page cannot ask for arbitrary targets.
  normalize(sel){
    const p=this.picker;if(!p||!sel||typeof sel!=='object')return null;
    if(sel.kind==='window'){
      const w=p.windows.find(w=>w.address===sel.address);if(!w)return null;
      return {kind:'window',address:w.address,title:w.title,rect:{x:w.x,y:w.y,width:w.width,height:w.height},id:`window:${w.address}`};
    }
    if(sel.kind==='monitor'){
      const m=p.monitors.find(m=>m.id===sel.monitor);if(!m)return null;
      return {kind:'monitor',monitor:m.id,rect:{x:m.x,y:m.y,width:m.width,height:m.height},id:m.id};
    }
    if(sel.kind==='region'){
      const r=sel.rect||{};const m=geometry.monitorAt(p.monitors,Number(r.x),Number(r.y));if(!m)return null;
      const rect=geometry.dragRect({x:Number(r.x),y:Number(r.y)},{x:Number(r.x)+Number(r.width),y:Number(r.y)+Number(r.height)},m);
      if(!rect)return null;
      return {kind:'region',rect,monitor:m.id,id:geometry.regionId(rect)};
    }
    return null;
  }

  select(sel){
    if(!this.picker)return null;
    this.picker.selection=sel===null?null:this.normalize(sel);
    this.broadcast('vc:selection',this.picker.selection);
    return this.picker.selection;
  }

  async closePicker(){
    const had=!!this.picker;this.picker=null;
    for(const w of this.overlays.values())if(!w.isDestroyed())w.destroy();
    this.overlays.clear();
    return had;
  }

  async cancelPicker(){
    const p=this.picker;if(!p)return;
    const origin=p.origin;await this.closePicker();
    if(origin==='main'||this.restoreMain)this.showMain();else await this.focusAddress(this.previousFocus);
    this.previousFocus=null;this.barOrigin=null;this.restoreMain=false;
  }

  async confirm(){
    const p=this.picker;const sel=p?.selection;if(!sel)throw new Error('Choose a window, area, or display first.');
    const intent=p.intent,origin=p.origin,previous=this.previousFocus;
    const restore=this.restoreMain;await this.closePicker();this.previousFocus=null;this.barOrigin=null;this.restoreMain=false;
    try{
      await this.recorder.chooseTarget(sel.id);
      if(sel.kind==='window')await this.focusAddress(sel.address);else await this.focusAddress(previous);
      if(intent==='record'){this.hideMain();await this.recorder.start();}
      else if(origin==='main'||restore)this.showMain();
    }catch(e){this.recorder.set({error:e.message});this.showMain();}
  }

  /* Recording controls */

  update(state){
    if(LIVE.has(state.phase)){
      if(!this.controls&&!this.controlsBusy)this.controlsBusy=this.openControls(state).catch(e=>console.error('controls',e)).finally(()=>{this.controlsBusy=null;});
      else if(this.controls&&!this.controls.isDestroyed())this.controls.webContents.send('vc:state',{phase:state.phase,elapsed:state.elapsed});
    }else{
      this.closeControls();
      if(BUSY.has(state.phase)){this.closeBar();if(this.picker)this.closePicker();}
    }
  }

  async openControls(state){
    const target=state.target;if(!target)return;
    const ms=(await monitors()).filter(m=>!this.only.length||this.only.includes(m.id));
    const spot=geometry.pillPlacement({target,monitors:ms,pill:PILL,dot:DOT,cameraCorner:state.settings?.cameraCorner});
    if(!LIVE.has(this.recorder.state.phase))return;
    await this.rule('vidcapture-controls',TITLES.controls,`monitor=${lua(spot.monitor)},size={${spot.width},${spot.height}},no_initial_focus=true`);
    const win=this.window('controls',TITLES.controls,spot,'controls.html',{collapsed:spot.collapsed?'1':'0'});
    win.spot=spot;this.controls=win;
    win.on('closed',()=>{if(this.controls===win)this.controls=null;});
    await new Promise(r=>win.once('ready-to-show',r));
    win.address=await this.place(win,TITLES.controls,spot);
    if(!win.isDestroyed())win.webContents.send('vc:state',{phase:this.recorder.state.phase,elapsed:this.recorder.snapshot().elapsed});
    if(!LIVE.has(this.recorder.state.phase))this.closeControls();
  }

  closeControls(){const c=this.controls;this.controls=null;if(c&&!c.isDestroyed())c.destroy();}

  // Expands the corner dot into the full controls, or folds them back.
  async setExpanded(expanded){
    const win=this.controls;if(!win||win.isDestroyed()||!win.address||!win.spot?.collapsed)return;
    const c=(await clients()).find(c=>c.address===win.address);if(!c)return;
    const ms=await monitors();const m=ms.find(m=>m.id===win.spot.monitor)||ms[0];
    const current={x:c.at[0],y:c.at[1],width:c.size[0],height:c.size[1]};
    const next=expanded?geometry.expandFromDot(current,PILL,m):(()=>{
      const right=current.x+current.width/2>m.x+m.width/2;
      return {x:right?current.x+current.width-DOT.width:current.x,y:current.y+current.height-DOT.height,width:DOT.width,height:DOT.height};
    })();
    await this.moveTo(win.address,next);
    if(!win.isDestroyed())win.webContents.send('vc:expanded',expanded);
  }

  /* IPC */

  registerIpc(){
    const owned=(event,kinds)=>{
      const win=BrowserWindow.fromWebContents(event.sender);
      if(!win||!kinds.includes(win.surfaceKind)||event.senderFrame!==event.sender.mainFrame)throw new Error('Untrusted surface.');
      return win;
    };
    const handlers={
      pickerData:[['picker'],(win)=>this.pickerData(win)],
      setMode:[['picker'],(_w,mode)=>this.setMode(mode)],
      select:[['picker'],(_w,sel)=>this.select(sel)],
      confirm:[['picker'],()=>this.confirm()],
      cancel:[['picker'],()=>this.cancelPicker()],
      openPicker:[['bar'],(_w,mode)=>this.openPicker(mode,{intent:'record',origin:'bar'})],
      closeBar:[['bar'],()=>this.dismissBar()],
      controlsState:[['controls'],()=>{const s=this.recorder.snapshot();return {phase:s.phase,elapsed:s.elapsed,collapsed:!!this.controls?.spot?.collapsed};}],
      pause:[['controls'],()=>this.recorder.pause()],
      stop:[['controls'],()=>{this.closeControls();return this.recorder.stop().catch(e=>this.recorder.set({error:e.message})).finally(()=>this.showMain());}],
      expand:[['controls'],(_w,on)=>this.setExpanded(!!on)],
    };
    for(const [name,[kinds,fn]] of Object.entries(handlers))ipcMain.handle(`vc:${name}`,async(event,...args)=>{const win=owned(event,kinds);return fn(win,...args);});
  }

  dispose(){this.closeBar();this.closePicker();this.closeControls();}
}

module.exports={Surfaces,BAR,PILL,DOT};
