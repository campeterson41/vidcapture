const {app,BrowserWindow,ipcMain,Tray,Menu,nativeImage,dialog,shell,powerSaveBlocker,protocol,clipboard} = require('electron');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const {Readable}=require('node:stream');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
const {Recorder,ACTIVE}=require('./recorder.cjs');
const {MediaTools}=require('./media.cjs');
const {Publisher,ORIGIN}=require('./publisher.cjs');
const {Surfaces}=require('./surfaces.cjs');
protocol.registerSchemesAsPrivileged([{scheme:'capture-media',privileges:{standard:true,secure:true,stream:true,supportFetchAPI:true}}]);
app.setName('Capture');
app.setPath('userData',path.join(app.getPath('appData'),'capture'));
const locked=app.requestSingleInstanceLock();
if(!locked){app.quit();}else{
  let win,tray,recorder,media,publisher,surfaces,allowQuit=false,closing=false,inhibit=null;
  const show=()=>{if(win){win.show();if(win.isMinimized())win.restore();win.focus();}};
  const wantsPicker=argv=>argv.includes('--pick');
  // `capture --pick` opens the launcher bar, so a key binding can start a take.
  app.on('second-instance',(_event,argv)=>{if(wantsPicker(argv)&&surfaces)surfaces.openBar().catch(e=>{console.error(e);show();});else show();});
  async function requestClose(){
    if(closing)return;
    closing=true;
    try{
      if(win && !win.isDestroyed())await win.webContents.executeJavaScript('window.captureFlushEdits?.()');
      if(recorder.state.job?.running){
        const {response}=await dialog.showMessageBox(win,{type:'question',buttons:['Keep processing','Cancel and quit'],defaultId:0,cancelId:0,message:'Your recording is still being processed.'});
        if(response!==1)return;publisher?.cancel();await media.cancelJob();if(media.task)await media.task;
      }
      if(ACTIVE.has(recorder.state.phase)){
        if(!['recording','paused'].includes(recorder.state.phase)){show();return;}
        const {response}=await dialog.showMessageBox(win,{type:'question',buttons:['Keep recording','Stop, save, and quit'],defaultId:0,cancelId:0,message:'A recording is in progress.'});
        if(response!==1)return;
        await recorder.stop();
      }
      surfaces?.dispose();media?.dispose();await recorder.dispose();allowQuit=true;app.quit();
    }catch(e){show();await dialog.showMessageBox(win,{type:'error',message:e.message});}finally{closing=false;}
  }
  app.on('before-quit',e=>{if(!allowQuit){e.preventDefault();requestClose();}});
  app.whenReady().then(async()=>{
    // Prefer the built-in display, then the focused display on desktop computers.
    let laptop;
    try{
      const {stdout}=await run('hyprctl',['monitors','-j']);
      const monitors=JSON.parse(stdout);laptop=monitors.find(m=>/^eDP|^LVDS/.test(m.name))||monitors.find(m=>m.focused)||monitors[0];
      if(!laptop)throw new Error('No active Hyprland display is available.');
    }catch(e){throw new Error(`VidCapture could not find a display: ${e.message}`);}
    recorder=new Recorder({dataDir:process.env.CAPTURE_TEST_DATA_DIR,outputDir:process.env.CAPTURE_TEST_OUTPUT_DIR,beforePick:()=>win.hide(),afterPick:show});
    await recorder.init();
    media=new MediaTools(recorder);publisher=new Publisher(recorder,media);await publisher.init();
    protocol.handle('capture-media',async request=>{
      try{
        const url=new URL(request.url);if(url.hostname!=='recording')return new Response('',{status:404});
        const name=decodeURIComponent(url.pathname.slice(1));
        if(path.basename(name)!==name)return new Response('',{status:403});
        const file=await recorder.allowedFile(path.join(recorder.outputDir,name));const stat=await fsp.stat(file);
        let start=0,end=stat.size-1,status=200;
        const range=request.headers.get('range');
        if(range){const m=range.match(/^bytes=(\d+)-(\d*)$/);if(!m)return new Response('',{status:416});start=+m[1];if(m[2])end=Math.min(+m[2],end);status=206;}
        if(start>end||start>=stat.size)return new Response('',{status:416});
        const headers={'Content-Type':file.endsWith('.mp4')?'video/mp4':'video/x-matroska','Accept-Ranges':'bytes','Content-Length':String(end-start+1),'Cache-Control':'no-store'};
        if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
        return new Response(request.method==='HEAD'?null:Readable.toWeb(fs.createReadStream(file,{start,end})),{status,headers});
      }catch{return new Response('Recording unavailable',{status:404});}
    });
    win=new BrowserWindow({width:820,height:650,minWidth:390,minHeight:560,title:'VidCapture',frame:false,backgroundColor:'#1a1917',show:false,icon:path.join(__dirname,'ui/icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    surfaces=new Surfaces({recorder,showMain:show,hideMain:()=>{if(win&&!win.isDestroyed())win.hide();},mainVisible:()=>!!win&&!win.isDestroyed()&&win.isVisible()});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',(event,url)=>{if(url!==win.webContents.getURL())event.preventDefault();});
    win.webContents.session.setPermissionRequestHandler((_wc,_p,callback)=>callback(false));
    win.on('focus',()=>{if(!ACTIVE.has(recorder.state.phase))recorder.refreshDevices().catch(e=>recorder.set({error:e.message}));});
    win.on('close',event=>{if(!allowQuit){event.preventDefault();requestClose();}});
    const actions={
      getState:()=>recorder.snapshot(),listWindows:()=>recorder.listWindows(),refreshDevices:()=>recorder.refreshDevices(),saveSettings:s=>recorder.saveSettings(s),
      chooseTarget:id=>recorder.chooseTarget(id),start:async()=>{win.hide();try{return await recorder.start();}catch(e){show();throw e;}},pause:()=>recorder.pause(),stop:()=>recorder.stop(),previewCamera:()=>recorder.previewCamera(),
      getMedia:file=>media.getMedia(file),getWaveform:file=>media.getWaveform(file),saveEdits:(file,keep)=>media.saveEdits(file,keep),exportEdit:(file,keep)=>media.exportEdit(file,keep),enhanceAudio:file=>media.enhanceAudio(file),enhanceAudioFast:file=>media.enhanceAudioFast(file),enhanceAudioQuick:(file,options)=>media.enhanceAudioQuick(file,options),cancelJob:()=>{publisher.cancel();return media.cancelJob();},
      publishVideo:(file,title,keep)=>publisher.publish(file,title,keep),
      openLibrary:async()=>shell.openExternal(await publisher.libraryURL()),
      copyShareCard:async()=>{const card=await publisher.card();clipboard.write(card);if(!clipboard.availableFormats().includes('text/html'))throw new Error('The video card could not be copied. Try again.');return true;},
      copyShareLink:async()=>{const url=recorder.state.share?.url;if(!url?.startsWith(publisher.origin+'/v/'))throw new Error('No share link is ready.');await clipboard.writeText(url);return true;},
      openShareLink:async()=>{const url=recorder.state.share?.url;if(!url?.startsWith(publisher.origin+'/v/'))throw new Error('No share link is ready.');await shell.openExternal(url);},
      openFile:async file=>{const p=await recorder.allowedFile(file);const error=await shell.openPath(p);if(error)throw new Error(error);},
      openFolder:async()=>{const error=await shell.openPath(recorder.outputDir);if(error)throw new Error(error);},
      openBar:()=>surfaces.openBar({origin:'main'}),pickOnScreen:mode=>surfaces.openPicker(mode,{intent:'select',origin:'main'}),
      minimize:()=>win.minimize(),close:()=>requestClose()
    };
    for(const [name,handler] of Object.entries(actions))ipcMain.handle(`capture:${name}`,async(event,...args)=>{
      if(event.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame)throw new Error('Untrusted app frame.');
      return handler(...args);
    });
    function update(state){
      if(!win.isDestroyed())win.webContents.send('capture:state',state);
      surfaces?.update(state);
      const active=['starting','recording','paused','stopping'].includes(state.phase);
      if(active&&inhibit===null)inhibit=powerSaveBlocker.start('prevent-display-sleep');
      if(!active&&inhibit!==null){powerSaveBlocker.stop(inhibit);inhibit=null;}
      if(tray){
        tray.setToolTip(active?`VidCapture: ${state.phase} (${Math.floor(state.elapsed/60)}:${String(Math.floor(state.elapsed%60)).padStart(2,'0')})`:'VidCapture');
        tray.setContextMenu(Menu.buildFromTemplate([
          {label:'Open VidCapture',click:show},
          {label:'New recording',enabled:!active&&!state.job?.running,click:()=>surfaces.openBar().catch(e=>recorder.set({error:e.message}))},
          {label:state.phase==='paused'?'Resume recording':'Pause recording',enabled:['recording','paused'].includes(state.phase),click:()=>recorder.pause().catch(e=>recorder.set({error:e.message}))},
          {label:'Stop and save',enabled:['recording','paused'].includes(state.phase),click:()=>{recorder.stop().catch(e=>recorder.set({error:e.message})).finally(show);}},
          {type:'separator'},{label:'Quit VidCapture',click:requestClose}
        ]));
      }
    }
    const icon=nativeImage.createFromPath(path.join(__dirname,'ui/icon.png'));
    tray=new Tray(icon.resize({width:24,height:24}));tray.on('click',show);
    recorder.on('state',update);
    await win.loadFile(path.join(__dirname,'ui/index.html'));
    update(recorder.snapshot());
    if(wantsPicker(process.argv))surfaces.openBar().catch(e=>{console.error(e);show();});else show();
  }).catch(e=>{console.error(e);dialog.showErrorBox('Capture could not open',e.message);allowQuit=true;app.quit();});
}
