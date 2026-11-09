// On-screen surfaces: the launcher bar, the picker overlays, and the floating
// recording controls. Each is a small Electron window placed with Hyprland.
const {BrowserWindow,ipcMain}=require('electron');
const {displayName}=require('./names.cjs');
const path=require('node:path');
const {execFile,spawn}=require('node:child_process');
const {promisify}=require('node:util');
const geometry=require('./ui/geometry.js');
const {TakeMeter,peakScanner,peakLevel}=require('./take-meter.cjs');
const run=promisify(execFile);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const LIVE=new Set(['recording','paused']);
const BUSY=new Set(['selecting','starting','recording','paused','stopping']);
const BAR={width:392,height:52};
const PILL={width:300,height:44};
const DOT={width:28,height:28};
const PANEL={width:380,height:580};
const COUNT={width:168,height:168};
// A per-run suffix keeps other apps from matching these windows' rules by title.
const RUN=require('node:crypto').randomBytes(3).toString('hex');
const TITLES={frame:`VidCapture outline ${RUN}`,panel:`VidCapture panel ${RUN}`,bar:`VidCapture bar ${RUN}`,controls:`VidCapture controls ${RUN}`,countdown:`VidCapture countdown ${RUN}`,picker:id=>`VidCapture picker ${RUN} ${id}`};
const lua=s=>JSON.stringify(String(s));
const fs=require('node:fs/promises');
const os=require('node:os');

async function hypr(args,timeout=3000){return (await run('hyprctl',args,{timeout})).stdout;}
async function dispatch(command){return hypr(['dispatch',command]);}
async function clients(){return JSON.parse(await hypr(['clients','-j']));}
async function monitors(){return JSON.parse(await hypr(['monitors','-j'])).filter(m=>!m.disabled).map(m=>({...geometry.logicalMonitor(m),label:displayName(m)}));}

class Surfaces{
  constructor({recorder,showMain,hideMain,mainVisible,sendMain,preload,onSettings,takeMeter}){
    // Microphone indicator on the recording controls (take-meter.cjs). It runs only while
    // the controls are open during a recording or paused take.
    this.takeMeter=takeMeter||new TakeMeter({onUpdate:m=>this.sendMic(m)});
    // onSettings runs after the panel saves settings, so the main process can follow along (live mic chain).
    this.onSettings=onSettings||(async()=>{});
    this.recorder=recorder;this.sendMain=sendMain||(()=>{});this.mainLevel=false;this.mainSnapshot=null;this.showMain=showMain;this.hideMain=hideMain;this.mainVisible=mainVisible||(()=>false);this.preload=preload||path.join(__dirname,'surfaces-preload.cjs');
    this.bar=null;this.panel=null;this.panelArgs={};this.panelSnapshot=null;this.overlays=new Map();this.controls=null;this.picker=null;this.controlsBusy=null;
    // Optional test limit, for example CAPTURE_PICKER_MONITORS=eDP-1.
    this.only=(process.env.CAPTURE_PICKER_MONITORS||'').split(',').map(s=>s.trim()).filter(Boolean);
    this.registerIpc();
  }

  async rule(name,title,extra){
    const base=`float=true,pin=true,no_anim=true,no_blur=true,no_shadow=true,no_dim=true,decorate=false,border_size=0,rounding=0,opacity="1.0 override 1.0 override",tag="-default-opacity"`;
    await hypr(['eval',`hl.window_rule({name=${lua(name)},match={class="^(vid)?capture$",title=${lua('^'+title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')}},${base}${extra?','+extra:''}})`]);
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
    // Pickers must stay resizable: on Wayland a fixed-size Electron window pins its
    // min and max size to the display it opens on, so an overlay created on the
    // laptop could never grow to cover a larger external monitor.
    const win=new BrowserWindow({width:rect.width,height:rect.height,title,frame:false,transparent:true,backgroundColor:'#00000000',resizable:kind==='controls'||kind==='panel'||kind==='picker',minWidth:16,minHeight:16,skipTaskbar:true,show:false,alwaysOnTop:true,
      webPreferences:{preload:this.preload,contextIsolation:true,nodeIntegration:false,sandbox:true}});
    win.surfaceKind=kind;
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',e=>e.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc,_p,cb)=>cb(false));
    // Keep the page title fixed so Hyprland rules keep matching.
    win.on('page-title-updated',e=>e.preventDefault());
    win.loadFile(path.join(__dirname,'ui',page),{query}).then(()=>{if(win.isDestroyed())return;if(kind==='controls'||kind==='frame')win.showInactive();else win.show();}).catch(()=>{});
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

  // startPending covers the moments before the recorder reports 'starting'.
  busy(){return !!(this.updating||this.startPending||this.extensionMutation||BUSY.has(this.recorder.state.phase)||this.recorder.state.job?.running);}

  /* Launcher bar */

  /* Record panel: the drop-down from the top bar icon */

  // Small JPEG of a screen region or output, as a data URL. Taken before the
  // panel opens so the panel never appears in its own thumbnails.
  async thumb(args){
    try{
      const {stdout}=await run('grim',[...args,'-t','jpeg','-q','70','-'],{timeout:1500,encoding:'buffer',maxBuffer:4*1024*1024});
      return stdout.length?`data:image/jpeg;base64,${stdout.toString('base64')}`:null;
    }catch{return null;}
  }

  async panelData(){
    const [ms,list]=await Promise.all([monitors(),clients()]);
    const visible=new Set(geometry.visibleWindows(list,ms).map(w=>w.address));
    const windows=list.filter(c=>c.mapped&&!c.hidden&&c.workspace&&c.workspace.id>0&&!/^(?:vid)?capture(?:-|$)/.test(c.class||'')&&c.size&&c.size[0]>=32&&c.size[1]>=32)
      .sort((a,b)=>(Number.isFinite(a.focusHistoryID)?a.focusHistoryID:1e6)-(Number.isFinite(b.focusHistoryID)?b.focusHistoryID:1e6))
      .slice(0,24)
      .map(c=>({address:c.address,title:c.title||c.class||'Window',app:c.class||'',workspace:c.workspace.name||String(c.workspace.id),visible:visible.has(c.address),x:c.at[0],y:c.at[1],width:c.size[0],height:c.size[1]}));
    const shots=await Promise.all([
      ...ms.map(m=>this.thumb(['-o',m.id,'-s',String(Math.min(1,320/(m.width*m.scale))*m.scale)])),
      ...windows.map(w=>w.visible?this.thumb(['-g',`${w.x},${w.y} ${w.width}x${w.height}`,'-s',String(Math.min(1,280/w.width))]):Promise.resolve(null)),
    ]);
    const nameOf=m=>m.label||m.id;
    const monitorsOut=ms.map((m,i)=>({id:m.id,name:nameOf(m),width:Math.round(m.width*m.scale),height:Math.round(m.height*m.scale),thumb:shots[i]}));
    windows.forEach((w,i)=>{w.thumb=shots[ms.length+i];});
    return {monitors:monitorsOut,windows,raw:ms};
  }

  // The bar icon, tray and `capture --panel` toggle the panel. A second request
  // while it is still opening cancels that open, so a quick second click closes.
  togglePanel(args={}){
    if(this.panelOpening){this.panelCancel=true;return this.panelOpening;}
    if(this.panel&&!this.panel.isDestroyed()){this.closePanel();return Promise.resolve();}
    // Old messages belong to earlier actions; a panel the user opens starts
    // clean. Internal reopens (a failed start or pick) keep the message.
    const s0=this.recorder.state;
    if(s0.error&&!BUSY.has(s0.phase))this.recorder.set({error:null});
    this.panelTab=null;
    return this.ensurePanel(args);
  }
  openPanel(args={}){return this.togglePanel(args);}

  // Internal reopen paths (after a pick, a failed start) never close it.
  ensurePanel(args=this.panelArgs||{}){
    if(this.panelOpening)return this.panelOpening;
    if(this.panel&&!this.panel.isDestroyed())return Promise.resolve();
    this.panelCancel=false;
    this.panelOpening=this._openPanel(args).finally(()=>{this.panelOpening=null;this.panelCancel=false;});
    return this.panelOpening;
  }

  // Closing the picker from here leaves no stale focus or main-window state.
  async dropPicker(){
    if(!this.picker)return;
    const restore=this.restoreMain,fromPanel=this.picker.origin==='panel';
    await this.closePicker();
    this.previousFocus=null;this.barOrigin=null;this.restoreMain=false;
    if(restore)this.showMain();
    if(fromPanel)this.restorePanelMain();
  }

  // Waits (briefly) until no picker overlay is still mapped, so thumbnails
  // never capture the dimmed overlay that just closed.
  async overlaysGone(){
    for(let i=0;i<8;i++){
      let list=[];try{list=await clients();}catch{return;}
      if(!list.some(c=>c.pid===process.pid&&String(c.title).startsWith(TITLES.picker(''))))return;
      await delay(40);
    }
  }

  async _openPanel({screen=null,x=null}={}){
    this.closeBar();await this.dropPicker();await this.overlaysGone();
    this.panelArgs={screen,x};
    // A take that is starting closes the panel at once; don't flash it.
    if(this.recorder.state.phase==='starting'||this.startPending)return;
    // While recording, the live view needs no thumbnails, and grabbing them
    // would compete with the encoder.
    const snap=this.busy()?{monitors:[],windows:[],raw:await monitors(),thin:true}:await this.panelData();
    if(this.panelCancel)return;
    let home=screen&&snap.raw.find(m=>m.id===screen);
    if(!home){let cursor=null;try{cursor=JSON.parse(await hypr(['cursorpos','-j']));}catch{}home=(cursor&&geometry.monitorAt(snap.raw,cursor.x,cursor.y))||snap.raw.find(m=>m.internal)||snap.raw[0];}
    if(!home)throw new Error('No display is available.');
    snap.here=home.id;this.panelSnapshot=snap;
    const rect=geometry.panelPlacement(home,PANEL,Number.isFinite(x)?x:null);
    this.panelRect=rect;this.panelWant=null;
    await this.rule('vidcapture-panel',TITLES.panel,`monitor=${lua(home.id)},size={${rect.width},${rect.height}}`);
    if(this.panelCancel)return;
    const win=this.window('panel',TITLES.panel,rect,'panel.html');this.panel=win;
    win.on('closed',()=>{if(this.panel===win){this.panel=null;this.syncLevel();}});
    win.webContents.once('did-finish-load',()=>this.syncLevel());
    // No close on blur: Hyprland focus follows the mouse here, so moving the
    // pointer toward the panel would dismiss it. Escape, the X, the bar icon
    // (a second click toggles) and Start all close it.
    win.once('ready-to-show',async()=>{
      try{
        win.address=await this.place(win,TITLES.panel,rect);
        if(this.panel!==win||win.isDestroyed())return;
        await this.focusAddress(win.address);
        if(this.panelWant)await this.resizePanel(this.panelWant);
        this.syncStage();
      }catch(e){console.error('panel placement',e);}
    });
    // Default to recording the screen the panel opened on, like Loom's full
    // screen. Done after the window exists, and never while a camera preview
    // runs, since choosing a target closes the camera.
    const s=this.recorder.state;
    if(!BUSY.has(s.phase)&&!s.job?.running&&!s.target&&!s.cameraPreview){
      this.panelDefault=this.recorder.chooseTarget(home.id).catch(()=>{}).finally(()=>{this.panelDefault=null;});
    }
  }

  // The camera bubble is another pinned window, and focus alone does not
  // restack pinned floats in Hyprland; move the panel to the top explicitly.
  // Repeated because the bubble can map a moment after the preview starts.
  async raisePanel(){
    for(const wait of [120,400,900]){
      await delay(wait);
      const p=this.panel;if(!p||p.isDestroyed()||!p.address||!/^0x[0-9a-f]+$/i.test(p.address))return;
      try{await dispatch(`hl.dsp.window.alter_zorder({mode="top",window="address:${p.address}"})`);}catch{}
      await this.focusAddress(p.address);
    }
  }

  restorePanelMain(){if(this.panelMainWasVisible){this.panelMainWasVisible=false;this.showMain();}}

  closePanel(){const p=this.panel;this.panel=null;if(p&&!p.isDestroyed())p.destroy();this.syncLevel();this.syncStage();}

  /* Getting ready: while the record panel is open with something chosen, a
     bright outline marks it and the camera bubble shows where it will sit, so
     the take looks the way it will before Start. */

  stageWanted(){
    const s=this.recorder.state;
    return !!(this.panel&&!this.panel.isDestroyed()&&!this.picker&&!this.counting&&!this.startPending&&s.target&&s.target.kind!=='camera'&&!this.busy()&&s.phase!=='selecting');
  }

  syncStage(){
    if(this.disposed)return;
    if(!this.stageWanted()){
      this.closeFrame();
      // A preview the panel opened goes away with it, unless a take is starting.
      if(this.autoPreview&&!this.startPending&&!this.busy()&&!(this.panel&&!this.panel.isDestroyed())){
        this.autoPreview=false;
        if(this.recorder.state.cameraPreview&&this.recorder.state.phase==='idle')this.recorder.previewCamera().catch(()=>{});
      }
      if(!(this.panel&&!this.panel.isDestroyed())){this.previewOff=false;this.previewTried=null;}
      return;
    }
    if(this.stageBusy){this.stageAgain=true;return;}
    this.stageBusy=this._syncStage().catch(e=>console.error('outline',e)).finally(()=>{this.stageBusy=null;if(this.stageAgain){this.stageAgain=false;this.syncStage();}});
  }

  async _syncStage(){
    const s=this.recorder.state,t=s.target;
    // One try per target and camera, so a camera that cannot open does not loop.
    const tryKey=[t.kind,t.address||t.monitor||t.label,s.settings.camera].join('|');
    if(s.settings.camera!=='none'&&!s.cameraPreview&&!this.previewOff&&this.previewTried!==tryKey){
      this.previewTried=tryKey;
      try{await this.recorder.previewCamera();this.autoPreview=true;this.raisePanel();}catch(e){console.error('camera preview',e.message);}
      if(!this.stageWanted())return;
    }
    let f=this.frame,m=f&&!f.isDestroyed()?f.monitor:null;
    const cx=t.x+t.width/2,cy=t.y+t.height/2;
    if(!m||cx<m.x||cy<m.y||cx>=m.x+m.width||cy>=m.y+m.height){
      const ms=await monitors();
      m=geometry.monitorAt(ms,cx,cy);
      if(!m||(this.only.length&&!this.only.includes(m.id))){this.closeFrame();return;}
      if(t.kind==='window'){
        // A window on a workspace that is not showing gets no outline.
        const mon=JSON.parse(await hypr(['monitors','-j'])).find(x=>x.name===m.id);
        const c=(await clients()).find(c=>c.address===t.address);
        if(!c||!mon||c.workspace?.id!==mon.activeWorkspace?.id){this.closeFrame();return;}
      }
      if(!this.stageWanted())return;
      this.closeFrame();
      f=await this.openFrame(m);
      if(!f)return;
    }
    const now=this.recorder.state.target;if(!now||f.isDestroyed())return;
    f.webContents.send('vc:frame',{kind:now.kind,x:now.x-m.x,y:now.y-m.y,width:now.width,height:now.height});
  }

  async openFrame(m){
    const rect={x:m.x,y:m.y,width:m.width,height:m.height};
    await this.rule('vidcapture-outline',TITLES.frame,`monitor=${lua(m.id)},size={${m.width},${m.height}},no_focus=true,no_initial_focus=true`);
    if(!this.stageWanted())return null;
    const win=this.window('frame',TITLES.frame,rect,'frame.html');
    win.monitor=m;this.frame=win;
    win.setIgnoreMouseEvents(true);win.setFocusable(false);
    win.on('closed',()=>{if(this.frame===win)this.frame=null;});
    await new Promise(r=>win.webContents.once('did-finish-load',r));
    if(win.isDestroyed()||this.frame!==win)return null;
    win.address=await this.place(win,TITLES.frame,rect);
    // The panel and camera bubble stay above the outline.
    this.raisePanel();
    return this.frame===win&&!win.isDestroyed()?win:null;
  }

  closeFrame(){const f=this.frame;this.frame=null;if(f&&!f.isDestroyed())f.destroy();}

  /* Microphone level for the panel */

  // Reads the chosen microphone only while the panel is open and nothing is
  // recording, so the user can see it works before a take.
  syncLevel(){
    const st=this.recorder.state,mic=st.settings?.microphone;
    const open=(this.panel&&!this.panel.isDestroyed())||(this.mainLevel&&this.mainVisible());
    // With live cleanup on, the meter reads the cleaned source that a take records.
    const clean=this.recorder.audioChain?.running()?'vidcapture_mic':null;
    const want=open&&mic&&mic!=='none'&&!this.busy()?(clean||mic):null;
    if(this.level&&this.level.mic===want)return;
    this.stopLevel();
    if(!want)return;
    const device=want==='default_input'?'@DEFAULT_SOURCE@':want;
    let child;
    try{child=spawn('parec',['--device',device,'--format=s16le','--rate=16000','--channels=1','--latency-msec=50','--client-name=VidCapture level','--stream-name=Microphone level'],{stdio:['ignore','pipe','ignore']});}
    catch{return;}
    const level={mic:want,child,scanner:peakScanner(),timer:null};this.level=level;
    child.on('error',()=>{if(this.level===level)this.stopLevel();});
    // The reader ended on its own: stop its timer too, so no level is sent for a
    // reader that is gone.
    child.on('exit',()=>{if(this.level===level)this.stopLevel();});
    child.stdout.on('data',buf=>{if(this.level===level)level.scanner.scan(buf);});
    level.timer=setInterval(()=>{
      // Peak over the last interval on a -60 to 0 dB scale.
      if(this.level===level)this.sendLevel(peakLevel(level.scanner.take()));
    },80);
  }

  stopLevel(){
    const l=this.level;if(!l)return;this.level=null;
    clearInterval(l.timer);try{l.child.kill('SIGTERM');}catch{}
    this.sendLevel(-1);
  }

  sendLevel(v){const p=this.panel;if(p&&!p.isDestroyed())p.webContents.send('vc:level',v);if(this.mainLevel||v<0)this.sendMain('capture:level',v);}

  // Requests are coalesced: the newest height wins, one Hyprland move at a time.
  async resizePanel(height){
    if(Number.isFinite(height))this.panelWant=Math.max(200,Math.ceil(height));
    if(this.panelResizing)return;
    this.panelResizing=true;
    try{
      while(true){
        const win=this.panel,r=this.panelRect,want=this.panelWant;
        if(!win||win.isDestroyed()||!win.address||!r||want==null)return;
        const ms=await monitors();const m=ms.find(m=>m.id===r.monitor);if(!m)return;
        const next=geometry.panelPlacement(m,{width:r.width,height:want},null);
        if(next.height!==r.height){
          this.panelRect={...r,height:next.height};
          await this.moveTo(win.address,this.panelRect);
          // Hyprland keeps a floating window centered while resizing it, so pin
          // the top edge again once the new size has applied.
          for(let i=0;i<5;i++){
            await delay(40);
            const c=(await clients()).find(c=>c.address===win.address);if(!c)return;
            if(c.at[0]===this.panelRect.x&&c.at[1]===this.panelRect.y)break;
            await dispatch(`hl.dsp.window.move({window="address:${win.address}",x=${this.panelRect.x},y=${this.panelRect.y}})`);
          }
        }
        if(this.panelWant===want)return;
      }
    }finally{this.panelResizing=false;}
  }

  // Thumbnails travel once, with the first state; later updates omit them.
  panelState(full=true){
    const s=this.recorder.snapshot(),snap=this.panelSnapshot||{monitors:[],windows:[]};
    const out={phase:s.phase,elapsed:s.elapsed,shortcuts:s.shortcuts||{},settings:s.settings,devices:{microphones:s.devices.microphones,cameras:s.devices.cameras},target:s.target,cameraPreview:!!s.cameraPreview,error:s.error,micCleanupError:s.micCleanupError||null,job:s.job?{running:!!s.job.running}:null,here:snap.here};
    // The panel page is rebuilt on every open, so the last choice per tab
    // lives here.
    const t=s.target;
    if(t){const tab=t.kind==='window'?'window':t.kind==='region'?'area':t.kind==='camera'?'camera':'screen';this.panelMemo={...this.panelMemo,[tab]:t};}
    out.memo=this.panelMemo||{};
    out.tab=this.panelTab||null;
    // Sizes in the panel are the saved file's pixels, as in the picker.
    if(t&&t.kind!=='monitor'&&t.kind!=='camera'){const m=geometry.monitorAt(snap.raw||[],t.x+t.width/2,t.y+t.height/2);if(m)out.targetSize=geometry.physicalSize(t,m.scale);}
    if(full){out.monitors=snap.monitors;out.windows=snap.windows;}
    return out;
  }

  // The default display choice made at open must land before the user's own.
  async settled(){if(this.panelDefault)await this.panelDefault;}

  async panelChoose(sel){
    const snap=this.panelSnapshot;if(!snap||!sel)throw new Error('Choose what to record.');
    await this.settled();
    const preview=this.recorder.state.cameraPreview;
    try{return await this.chooseFromPanel(snap,sel);}
    finally{
      // Choosing a target closes the camera; bring the preview back even when
      // the choice fails, and say so if it cannot come back.
      if(preview&&!this.recorder.state.cameraPreview&&this.recorder.state.settings.camera!=='none'){
        try{await this.recorder.previewCamera();this.raisePanel();}catch(e){this.recorder.set({error:e.message});}
      }
    }
  }

  /* Record page in the main window: the same sources as the panel */

  // Thumbnails of every display and open window, plus the chosen area.
  async mainSources(){
    if(this.busy())return {monitors:[],windows:[],memo:this.panelMemo||{}};
    const snap=await this.panelData();this.mainSnapshot=snap;
    const t=this.recorder.state.target;let area=null;
    if(t&&t.kind==='region')area=await this.thumb(['-g',`${t.x},${t.y} ${t.width}x${t.height}`,'-s',String(Math.min(1,480/Math.max(1,t.width)))]);
    const memo={...(this.panelMemo||{})};
    if(t)memo[t.kind==='window'?'window':t.kind==='region'?'area':t.kind==='camera'?'camera':'screen']=t;
    this.panelMemo=memo;
    return {monitors:snap.monitors,windows:snap.windows,area,memo};
  }

  async mainChoose(sel){
    const snap=this.mainSnapshot||{raw:await monitors(),windows:[]};
    if(!sel||typeof sel!=='object')throw new Error('Choose what to record.');
    const preview=this.recorder.state.cameraPreview;
    try{await this.chooseFromPanel(snap,sel,'main');return this.recorder.snapshot();}
    finally{
      if(preview&&!this.recorder.state.cameraPreview&&this.recorder.state.settings.camera!=='none'){
        try{await this.recorder.previewCamera();}catch(e){this.recorder.set({error:e.message});}
      }
    }
  }

  // The main window's Record page shows a microphone meter while it is open.
  watchMainLevel(on){this.mainLevel=!!on;this.syncLevel();}

  async chooseFromPanel(snap,sel,origin='panel'){
    if(sel.kind==='monitor'){
      const m=snap.raw.find(m=>m.id===sel.id);if(!m)throw new Error('That display is no longer connected.');
      await this.recorder.chooseTarget(m.id);
    }else if(sel.kind==='window'){
      const w=snap.windows.find(w=>w.address===sel.address);if(!w)throw new Error('That window is no longer open.');
      if(!w.visible){
        // Bring its workspace forward so the window can be recorded. The panel
        // is pinned, so it stays in view across the workspace change.
        await dispatch(`hl.dsp.focus({window="address:${w.address}"})`);await delay(250);
        w.visible=true;
        if(origin==='main')this.showMain();
        else if(this.panel&&!this.panel.isDestroyed()&&this.panel.address)await this.focusAddress(this.panel.address);
      }
      await this.recorder.chooseTarget(`window:${w.address}`);
    }else if(sel.kind==='camera'){
      // Camera only. Choosing a camera here also sets the camera setting.
      if(sel.device!=null&&sel.device!==this.recorder.state.settings.camera){
        if(!this.recorder.state.devices.cameras.some(c=>c.id===sel.device))throw new Error('That camera is no longer connected.');
        await this.recorder.saveSettings({camera:sel.device});
      }
      await this.recorder.chooseTarget('camera');
    }else if(sel.kind==='region'){
      // Switching back to the Area tab restores the area drawn earlier.
      const r=[sel.x,sel.y,sel.width,sel.height].map(Number);
      if(!r.every(Number.isFinite)||r[2]<1||r[3]<1)throw new Error('Draw the area again.');
      await this.recorder.chooseTarget(geometry.regionId({x:r[0],y:r[1],width:r[2],height:r[3]}));
    }else throw new Error('Choose what to record.');
    return origin==='main'?null:this.panelState(false);
  }

  // A changed setting makes an old message about the previous setup stale.
  async panelSave(partial){
    if(!partial||typeof partial!=='object')throw new Error('Invalid settings.');
    await this.recorder.saveSettings(partial);
    await this.onSettings();
    if(this.recorder.state.error&&!BUSY.has(this.recorder.state.phase))this.recorder.set({error:null});
    return this.panelState(false);
  }

  // Try again after a microphone cleanup failure: the same sync a settings change runs.
  async panelRetryMic(){
    if(this.busy())throw new Error('Stop and save this recording first.');
    await this.onSettings();
    return this.panelState(false);
  }

  async panelPick(mode){
    // Refuse while busy, before closing, so the panel can show why.
    if(this.busy())throw new Error(this.recorder.state.job?.running?'Wait for processing to finish, or cancel it first.':'Stop and save this recording first.');
    await this.settled();
    // Coming back from the picker, even after Escape, lands on this tab.
    this.panelTab=mode==='window'?'window':'area';
    this.panelMainWasVisible=this.mainVisible();
    this.closePanel();
    await this.openPicker(mode,{intent:'select',origin:'panel'});
  }

  async panelStart(){
    if(this.busy())throw new Error('A recording is already starting.');
    await this.settled();
    // A browser settings command may have begun while the default source settled.
    if(this.busy())throw new Error('Wait for the current recording action to finish.');
    // Problems the recorder would refuse are reported here, without the panel
    // closing and reopening.
    const st=this.recorder.state,t=st.target;
    if(!t)throw new Error('Choose what to record.');
    if(t.kind==='window'&&t.available===false)throw new Error('That window was closed. Choose another.');
    if(t.kind==='camera'&&st.settings.camera==='none')throw new Error('Choose a camera to record.');
    if(t.kind!=='camera'&&st.settings.camera!=='none'&&(t.width<90||t.height<90)){
      // Say the minimum in the saved file's pixels, as the panel shows sizes.
      const m=geometry.monitorAt(this.panelSnapshot?.raw||[],t.x+t.width/2,t.y+t.height/2);
      const min=geometry.physicalSize({width:90,height:90},m?.scale||1).width;
      throw new Error(`Choose an area at least ${min} × ${min} to fit the camera.`);
    }
    // The main window must never end up in the take.
    const mainWasVisible=this.mainVisible();
    this.startPending=true;
    this.closePanel();this.hideMain();
    if(!(await this.countdown())){
      this.startPending=false;if(mainWasVisible)this.showMain();await this.ensurePanel(this.panelArgs);return;
    }
    try{await this.recorder.start();}
    catch(e){this.startPending=false;this.recorder.set({error:e.message});if(mainWasVisible)this.showMain();await this.ensurePanel(this.panelArgs);}
    finally{this.startPending=false;}
  }

  /* Takes started outside the panel: shortcuts and Restart */

  // Counts down, then records. A canceled countdown or a failed start brings
  // the record panel back so the user can see why.
  async startTake(){
    if(this.busy())return false;
    const mainWasVisible=this.mainVisible();
    this.startPending=true;
    this.closePanel();this.hideMain();
    try{
      if(!(await this.countdown())){this.startPending=false;if(mainWasVisible)this.showMain();await this.ensurePanel(this.panelArgs);return false;}
      await this.recorder.start();return true;
    }catch(e){this.startPending=false;this.recorder.set({error:e.message});if(mainWasVisible)this.showMain();await this.ensurePanel(this.panelArgs);return false;}
    finally{this.startPending=false;}
  }

  // Start or stop from the shortcut. A second press during the countdown cancels it.
  async toggleRecording(){
    const s=this.recorder.state;
    if(this.counting){this.closeCountdown();return;}
    if(LIVE.has(s.phase)){
      this.closeControls();
      return this.recorder.stop().catch(e=>this.recorder.set({error:e.message})).finally(()=>this.showMain());
    }
    if(this.busy()||this.retaking){
      if(s.job?.running){this.recorder.set({error:'Wait for processing to finish, or cancel it first.'});await this.ensurePanel(this.panelArgs);}
      return;
    }
    await this.settled();
    // Nothing chosen yet: record the display under the pointer, like Full screen in the panel.
    if(!this.recorder.state.target){
      try{
        const ms=await monitors();let cursor=null;try{cursor=JSON.parse(await hypr(['cursorpos','-j']));}catch{}
        const m=(cursor&&geometry.monitorAt(ms,cursor.x,cursor.y))||ms.find(m=>m.internal)||ms[0];
        if(m)await this.recorder.chooseTarget(m.id);
      }catch(e){this.recorder.set({error:e.message});await this.ensurePanel(this.panelArgs);return;}
    }
    return this.startTake();
  }

  async togglePause(){
    if(!LIVE.has(this.recorder.state.phase))return;
    return this.recorder.pause().catch(e=>this.recorder.set({error:e.message}));
  }

  // Throws the current take away (its file is deleted) and records again
  // with the same choices, after the countdown.
  async restartTake(){
    if(this.retaking)return;
    this.retaking=true;
    try{this.closeControls();await this.recorder.discard();}
    catch(e){this.retaking=false;this.recorder.set({error:e.message});throw e;}
    this.retaking=false;
    await this.startTake();
  }

  // Throws the current take away and goes back to the record panel.
  async discardTake(){
    if(this.retaking)return;
    this.retaking=true;
    try{this.closeControls();await this.recorder.discard();}
    catch(e){this.recorder.set({error:e.message});throw e;}
    finally{this.retaking=false;}
    await this.ensurePanel(this.panelArgs);
  }

  /* Countdown */

  // 3, 2, 1 over the middle of what is about to be recorded. Resolves true to
  // record, false when canceled. The overlay is gone before recording starts,
  // so it never appears in the take.
  async countdown(){
    const seconds=Number(this.recorder.state.settings.countdown)||0;
    const t=this.recorder.state.target;
    if(!seconds||!t)return true;
    this.closeCountdown(false);
    const ms=await monitors().catch(()=>[]);
    // A camera-only take counts down in the middle of the laptop display.
    const box=t.kind==='camera'?null:t;
    const m=(box&&geometry.monitorAt(ms,box.x+box.width/2,box.y+box.height/2))||ms.find(m=>m.internal)||ms[0];
    if(!m)return true;
    const cx=Math.round(box?box.x+box.width/2:m.x+m.width/2),cy=Math.round(box?box.y+box.height/2:m.y+m.height/2);
    const rect={width:COUNT.width,height:COUNT.height,
      x:Math.max(m.x,Math.min(m.x+m.width-COUNT.width,cx-COUNT.width/2)),
      y:Math.max(m.y,Math.min(m.y+m.height-COUNT.height,cy-COUNT.height/2))};
    rect.x=Math.round(rect.x);rect.y=Math.round(rect.y);
    await this.rule('vidcapture-countdown',TITLES.countdown,`monitor=${lua(m.id)},size={${rect.width},${rect.height}}`);
    return new Promise(resolve=>{
      const win=this.window('countdown',TITLES.countdown,rect,'countdown.html',{n:String(seconds)});
      const done=ok=>{if(this.counting!==state)return;this.counting=null;clearInterval(state.timer);resolve(ok);};
      const state={win,done,left:seconds,timer:null};
      this.counting=state;
      win.on('closed',()=>done(false));
      win.once('ready-to-show',async()=>{
        try{win.address=await this.place(win,TITLES.countdown,rect);if(win.address)await this.focusAddress(win.address);}catch{}
      });
      state.timer=setInterval(async()=>{
        if(this.counting!==state)return;
        state.left--;
        if(state.left>0){if(!win.isDestroyed())win.webContents.send('vc:count',state.left);return;}
        clearInterval(state.timer);
        // Wait until the overlay is unmapped so the first frame is clean.
        this.counting=null;
        if(!win.isDestroyed())win.destroy();
        for(let i=0;i<10;i++){
          let list=[];try{list=await clients();}catch{break;}
          if(!list.some(c=>c.pid===process.pid&&c.title===TITLES.countdown))break;
          await delay(30);
        }
        resolve(true);
      },1000);
    });
  }

  closeCountdown(){const c=this.counting;if(!c)return;c.done(false);if(!c.win.isDestroyed())c.win.destroy();}

  // The top bar icon's drop-down replaces the old launcher bar.
  openBar(){return this.openPanel();}

  closeBar(){const b=this.bar;this.bar=null;if(b&&!b.isDestroyed())b.destroy();}

  async dismissBar(){
    const origin=this.barOrigin;this.closeBar();
    if(origin==='main'||this.restoreMain)this.showMain();else{await this.focusAddress(this.previousFocus);}
    this.previousFocus=null;this.restoreMain=false;
  }

  async activeAddress(){
    try{const a=JSON.parse(await hypr(['activewindow','-j']));return a?.address&&!/^(?:vid)?capture(?:-|$)/.test(a.class||'')?a.address:null;}catch{return null;}
  }

  /* Picker overlays */

  async openPicker(mode,{intent='record',origin='bar'}={}){
    if(!['window','area','display'].includes(mode))throw new Error('Unknown picker mode.');
    if(this.busy())throw new Error('Stop and save this recording first.');
    if(this.picker){this.setMode(mode);return;}
    if(!this.previousFocus)this.previousFocus=await this.activeAddress();
    if(origin!=='bar')this.barOrigin=origin;
    // The main window would sit under the dimmed overlay; bring it back on cancel.
    if(origin==='main'||(origin!=='panel'&&this.mainVisible()))this.restoreMain=true;
    this.closeBar();this.hideMain();this.closeFrame();
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
    this.syncStage();
    return had;
  }

  async cancelPicker(){
    const p=this.picker;if(!p)return;
    const origin=p.origin;await this.closePicker();
    if(origin==='panel'){this.previousFocus=null;this.barOrigin=null;this.restoreMain=false;this.restorePanelMain();await this.ensurePanel(this.panelArgs);return;}
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
      if(intent==='record'){
        this.hideMain();
        if(!(await this.countdown())){if(origin==='main'||restore)this.showMain();return;}
        await this.recorder.start();
      }
      else if(origin==='panel'){this.restorePanelMain();await this.ensurePanel(this.panelArgs);}
      else if(origin==='main'||restore)this.showMain();
    }catch(e){this.recorder.set({error:e.message});if(origin==='panel'){this.restorePanelMain();await this.ensurePanel(this.panelArgs);}else this.showMain();}
  }

  /* Recording controls */

  update(state){
    // A panel opened during a take has no thumbnails to choose from; once the
    // take ends it closes (the main window shows the result).
    if(this.panel&&!this.panel.isDestroyed()&&this.panelSnapshot?.thin&&!BUSY.has(state.phase))this.closePanel();
    if(this.panel&&!this.panel.isDestroyed())this.panel.webContents.send('vc:panel',this.panelState(false));
    this.syncLevel();
    this.syncStage();
    this.syncMeter(state);
    if(LIVE.has(state.phase)){
      if(!this.controls&&!this.controlsBusy&&!this.noControls)this.controlsBusy=this.openControls(state).catch(e=>console.error('controls',e)).finally(()=>{this.controlsBusy=null;});
      else if(this.controls&&!this.controls.isDestroyed())this.controls.webContents.send('vc:state',{phase:state.phase,elapsed:state.elapsed,shortcuts:state.shortcuts||{}});
    }else{
      this.noControls=false;this.closeControls();
      if(BUSY.has(state.phase)){this.closeBar();if(this.picker)this.closePicker();if(state.phase==='starting')this.closePanel();}
    }
  }

  async openControls(state){
    const target=state.target;if(!target)return;
    const ms=(await monitors()).filter(m=>!this.only.length||this.only.includes(m.id));
    const spot=geometry.pillPlacement({target,monitors:ms,pill:PILL,dot:DOT,cameraCorner:state.settings?.cameraCorner});
    if(!LIVE.has(this.recorder.state.phase))return;
    // With no other display free, the controls would sit inside a full-screen
    // take. When the VidCapture top bar icon is installed it already shows the
    // timer and opens Pause and Stop, so leave the screen clean.
    if(spot.collapsed&&await this.barIcon()){this.noControls=true;return;}
    // The rule also gives the spot (relative to its monitor), so the controls
    // appear there from the first frame. Without it Hyprland first shows them
    // centered on the monitor, inside an area being recorded, until place() moves them.
    const home=ms.find(m=>m.id===spot.monitor);
    const dx=home?spot.x-home.x:-1,dy=home?spot.y-home.y:-1;
    const at=home&&Number.isInteger(dx)&&Number.isInteger(dy)&&dx>=0&&dy>=0&&dx+spot.width<=home.width&&dy+spot.height<=home.height?`,move={${lua(dx)},${lua(dy)}}`:'';
    await this.rule('vidcapture-controls',TITLES.controls,`monitor=${lua(spot.monitor)},size={${spot.width},${spot.height}},no_initial_focus=true${at}`);
    const win=this.window('controls',TITLES.controls,spot,'controls.html',{collapsed:spot.collapsed?'1':'0'});
    win.spot=spot;this.controls=win;
    win.on('closed',()=>{if(this.controls===win){this.controls=null;this.takeMeter.stop();}});
    await new Promise(r=>win.once('ready-to-show',r));
    win.address=await this.place(win,TITLES.controls,spot);
    if(!win.isDestroyed())win.webContents.send('vc:state',{phase:this.recorder.state.phase,elapsed:this.recorder.snapshot().elapsed,shortcuts:this.recorder.state.shortcuts||{}});
    if(!LIVE.has(this.recorder.state.phase))this.closeControls();
    else this.syncMeter();
  }

  // Whether the Omarchy bar shows a VidCapture icon (a *.vidcapture widget).
  async barIcon(){
    const now=Date.now();
    if(this.barIconCache&&now-this.barIconCache.at<10000)return this.barIconCache.on;
    let on=false;
    try{
      const file=path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'omarchy','shell.json');
      on=/"id"\s*:\s*"[A-Za-z0-9_-]+\.vidcapture"/.test(await fs.readFile(file,'utf8'));
    }catch{}
    this.barIconCache={at:now,on};
    return on;
  }

  closeControls(){const c=this.controls;this.controls=null;this.takeMeter.stop();if(c&&!c.isDestroyed())c.destroy();}

  // Points the indicator at this take: the recorder's process (whose own PipeWire stream
  // it checks) and the source the take was started on. Anything else stops it.
  syncMeter(state=this.recorder.state){
    const c=this.controls,child=this.recorder.child;
    if(!c||c.isDestroyed()||!LIVE.has(state.phase)||!child?.pid){this.takeMeter.stop();return;}
    this.takeMeter.sync({pid:child.pid,phase:state.phase,expect:this.recorder.takeAudio?.micSource||null,micNone:state.settings?.microphone==='none'});
  }
  sendMic(m){const c=this.controls;if(c&&!c.isDestroyed())c.webContents.send('vc:mic',m);}

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
      countdownCancel:[['countdown'],()=>this.closeCountdown()],
      controlsState:[['controls'],()=>{const s=this.recorder.snapshot();return {phase:s.phase,elapsed:s.elapsed,shortcuts:s.shortcuts||{},collapsed:!!this.controls?.spot?.collapsed,mic:this.takeMeter.snapshot()};}],
      restart:[['controls'],()=>this.restartTake()],
      discard:[['controls'],()=>this.discardTake()],
      pause:[['controls'],()=>this.recorder.pause()],
      stop:[['controls'],()=>{this.closeControls();return this.recorder.stop().catch(e=>this.recorder.set({error:e.message})).finally(()=>this.showMain());}],
      expand:[['controls'],(_w,on)=>this.setExpanded(!!on)],
      panelState:[['panel'],()=>this.panelState()],
      panelSave:[['panel'],(_w,partial)=>this.panelSave(partial)],
      panelRetryMic:[['panel'],()=>this.panelRetryMic()],
      panelChoose:[['panel'],(_w,sel)=>this.panelChoose(sel)],
      panelPick:[['panel'],(_w,mode)=>{if(!['window','area'].includes(mode))throw new Error('Unknown picker mode.');return this.panelPick(mode);}],
      panelPreview:[['panel'],async()=>{await this.recorder.previewCamera();this.previewOff=!this.recorder.state.cameraPreview;this.autoPreview=false;await this.raisePanel();return this.panelState(false);}],
      panelStart:[['panel'],()=>this.panelStart()],
      panelPause:[['panel'],()=>this.recorder.pause()],
      panelStop:[['panel'],()=>{this.closePanel();return this.recorder.stop().catch(e=>this.recorder.set({error:e.message})).finally(()=>this.showMain());}],
      panelRestart:[['panel'],()=>this.restartTake()],
      panelDiscard:[['panel'],()=>this.discardTake()],
      panelMain:[['panel'],()=>{this.closePanel();this.showMain();}],
      panelClose:[['panel'],()=>this.closePanel()],
      panelResize:[['panel'],(_w,h)=>this.resizePanel(Number(h))],
      panelRefresh:[['panel'],async()=>{await this.recorder.refreshDevices();return this.panelState(false);}],
    };
    for(const [name,[kinds,fn]] of Object.entries(handlers))ipcMain.handle(`vc:${name}`,async(event,...args)=>{const win=owned(event,kinds);return fn(win,...args);});
  }

  dispose(){this.disposed=true;this.closeFrame();this.closeCountdown();this.closePanel();this.stopLevel();this.closeBar();this.closePicker();this.closeControls();this.takeMeter.stop();
    // Resolves once the indicator's level readers have really exited.
    return this.takeMeter.drain?.();}
}

module.exports={Surfaces,BAR,PILL,DOT,PANEL,TITLES};
